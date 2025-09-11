/**
 * Trello → AdPiler uploader
 * Supports single-image posts and multi-slide carousel ads.
 */

const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');
const { URL } = require('url');

// ---------- FIXED VALUES ----------
const FIXED_NETWORK = 'facebook';
const DEFAULT_PAGE_NAME = 'Adpiler';

// ---------- ENV ----------
const {
  ADPILER_API_KEY,
  CLIENT_CSV_URL,
  TRELLO_API_KEY,
  TRELLO_TOKEN,
  DEFAULT_CLIENT_ID = '',
  DEFAULT_PROJECT_ID = '',
} = process.env;

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
async function fetchCardAttachmentMeta(cardId, attachmentId) {
  const authQ = `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const url = `https://api.trello.com/1/cards/${cardId}/attachments/${attachmentId}?${authQ}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Attachment ${attachmentId} metadata fetch failed (${r.status})`);
  return r.json();
}

async function downloadAttachmentBuffer(cardId, attachment) {
  const meta = (attachment && typeof attachment.isUpload !== 'undefined')
    ? attachment
    : await fetchCardAttachmentMeta(cardId, attachment.id);

  const isUpload = !!meta.isUpload;
  const name = meta.name || `asset-${attachment.id}`;
  const authQ = `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;

  if (isUpload) {
    const dlUrl = `https://api.trello.com/1/cards/${cardId}/attachments/${attachment.id}/download?${authQ}`;
    const dl = await fetch(dlUrl);
    if (!dl.ok) throw new Error(`Attachment ${attachment.id} Trello download failed (${dl.status})`);
    const ab = await dl.arrayBuffer();
    return { buffer: Buffer.from(ab), filename: name };
  }

  const externalUrl = meta.url;
  if (!externalUrl) throw new Error(`Attachment ${attachment.id} is not an uploaded file and has no url`);
  const extRes = await fetch(externalUrl, { redirect: 'follow' });
  if (!extRes.ok) throw new Error(`Attachment ${attachment.id} external fetch failed (${extRes.status}) for ${externalUrl}`);
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
  const m = cardName.split(':')[0].trim();
  return m || DEFAULT_PAGE_NAME;
}

// ---------- HTTP HELPERS ----------
async function postForm(path, form, maxAttempts = 4) {
  let attempt = 0, lastErr;
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
        const delay = 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
        console.warn(`AdPiler ${resp.status} on ${path} (attempt ${attempt}/${maxAttempts}) → retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`AdPiler ${resp.status} on ${path}: ${text}`);
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        const delay = 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
        console.warn(`POST form ${path} failed (attempt ${attempt}/${maxAttempts}): ${e.message}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr || new Error(`POST form ${path} failed after retries`);
}
// ---------- ADPILER API ----------
async function createSocialAd({ campaignId, card, type = 'post', isCarousel = false }) {
  const form = new FormData();
  form.append('name', card.name);
  form.append('network', FIXED_NETWORK);
  form.append('type', type); // always 'post' for FB unless docs say otherwise
  form.append('page_name', derivePageName(card.name));

  // If Adpiler requires a carousel flag, add it here once confirmed:
  if (isCarousel) {
    // form.append('ad_format', 'carousel');
    // or:
    // form.append('is_carousel', '1');
  }

  console.log(`Creating social ad → campaign=${campaignId}, type=${type}, carousel=${isCarousel}`);
  const json = await postForm(`campaigns/${encodeURIComponent(campaignId)}/social-ads`, form);

  const adId = json.id || json.adId || json.data?.id;
  if (!adId) throw new Error(`Create social-ad did not return an ad id. Response keys: ${Object.keys(json)}`);
  return { adId, raw: json };


  console.log(`Creating social ad → campaign=${campaignId}, type=${type}, carousel=${isCarousel}`);
  const json = await postForm(`campaigns/${encodeURIComponent(campaignId)}/social-ads`, form);

  const adId = json.id || json.adId || json.data?.id;
  if (!adId) throw new Error(`Create social-ad did not return an ad id. Response keys: ${Object.keys(json)}`);
  return { adId, raw: json };
}

async function uploadOneSlide({ adId, fileBuf, filename, meta }) {
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

async function uploadSlides({ cardId, adId, attachments, meta }) {
  const allPreviewUrls = [];
  let successCount = 0;
  let triedCount = 0;

  // Ensure attachments are in correct order for carousel
  attachments.sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' })
  );

  for (const att of attachments || []) {
    if (!att || !att.id) continue;
    triedCount++;
    try {
      const { buffer, filename } = await downloadAttachmentBuffer(cardId, att);
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
  const isCarousel = card.name.toLowerCase().includes('carousel');
  const campaignId = process.env.DEFAULT_PROJECT_ID;

  const meta = extractAdMetaFromCard(card); // optional helper
  const adType = 'post'; // always 'post' for Facebook

  const { adId } = await createSocialAd({ campaignId, card, type: adType, isCarousel });

  const previewUrls = [];

  for (let i = 0; i < attachments.length; i++) {
    const { buffer, filename } = await downloadAttachmentBuffer(card.id, attachments[i]);
    const urls = await uploadOneSlide({ adId, fileBuf: buffer, filename, meta });
    previewUrls.push(...urls);
    await new Promise(r => setTimeout(r, 300)); // delay to avoid socket hang-up
  }

  if (postTrelloComment) {
    const text = previewUrls.length
      ? `Created AdPiler Social Ad (id: ${adId}) and uploaded ${attachments.length} attachments:\n${previewUrls.join('\n')}`
      : `Created AdPiler Social Ad (id: ${adId}) and uploaded ${attachments.length} attachments.`;
    postTrelloComment(card.id, text).catch(() => {});
  }

  return { adId, previewUrls };
}

module.exports = { uploadToAdpiler };
