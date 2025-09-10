/**
 * Trello → AdPiler (API path)
 * Flow:
 *  1) POST /campaigns/{campaignId}/social-ads  (requires: network, type)
 *  2) POST /social-ads/{adId}/slides           (multipart)
 *
 * CSV headers expected:
 *  - "Trello Client Name"
 *  - "Adpiler Client ID"
 *  - "Adpiler Folder ID"
 *  - "Adpiler Campaign ID"  ← used as {campaign}
 *
 * ENV (Render):
 *  - ADPILER_UPLOAD_MODE=api
 *  - ADPILER_API_BASE=https://platform.adpiler.com/api   (or ADPILER_BASE_URL)
 *  - ADPILER_API_KEY=...   (Bearer)
 *  - CLIENT_CSV_URL=https://.../pub?output=csv
 *  - TRELLO_API_KEY=...
 *  - TRELLO_TOKEN=...
 *  - DEFAULT_CLIENT_ID=69144        (optional fallback)
 *  - DEFAULT_PROJECT_ID=445479      (optional fallback → campaign)
 *  - ADPILER_DEFAULT_NETWORK=facebook   (fallback if not on card)
 *  - ADPILER_DEFAULT_TYPE=single_image  (fallback if not on card)
 */

const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');

// ---------- ENV ----------
const {
  ADPILER_API_KEY,
  CLIENT_CSV_URL,
  TRELLO_API_KEY,
  TRELLO_TOKEN,
  DEFAULT_CLIENT_ID = '',
  DEFAULT_PROJECT_ID = '',
  ADPILER_DEFAULT_NETWORK = '',
  ADPILER_DEFAULT_TYPE = '',
} = process.env;

// Accept either ADPILER_API_BASE or ADPILER_BASE_URL
const _API_BASE = (process.env.ADPILER_API_BASE || process.env.ADPILER_BASE_URL || '').trim();

function assertEnv() {
  const miss = [];
  if (!_API_BASE) miss.push('ADPILER_API_BASE (or ADPILER_BASE_URL)');
  if (!ADPILER_API_KEY) miss.push('ADPILER_API_KEY');
  if (!TRELLO_API_KEY) miss.push('TRELLO_API_KEY');
  if (!TRELLO_TOKEN) miss.push('TRELLO_TOKEN');
  if (!CLIENT_CSV_URL && !DEFAULT_CLIENT_ID) miss.push('CLIENT_CSV_URL (or set DEFAULT_CLIENT_ID)');
  if (miss.length) throw new Error(`Missing env vars: ${miss.join(', ')}`);
}

const API = (p) => `${_API_BASE.replace(/\/+$/,'')}/${p.replace(/^\/+/, '')}`;
const n = (s) => (s || '').toLowerCase().trim();

// ---------- CSV MAPPING ----------
async function getClientMapping(cardName /*, listName? */) {
  const fallback = {
    clientId: String(DEFAULT_CLIENT_ID || '').trim(),
    campaignId: String(DEFAULT_PROJECT_ID || '').trim(),
    folderId: '',
  };

  if (!CLIENT_CSV_URL) {
    if (fallback.clientId) {
      return { clientId: fallback.clientId, projectId: fallback.campaignId, folderId: '', campaignId: fallback.campaignId };
    }
    throw new Error('CLIENT_CSV_URL not set and no DEFAULT_CLIENT_ID provided');
  }

  const res = await fetch(CLIENT_CSV_URL);
  if (!res.ok) throw new Error(`Mapping CSV fetch failed (${res.status})`);
  const rows = await csv().fromString(await res.text());

  const row = rows.find(r => n(cardName).includes(n(r['Trello Client Name'])));

  if (row) {
    const clientId   = String(row['Adpiler Client ID'] || '').trim();
    const folderId   = String(row['Adpiler Folder ID'] || '').trim();
    const campaignId = String(row['Adpiler Campaign ID'] || '').trim();
    if (clientId) return { clientId, projectId: campaignId, folderId, campaignId };

    if (fallback.clientId) {
      console.warn(`CSV row for "${cardName}" missing Adpiler Client ID; using DEFAULT_CLIENT_ID.`);
      return { clientId: fallback.clientId, projectId: fallback.campaignId, folderId: '', campaignId: fallback.campaignId };
    }
    throw new Error(`Mapping row missing Adpiler Client ID for "${row['Trello Client Name'] || cardName}"`);
  }

  if (fallback.clientId) {
    console.warn(`No CSV match for "${cardName}". Falling back to DEFAULT_CLIENT_ID.`);
    return { clientId: fallback.clientId, projectId: fallback.campaignId, folderId: '', campaignId: fallback.campaignId };
  }

  throw new Error(`No client mapping found for card "${cardName}"`);
}

