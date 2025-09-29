/**
 * Trello → AdPiler uploader (Facebook Social Ads)
 * Implements developer guidance:
 *  - Two key fields: "paid" ('true' | 'false') + "type"
 *  - Valid types: 'post', 'post-carousel', 'story', 'story-carousel'
 *  - Multi-slide legality depends on (paid,type) pair
 *  - Preview URL must be constructed manually:
 *      https://<PREVIEW_DOMAIN>/<CAMPAIGN_CODE>?ad=<AD_ID>
 *    where PREVIEW_DOMAIN defaults to preview.adpiler.com (or env override)
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
  // Optional behavior knobs (no env change required; sensible defaults)
  ADPILER_PREVIEW_DOMAIN = 'preview.adpiler.com', // can be whitelabel domain if you have it
  ADPILER_PAID_DEFAULT = 'true',                  // default to paid ads
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
const normalize = (s) => (s || '').toLowerCase().trim();

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

  const lcCard = normalize(cardName);
  // First try: contains match (helps with "Client: Campaign" titles)
  let row = rows.find(r => lcCard.includes(normalize(r['Trello Client Name'])));
  // Fallback: exact match
  if (!row) row = rows.find(r => normalize(r['Trello Client Name']) === lcCard);

  if (row) {
    const clientId   = String(row['Adpiler Client ID'] || '').trim();
    const folderId   = String(row['Adpiler Folder ID'] || '').trim();
    const campaignId = String(row['Adpiler Campaign ID'] || '').trim();
    if (clientId && campaignId) return { clientId, projectId: campaignId, folderId, campaignId };
    console.warn(`CSV match for "${cardName}" missing required fields; falling back.`);
  } else {
    console.warn(`No CSV match for "${cardName}".`);
  }

  if (fallback.clientId && fallback.campaignId) {
    return { clientId: fallback.clientId, projectId: fallback.campaignId, folderId: '', campaignId: fallback.campaignId };
  }

  throw new Error(`No valid client mapping found for card "${cardName}"`);
}

// ---------- TRELLO ATTACHMENTS (card-scoped) ----------
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

// ---------- Extract creative metadata from card description ----------
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
  try { if (url) displayLink = new URL(url).hostname.replace(/^www\./, ''); } catch {}

  return { headline, description, cta, url, displayLink };
}

function derivePageName(cardName) {
  const m = (cardName || '').split(':')[0].trim();
  return m || DEFAULT_PAGE_NAME;
}

// ---------- HTTP HELPERS (no retry on 4xx) ----------
async function postForm(path, form, maxAttempts = 4) {
  let attempt = 0, lastErr;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      const resp = await fetch(API(path), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${ADPILER_API_KEY}`, ...form.getHeaders() },
        body: form
      });
      const text = await resp.text();
      let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }

      if (resp.ok) return json;

      if (resp.status >= 500) {
        const delay = 400 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
        console.warn(`AdPiler ${resp.status} on ${path} (attempt ${attempt}/${maxAttempts}) → retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      const err = new Error(`AdPiler ${resp.status} on ${path}: ${text}`);
      err.status = resp.status;
      err.body = json;
      throw err;

    } catch (e) {
      if (e && typeof e.status === 'number' && e.status < 500) {
        throw e; // 4xx or other non-retryable
      }
      lastErr = e;
      if (attempt < maxAttempts) {
        const delay = 400 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
        console.warn(`POST form ${path} failed (attempt ${attempt}/${maxAttempts}): ${e.message}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr || new Error(`POST form ${path} failed after retries`);
}

async function getJSON(path) {
  const r = await fetch(API(path), { headers: { 'Authorization': `Bearer ${ADPILER_API_KEY}` } });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) throw new Error(`AdPiler GET ${path} → ${r.status}: ${text}`);
  return json;
}

// ---------- PREVIEW URL ----------
async function getCampaignCode(campaignId) {
  const data = await getJSON(`campaigns/${encodeURIComponent(campaignId)}`);
  // Expecting an object with a "code" field
  return data.code || data.data?.code || '';
}

function buildPreviewUrl({ domain = ADPILER_PREVIEW_DOMAIN, campaignCode, adId }) {
  const base = `https://${domain.replace(/^https?:\/\//, '')}/${encodeURIComponent(campaignCode)}`;
  return adId ? `${base}?ad=${encodeURIComponent(adId)}` : base;
}

// ---------- Type selection (paid + type) ----------
function decidePaidAndType({ cardName, attachmentCount }) {
  const lc = normalize(cardName);
  const isStory = /\bstory\b/.test(lc);           // title contains "story"
  const isOrganic = /\borganic\b/.test(lc);       // title contains "organic"
  const isPaidDefault = String(ADPILER_PAID_DEFAULT || 'true').toLowerCase() !== 'false';
  const paid = isOrganic ? 'false' : (isPaidDefault ? 'true' : 'false');

  // Rules from developer:
  // ORGANIC (paid=false):
  //   - post: one or more slides
  //   - story: single slide
  //   - story-carousel: one or more slides
  //
  // PAID (paid=true):
  //   - post: single slide
  //   - post-carousel: one or more slides
  //   - story: single slide
  //   - story-carousel: one or more slides

  if (paid === 'false') { // organic
    if (isStory) {
      return attachmentCount > 1
        ? { paid, type: 'story-carousel', multiAllowed: true }
        : { paid, type: 'story',           multiAllowed: false };
    }
    // Organic post supports multiple slides
    return { paid, type: 'post', multiAllowed: attachmentCount > 1 };
  }

  // paid === 'true' (ads)
  if (isStory) {
    return attachmentCount > 1
      ? { paid, type: 'story-carousel', multiAllowed: true }
      : { paid, type: 'story',           multiAllowed: false };
  }
  // Non-story paid: for multiples use post-carousel; single uses post
  return attachmentCount > 1
    ? { paid, type: 'post-carousel', multiAllowed: true }
    : { paid, type: 'post',          multiAllowed: false };
}

// ---------- AdPiler: Create ----------
async function createSocialAd({ campaignId, card, paid, type }) {
  const form = new FormData();
  form.append('name', card.name);
  form.append('network', FIXED_NETWORK);
  form.append('page_name', derivePageName(card.name));
  form.append('paid', paid);     // 'true' | 'false'
  form.append('type', type);     // 'post' | 'post-carousel' | 'story' | 'story-carousel'

  console.log(`Creating social ad → campaign=${campaignId}, name="${card.name}", network=${FIXED_NETWORK}, paid=${paid}, type=${type}, page_name="${derivePageName(card.name)}"`);
  const json = await postForm(`campaigns/${encodeURIComponent(campaignId)}/social-ads`, form);
  const adId = json.id || json.adId || json.data?.id;
  if (!adId) throw new Error(`Create social-ad did not return an ad id. Response keys: ${Object.keys(json)}`);
  return { adId, raw: json, paid, type };
}

// ---------- Slides ----------
async function uploadOneSlide({ adId, fileBuf, filename, meta }) {
  const form = new FormData();
  if (meta.cta)         form.append('call_to_action',   meta.cta);
  if (meta.displayLink) form.append('display_link',     meta.displayLink);
  if (meta.headline)    form.append('headline',         meta.headline);
  if (meta.description) form.append('description',      meta.description);

  // Only send landing_page_url if absolute
  try {
    if (meta.url) {
      const u = new URL(meta.url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        form.append('landing_page_url', u.toString());
      }
    }
  } catch {}

  form.append('media_file', fileBuf, { filename });

  const json = await postForm(`social-ads/${encodeURIComponent(adId)}/slides`, form);

  // API does NOT return preview_url; we will construct it later.
  // Still parse for any helpful info:
  return {
    raw: json
  };
}

async function uploadSlidesToAd({ cardId, adId, attachments, meta, allowMultiple }) {
  const uploaded = [];
  const sorted = (attachments || []).slice().sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' })
  );

  let count = 0;
  for (const att of sorted) {
    if (!att || !att.id) continue;

    // If multiple not allowed, only the first slide is legal
    if (!allowMultiple && count >= 1) break;

    try {
      const { buffer, filename } = await downloadAttachmentBuffer(cardId, att);
      const res = await uploadOneSlide({ adId, fileBuf: buffer, filename: filename || `asset-${att.id}`, meta });
      uploaded.push({ attachmentId: att.id, filename: filename || att.name, result: res.raw });
      count++;
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.warn(`⚠️ Slide upload failed for ${att.id} (${att.name || ''}): ${e.message}`);
    }
  }

  if (uploaded.length === 0 && (attachments?.length || 0) > 0) {
    throw new Error('No attachments could be uploaded (check that at least one is an uploaded Trello file or a public URL).');
  }

  return uploaded;
}

// ---------- Main entry ----------
async function uploadToAdpiler(card, attachments, { postTrelloComment } = {}) {
  assertEnv();

  // Prefer CSV mapping; fallback to DEFAULT_PROJECT_ID
  let campaignId = DEFAULT_PROJECT_ID;
  try {
    const mapping = await getClientMapping(card.name);
    campaignId = mapping.campaignId || mapping.projectId || DEFAULT_PROJECT_ID;
  } catch (e) {
    console.warn(`Mapping lookup failed; using DEFAULT_PROJECT_ID. Reason: ${e.message}`);
  }
  if (!campaignId) throw new Error('No campaignId found (CSV "Adpiler Campaign ID" or DEFAULT_PROJECT_ID required)');

  // Decide paid + type from card name + attachment count
  const meta = extractAdMetaFromCard(card);
  const { paid, type, multiAllowed } = decidePaidAndType({
    cardName: card.name,
    attachmentCount: attachments?.length || 0
  });

  // 1) Create the ad with correct paid/type
  const { adId } = await createSocialAd({ campaignId, card, paid, type });

  // 2) Upload slides (obey the multiAllowed rule for this paid/type pair)
  const uploaded = await uploadSlidesToAd({
    cardId: card.id,
    adId,
    attachments,
    meta,
    allowMultiple: !!multiAllowed
  });

  // 3) Build preview URL
  let previewUrl = '';
  try {
    const campaignCode = await getCampaignCode(campaignId);
    if (campaignCode) {
      previewUrl = buildPreviewUrl({ campaignCode, adId });
    }
  } catch (e) {
    console.warn('Preview URL build warning:', e.message);
  }

  // 4) Comment back to Trello (best-effort)
  if (postTrelloComment) {
    const lines = [];
    lines.push(`Created AdPiler Social Ad (id: ${adId}, paid: ${paid}, type: ${type}).`);
    lines.push(`Uploaded ${uploaded.length} slide(s) out of ${attachments?.length || 0}.`);
    if (!multiAllowed && (attachments?.length || 0) > 1) {
      lines.push(`Note: "${type}" supports only 1 slide for paid=${paid}.`);
    }
    if (previewUrl) lines.push(previewUrl);
    try { await postTrelloComment(card.id, lines.join('\n')); } catch {}
  }

  // Return constructed preview and adId
  return { adId, previewUrls: previewUrl ? [previewUrl] : [] };
}

// Export both named and default to be safe with require()
module.exports = { uploadToAdpiler };
module.exports.default = uploadToAdpiler;

