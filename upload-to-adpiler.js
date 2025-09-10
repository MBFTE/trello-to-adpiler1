/**
 * Trello → AdPiler (API path, resilient)
 *
 * CREATE (multipart):
 *   POST /campaigns/{campaign}/social-ads
 *   fields:
 *     - name (string)
 *     - network (string)   ← fixed "facebook"
 *     - type (string)      ← fixed "post"
 *     - page_name (string) ← derived from card, fallback "Adpiler"
 *     - logo (binary)      ← optional (disabled by default)
 *
 * SLIDES (multipart per file):
 *   POST /social-ads/{ad}/slides
 *   fields:
 *     - call_to_action
 *     - display_link
 *     - headline
 *     - description
 *     - landing_page_url
 *     - media_file (binary)
 *
 * CSV headers expected:
 *  - "Trello Client Name"
 *  - "Adpiler Client ID"
 *  - "Adpiler Folder ID"
 *  - "Adpiler Campaign ID"  ← used as {campaign}
 *
 * REQUIRED ENV (you already have these):
 *  - ADPILER_API_BASE=https://platform.adpiler.com/api   (or ADPILER_BASE_URL)
 *  - ADPILER_API_KEY=...     (Bearer)
 *  - CLIENT_CSV_URL=https://.../pub?output=csv  (or set DEFAULT_CLIENT_ID/DEFAULT_PROJECT_ID)
 *  - TRELLO_API_KEY=...
 *  - TRELLO_TOKEN=...
 *  - DEFAULT_CLIENT_ID (optional)
 *  - DEFAULT_PROJECT_ID (optional → campaignId)
 */

const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');
const { URL } = require('url');

// ---------- FIXED VALUES (no new env) ----------
const FIXED_NETWORK = 'facebook';
const FIXED_TYPE = 'post';
const DEFAULT_PAGE_NAME = 'Adpiler';

// ---------- ENV (existing) ----------
const {
  ADPILER_API_KEY,
  CLIENT_CSV_URL,
  TRELLO_API_KEY,
  TRELLO_TOKEN,
  DEFAULT_CLIENT_ID = '',
  DEFAULT_PROJECT_ID = '',
  // ADPILER_API_BASE or ADPILER_BASE_URL provided in your env
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
async function getClientMapping(cardName) {
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
  const authQ = `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;

  // 1) Inspect attachment metadata
  const metaRes = await fetch(`https://api.trello.com/1/attachments/${attachmentId}?${authQ}`);
  if (!metaRes.ok) {
    throw new Error(`Attachment ${attachmentId} metadata fetch failed (${metaRes.status})`);
  }
  const meta = await metaRes.json();
  const isUpload = !!meta.isUpload;
  const name = meta.name || `asset-${attachmentId}`;

  // 2) Uploaded file → Trello /download
  if (isUpload) {
    const dl = await fetch(`https://api.trello.com/1/attachments/${attachmentId}/download?${authQ}`);
    if (!dl.ok) {
      throw new Error(`Attachment ${attachmentId} Trello download failed (${dl.status})`);
    }
    const ab = await dl.arrayBuffer();
    return { buffer: Buffer.from(ab), filename: name };
  }

  // 3) External link → fetch meta.url (must be public)
  const externalUrl = meta.url;
  if (!externalUrl) {
    throw new Error(`Attachment ${attachmentId} is not an uploaded file and has no url`);
  }

  const extRes = await fetch(externalUrl, { redirect: 'follow' });
  if (!extRes.ok) {
    throw new Error(`Attachment ${attachmentId} external fetch failed (${extRes.status}) for ${externalUrl}`);
  }
  const ab = await extRes.arrayBuffer();
  return { buffer: Buffer.from(ab), filename: name };
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

function derivePageName(cardName) {
  // Use prefix before ":" if present; else fallback
  const m = cardName.split(':')[0].trim();
  return m || DEFAULT_PAGE_NAME;
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
async function createSocialAd({ campaignId, card /*, attachments*/ }) {
  // Per your tenant schema: name + fixed network/type + page_name (multipart)
  const form = new FormData();

  const name = card.name;
  const network = FIXED_NETWORK;
  const type = FIXED_TYPE;
  const pageName = derivePageName(card.name);

  form.append('name', name);
  form.append('network', network);
  form.append('type', type);
  form.append('page_name', pageName);

  // Optional: attach logo from first attachment (disabled by default)
  /*
  if (attachments && attachments.length) {
    try {
      const first = attachments[0];
      const { buffer, filename } = await downloadAttachmentBuffer(first.id);
      form.append('logo', buffer, { filename: filename || `logo-${first.id}` });
    } catch (e) {
      console.warn('Could not attach logo from card:', e.message);
    }
  }
  */

  console.log(`Creating social ad → campaign=${campaignId}, name="${name}", network=${network}, type=${type}, page_name="${pageName}"`);
  const json = await postForm(`campaigns/${encodeURIComponent(campaignId)}/social-ads`, form);

  const adId = json.id || json.adId || json.data?.id;
  if (!adId) {
    throw new Error(`Create social-ad did not return an ad id. Response keys: ${Object.keys(json)}`);
  }
  return { adId, raw: json };
}

async function uploadOneSlide({ adId, fileBuf, filename, meta }) {
  // POST /social-ads/{ad}/slides (multipart per file)
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
  const allPreviewUrls = [];
  let successCount = 0;
  let triedCount = 0;

  for (const att of attachments || []) {
    if (!att || !att.id) continue;
    triedCount++;
    try {
      const { buffer, filename } = await downloadAttachmentBuffer(att.id);
      const urls = await uploadOneSlide({
        adId,
        fileBuf: buffer,
        filename: filename || `asset-${att.id}`,
        meta
      });
      allPreviewUrls.push(...(urls || []));
      successCount++;
    } catch (e) {
      console.warn(`⚠️ Skipping attachment ${att.id} (${att.name || ''}): ${e.message}`);
    }
  }

  if (triedCount > 0 && successCount === 0) {
    throw new Error('None of the card attachments could be fetched. Ensure at least one attachment is an uploaded file in Trello or a publicly accessible link.');
  }

  return { previewUrls: allPreviewUrls };
}

// ---------- MAIN ENTRY ----------
async function uploadToAdpiler(card, attachments, { postTrelloComment } = {}) {
  assertEnv();

  const mapping = await getClientMapping(card.name);
  const campaignId = mapping.campaignId || mapping.projectId || DEFAULT_PROJECT_ID;
  if (!campaignId) throw new Error('No campaignId found (CSV "Adpiler Campaign ID" or DEFAULT_PROJECT_ID required)');

  const meta = extractAdMetaFromCard(card);

  // 1) Create Social Ad (multipart)
  const { adId } = await createSocialAd({ campaignId, card /*, attachments*/ });

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