// ---------- TRELLO HELPERS ----------
async function downloadAttachmentBuffer(attachmentId) {
  const auth = `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const url = `https://api.trello.com/1/attachments/${attachmentId}/download?${auth}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Attachment ${attachmentId} download failed (${r.status})`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

function extractAdMetaFromCard(card) {
  const desc = card.desc || '';
  const grab = (label) => {
    const m = desc.match(new RegExp(`${label}:\\s*(.+)`, 'i'));
    return m ? m[1].trim() : '';
  };

  // Optional explicit hints in the card description:
  // Network: facebook
  // Type: single_image
  const networkFromDesc = grab('Network');
  const typeFromDesc    = grab('Type');

  return {
    headline:    grab('Headline'),
    description: grab('Description'),
    cta:         grab('CTA'),
    url:         grab('URL'),
    networkHint: networkFromDesc,
    typeHint:    typeFromDesc
  };
}

function inferNetwork({ card, meta }) {
  const text = `${card.name} ${card.desc} ${(card.labels || []).map(l => l.name).join(' ')}`.toLowerCase();
  const map = [
    { k: ['facebook','fb','meta '], v: 'facebook' },
    { k: ['instagram','ig'], v: 'instagram' },
    { k: ['tiktok'], v: 'tiktok' },
    { k: ['linkedin','li '], v: 'linkedin' },
    { k: ['pinterest','pin '], v: 'pinterest' },
    { k: ['snapchat','snap '], v: 'snapchat' },
    { k: ['twitter',' x '], v: 'twitter' },
  ];

  if (meta.networkHint) return meta.networkHint.toLowerCase();
  for (const m of map) if (m.k.some(k => text.includes(k))) return m.v;
  return (ADPILER_DEFAULT_NETWORK || 'facebook').toLowerCase();
}

function inferType({ card, meta }) {
  const text = `${card.name} ${card.desc}`.toLowerCase();
  if (meta.typeHint) return meta.typeHint.toLowerCase();
  if (text.includes('carousel')) return 'carousel';
  if (text.includes('video'))    return 'video';
  if (text.includes('gif'))      return 'gif';
  if (text.includes('static') || text.includes('image')) return 'single_image';
  return (ADPILER_DEFAULT_TYPE || 'single_image').toLowerCase();
}

// ---------- HTTP HELPERS (with retries) ----------
async function postJSON(path, body, maxAttempts = 4) {
  let attempt = 0; let lastErr;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      const resp = await fetch(API(path), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ADPILER_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(body || {})
      });
      const text = await resp.text();
      let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }

      if (resp.ok) return json;

      if (resp.status >= 500) {
        const delay = 400 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
        console.warn(`AdPiler ${resp.status} on ${path} (attempt ${attempt}/${maxAttempts}) → retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`AdPiler ${resp.status} on ${path}: ${text}`);
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        const delay = 400 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
        console.warn(`POST ${path} failed (attempt ${attempt}/${maxAttempts}): ${e.message}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr || new Error(`POST ${path} failed after retries`);
}

async function postForm(path, form, maxAttempts = 4) {
  let attempt = 0; let lastErr;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      const resp = await fetch(API(path), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ADPILER_API_KEY}`,
          ...form.getHeaders()
        },
        body: form
      });
      const text = await resp.text();
      let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }

      if (resp.ok) return json;

      if (resp.status >= 500) {
        const delay = 400 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
        console.warn(`AdPiler ${resp.status} on ${path} (attempt ${attempt}/${maxAttempts}) → retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`AdPiler ${resp.status} on ${path}: ${text}`);
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        const delay = 400 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
        console.warn(`POST form ${path} failed (attempt ${attempt}/${maxAttempts}): ${e.message}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr || new Error(`POST form ${path} failed after retries`);
}

// ---------- ADPILER API STEPS ----------
async function createSocialAd({ campaignId, card, meta }) {
  const network = inferNetwork({ card, meta });
  let type = inferType({ card, meta });

  // Try a sequence of type candidates if API rejects one as invalid
  const tryTypes = Array.from(new Set([
    type,
    (process.env.ADPILER_DEFAULT_TYPE || '').toLowerCase(),
    // common variants vendors expect
    'single_image', 'image', 'static', 'single', 'photo',
    'carousel_ad', 'carousel',
    'video'
  ])).filter(Boolean);

  const makePayload = (t) => ({
    name:        card.name,
    headline:    meta.headline || '',
    description: meta.description || '',
    cta:         meta.cta || '',
    click_url:   meta.url || '',
    network,     // REQUIRED by API
    type: t      // REQUIRED by API
  });

  let lastErr = null;
  for (const t of tryTypes) {
    console.log(`Creating social ad → campaign=${campaignId}, network=${network}, type=${t}`);
    try {
      const json = await postJSON(`campaigns/${encodeURIComponent(campaignId)}/social-ads`, makePayload(t));
      const adId = json.id || json.adId || json.data?.id;
      if (!adId) throw new Error(`Create social-ad did not return an ad id. Response keys: ${Object.keys(json)}`);
      return { adId, raw: json };
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message || '').toLowerCase();
      if (msg.includes('"type"') && msg.includes('invalid')) {
        console.warn(`Type "${t}" rejected; trying next candidate...`);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('All type candidates were rejected by AdPiler');
}

async function uploadSlides({ adId, attachments }) {
  const form = new FormData();
  let count = 0;

  for (const att of attachments || []) {
    if (!att || !att.id) continue;
    const buf = await downloadAttachmentBuffer(att.id);
    const filename = att.name || `asset-${att.id}`;
    // If your API wants "slides[]" or "file", change the field name here:
    form.append('files[]', buf, { filename });
    count++;
  }

  if (!count) {
    console.warn('No attachments found to upload as slides.');
    return { previewUrls: [], raw: null };
  }

  const path = `social-ads/${encodeURIComponent(adId)}/slides`;
  const json = await postForm(path, form);

  const previewUrls = [];
  const push = (v) => { if (v && typeof v === 'string') previewUrls.push(v); };

  if (json.preview_url) push(json.preview_url);
  if (Array.isArray(json.preview_urls)) json.preview_urls.forEach(push);
  if (Array.isArray(json.links)) json.links.forEach(push);
  if (json.data && Array.isArray(json.data)) {
    json.data.forEach(item => {
      push(item.preview_url);
      if (item.links) (Array.isArray(item.links) ? item.links : [item.links]).forEach(push);
    });
  }

  return { previewUrls, raw: json };
}

// ---------- MAIN ENTRY ----------
async function uploadToAdpiler(card, attachments, { postTrelloComment } = {}) {
  assertEnv();

  const mapping = await getClientMapping(card.name);
  const campaignId = mapping.campaignId || mapping.projectId || DEFAULT_PROJECT_ID;
  if (!campaignId) throw new Error('No campaignId found (CSV "Adpiler Campaign ID" or DEFAULT_PROJECT_ID required)');

  const meta = extractAdMetaFromCard(card);

  const { adId } = await createSocialAd({ campaignId, card, meta });
  const { previewUrls } = await uploadSlides({ adId, attachments });

  if (postTrelloComment) {
    const text = previewUrls?.length
      ? `Created AdPiler Social Ad (id: ${adId}) and uploaded ${attachments?.length || 0} slide(s):\n${previewUrls.join('\n')}`
      : `Created AdPiler Social Ad (id: ${adId}) and uploaded ${attachments?.length || 0} slide(s).`;
    await postTrelloComment(card.id, text).catch(()=>{});
  }

  return { adId, previewUrls };
}

module.exports = { uploadToAdpiler };
