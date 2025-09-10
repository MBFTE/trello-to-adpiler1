/**
 * Trello → AdPiler (API path)
 *
 * CREATE (multipart):
 *   POST /campaigns/{campaign}/social-ads
 *   form fields:
 *     - name (string)
 *     - network (string)     ← enum varies by tenant; allow overrides
 *     - type (string)        ← enum varies by tenant; allow overrides
 *     - page_name (string)   ← optional, can be brand/client page
 *     - logo (binary)        ← optional; we can attach first asset if desired
 *
 * SLIDES (multipart, per file):
 *   POST /social-ads/{ad}/slides
 *   form fields:
 *     - call_to_action (string)
 *     - display_link (string)
 *     - headline (string)
 *     - description (string)
 *     - landing_page_url (string)
 *     - media_file (binary)
 *
 * CSV headers expected:
 *  - "Trello Client Name"
 *  - "Adpiler Client ID"
 *  - "Adpiler Folder ID"
 *  - "Adpiler Campaign ID"  ← used as {campaign}
 *
 * ENV (Render, no quotes):
 *  - ADPILER_UPLOAD_MODE=api
 *  - ADPILER_API_BASE=https://platform.adpiler.com/api   (or ADPILER_BASE_URL)
 *  - ADPILER_API_KEY=...     (Bearer)
 *  - CLIENT_CSV_URL=https://.../pub?output=csv
 *  - TRELLO_API_KEY=...
 *  - TRELLO_TOKEN=...
 *  - DEFAULT_CLIENT_ID=69144            (optional fallback)
 *  - DEFAULT_PROJECT_ID=445479          (optional fallback → campaignId)
 *
 *  // CREATE overrides / defaults (strongly recommended for tenant-specific enums):
 *  - ADPILER_FORCE_NETWORK=facebook         (exact enum for your tenant)
 *  - ADPILER_FORCE_TYPE=single_image        (exact enum for your tenant)
 *  - ADPILER_DEFAULT_NETWORK=facebook       (used if not forced and not inferred)
 *  - ADPILER_DEFAULT_TYPE=single_image      (used if not forced and not inferred)
 *  - ADPILER_PAGE_NAME=Zia Clovis (optional; falls back to client/list name if unset)
 *  - ADPILER_USE_LOGO_FROM_CARD=1           (optional; attach first asset as "logo" on create)
 *
 *  // CREATE extra (optional JSON merged into create form as strings)
 *  - ADPILER_CREATE_EXTRA_JSON={"status":"draft"}
 */

const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');
const { URL } = require('url');

// ---------- ENV ----------
const {
  ADPILER_API_KEY,
  CLIENT_CSV_URL,
  TRELLO_API_KEY,
  TRELLO_TOKEN,
  DEFAULT_CLIENT_ID = '',
  DEFAULT_PROJECT_ID = '',

  ADPILER_FORCE_NETWORK = '',
  ADPILER_FORCE_TYPE = '',
  ADPILER_DEFAULT_NETWORK = '',
  ADPILER_DEFAULT_TYPE = '',
  ADPILER_PAGE_NAME = '',
  ADPILER_USE_LOGO_FROM_CARD = '',
  ADPILER_CREATE_EXTRA_JSON = '',
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

  const headline     = grab('Headline');
  const description  = grab('Description');
  const cta          = grab('CTA') || grab('Call to Action') || grab('Call_to_action');
  const url          = grab('URL') || grab('Landing Page') || grab('Landing_page_url');

  let displayLink = '';
  try {
    if (url) displayLink = new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {}

  return {
    headline,
    description,
    cta,
    url,
    displayLink
  };
}

// ---------- INFERENCE & OVERRIDES ----------
function inferNetwork({ card }) {
  const forced = (ADPILER_FORCE_NETWORK || '').trim();
  if (forced) return forced;

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
  for (const m of map) if (m.k.some(k => text.includes(k))) return m.v;
  return (ADPILER_DEFAULT_NETWORK || 'facebook');
}

function inferType({ card }) {
  const forced = (ADPILER_FORCE_TYPE || '').trim();
  if (forced) return forced;

  const text = `${card.name} ${card.desc}`.toLowerCase();
  if (text.includes('carousel')) return 'carousel';
  if (text.includes('video'))    return 'video';
  if (text.includes('gif'))      return 'gif';
  if (text.includes('static') || text.includes('image')) return 'single_image';
  return (ADPILER_DEFAULT_TYPE || 'single_image');
}

function derivePageName(cardName, mapping) {
  // Priority: env override → CSV "Trello Client Name" contained in card title → fallback to card prefix before ":".
  if (ADPILER_PAGE_NAME && ADPILER_PAGE_NAME.trim()) return ADPILER_PAGE_NAME.trim();
  const m = cardName.split(':')[0].trim();
  return m || 'Page';
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
function parseCreateExtras() {
  if (!ADPILER_CREATE_EXTRA_JSON) return {};
  try {
    const obj = JSON.parse(ADPILER_CREATE_EXTRA_JSON);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) {
    console.warn('ADPILER_CREATE_EXTRA_JSON is not valid JSON; ignoring');
    return {};
  }
}

async function createSocialAd({ campaignId, card, mapping, meta, attachments }) {
  // Build multipart form per docs
  const form = new FormData();

  const name = card.name;
  const network = inferNetwork({ card });
  const type = inferType({ card });
  const pageName = derivePageName(card.name, mapping);

  form.append('name', name);
  form.append('network', network);
  form.append('type', type);
  form.append('page_name', pageName);

  // Optional: attach "logo" if env says so — we’ll use the first attachment
  if (ADPILER_USE_LOGO_FROM_CARD === '1' && attachments && attachments.length) {
    try {
      const first = attachments[0];
      const buf = await downloadAttachmentBuffer(first.id);
      const filename = first.name || `logo-${first.id}`;
      form.append('logo', buf, { filename });
    } catch (e) {
      console.warn('Could not attach logo from card:', e.message);
    }
  }

  // Optional: merge any extra fields from env JSON as strings
  const extras = parseCreateExtras();
  for (const [k, v] of Object.entries(extras)) {
    if (v === undefined || v === null) continue;
    form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  }

  console.log(`Creating social ad → campaign=${campaignId}, name="${name}", network=${network}, type=${type}, page_name="${pageName}"`);
  const json = await postForm(`campaigns/${encodeURIComponent(campaignId)}/social-ads`, form);

  const adId = json.id || json.adId || json.data?.id;
  if (!adId) {
    throw new Error(`Create social-ad did not return an ad id. Response keys: ${Object.keys(json)}`);
  }
  return { adId, raw: json };
}

async function uploadOneSlide({ adId, fileBuf, filename, meta }) {
  // POST /social-ads/{ad}/slides (multipart)
  const form = new FormData();

  if (meta.cta)            form.append('call_to_action',   meta.cta);
  if (meta.displayLink)    form.append('display_link',     meta.displayLink);
  if (meta.headline)       form.append('headline',         meta.headline);
  if (meta.description)    form.append('description',      meta.description);
  if (meta.url)            form.append('landing_page_url', meta.url);

  form.append('media_file', fileBuf, { filename });

  const json = await postForm(`social-ads/${encodeURIComponent(adId)}/slides`, form);

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
  return previewUrls;
}

async function uploadSlides({ adId, attachments, meta }) {
  const all = [];
  for (const att of attachments || []) {
    if (!att || !att.id) continue;
    const buf = await downloadAttachmentBuffer(att.id);
    const filename = att.name || `asset-${att.id}`;
    const urls = await uploadOneSlide({ adId, fileBuf: buf, filename, meta });
    all.push(...urls);
  }
  return { previewUrls: all };
}

// ---------- MAIN ENTRY ----------
async function uploadToAdpiler(card, attachments, { postTrelloComment } = {}) {
  assertEnv();

  const mapping = await getClientMapping(card.name);
  const campaignId = mapping.campaignId || mapping.projectId || DEFAULT_PROJECT_ID;
  if (!campaignId) throw new Error('No campaignId found (CSV "Adpiler Campaign ID" or DEFAULT_PROJECT_ID required)');

  const meta = extractAdMetaFromCard(card);

  // 1) Create Social Ad (multipart)
  const { adId } = await createSocialAd({ campaignId, card, mapping, meta, attachments });

  // 2) Upload all attachments as slides (multipart per file)
  const { previewUrls } = await uploadSlides({ adId, attachments, meta });

  // 3) Optional: comment back on Trello
  if (postTrelloComment) {
    const text = previewUrls?.length
      ? `Created AdPiler Social Ad (id: ${adId}) and uploaded ${attachments?.length || 0} slide(s):\n${previewUrls.join('\n')}`
      : `Created AdPiler Social Ad (id: ${adId}) and uploaded ${attachments?.length || 0} slide(s).`;
    await postTrelloComment(card.id, text).catch(()=>{});
  }

  return { adId, previewUrls };
}

module.exports = { uploadToAdpiler };
