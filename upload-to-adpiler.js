/**
 * Trello → AdPiler uploader (Facebook Social Ads)
 * - Uses valid schema: { paid: 'true'|'false', type: 'post'|'post-carousel'|'story'|'story-carousel' }
 * - Chooses multi/single slide legality based on (paid, type) + attachment count
 * - Uploads ONE ad, then adds slides to that SAME ad (all slides when allowed)
 * - Constructs preview URL (CSV code → ENV override → GET /campaigns/{id})
 * - Comments results back to Trello (filenames + preview link)
 */

const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');
const { URL } = require('url');

// ---------- CONSTANTS ----------
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
  ADPILER_PREVIEW_DOMAIN = 'preview.adpiler.com', // your whitelabel domain if any; default works
  ADPILER_PAID_DEFAULT = 'true',                  // default: create paid ads unless "organic" in title
  ADPILER_CAMPAIGN_CODE_OVERRIDE,                 // optional: bypass GET /campaigns/{id} if it 500s
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

// ---------- CSV CLIENT/CAMPAIGN LOOKUP ----------
async function getClientMapping(cardName) {
  const fallback = {
    clientId: String(DEFAULT_CLIENT_ID || '').trim(),
    campaignId: String(DEFAULT_PROJECT_ID || '').trim(),
    folderId: '',
    campaignCode: '',
  };

  if (!CLIENT_CSV_URL) {
    if (fallback.clientId) {
      return {
        clientId: fallback.clientId,
        projectId: fallback.campaignId,
        folderId: '',
        campaignId: fallback.campaignId,
        campaignCode: fallback.campaignCode,
      };
    }
    throw new Error('CLIENT_CSV_URL not set and no DEFAULT_CLIENT_ID provided');
  }

  const res = await fetch(CLIENT_CSV_URL);
  if (!res.ok) throw new Error(`Mapping CSV fetch failed (${res.status})`);
  const rows = await csv().fromString(await res.text());

  const lcCard = normalize(cardName);
  // helpful for titles like "Client: Campaign - ..."
  let row = rows.find(r => lcCard.includes(normalize(r['Trello Client Name'])));
  if (!row) row = rows.find(r => normalize(r['Trello Client Name']) === lcCard);

  if (row) {
    const clientId     = String(row['Adpiler Client ID'] || '').trim();
    const folderId     = String(row['Adpiler Folder ID'] || '').trim();
    const campaignId   = String(row['Adpiler Campaign ID'] || '').trim();
    const campaignCode = String(row['Adpiler Campaign Code'] || '').trim(); // <-- optional CSV column

    if (clientId && campaignId) {
      return { clientId, projectId: campaignId, folderId, campaignId, campaignCode };
    }
    console.warn(`CSV match for "${cardName}" missing required fields; falling back.`);
  } else {
    console.warn(`No CSV match for "${cardName}".`);
  }

  if (fallback.clientId && fallback.campaignId) {
    return {
      clientId: fallback.clientId,
      projectId: fallback.campaignId,
      folderId: '',
      campaignId: fallback.campaignId,
      campaignCode: fallback.campaignCode
    };
  }

  throw new Error(`No valid client mapping found for card "${cardName}"`);
}

// ---------- TRELLO ATTACHMENT HELPERS (card-scoped) ----------
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

// ---------- CARD DESCRIPTION PARSING ----------
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

// ---------- HTTP HELPERS ----------
async function postForm(path, form, maxAttempts = 4) {
  // Retries ONLY on 5xx or network errors, never on 4xx
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

// ---------- PREVIEW URL HELPERS ----------
function buildPreviewUrl({ domain = ADPILER_PREVIEW_DOMAIN, campaignCode, adId }) {
  const base = `https://${domain.replace(/^https?:\/\//, '')}/${encodeURIComponent(campaignCode)}`;
  return adId ? `${base}?ad=${encodeURIComponent(adId)}` : base;
}

async function getCampaignCode(campaignId, mapping) {
  // Priority: CSV code → ENV override → API
  if (mapping?.campaignCode) return mapping.campaignCode;
  if (ADPILER_CAMPAIGN_CODE_OVERRIDE) return ADPILER_CAMPAIGN_CODE_OVERRIDE;
  const data = await getJSON(`campaigns/${encodeURIComponent(campaignId)}`);
  return data.code || data.data?.code || '';
}

// ---------- CHOOSE paid + type ----------
function decidePaidAndType({ cardName, attachmentCount }) {
  const lc = normalize(cardName);
  const isStory = /\bstory\b/.test(lc);      // title contains "story"
  const isOrganic = /\borganic\b/.test(lc);  // title contains "organic"
  const paidDefault = String(ADPILER_PAID_DEFAULT || 'true').toLowerCase() !== 'false';
  const paid = isOrganic ? 'false' : (paidDefault ? 'true' : 'false');

  // From AdPiler developer:
  // ORGANIC (paid=false):
  //   - post -> one or more slides
  //   - story -> single slide
  //   - story-carousel -> one or more slides
  //
  // PAID (paid=true):
  //   - post -> single slide
  //   - post-carousel -> one or more slides
  //   - story -> single slide
  //   - story-carousel -> one or more slides

  if (paid === 'false') { // organic
    if (isStory) {
      return attachmentCount > 1
        ? { paid, type: 'story-carousel', multiAllowed: true }
        : { paid, type: 'story',           multiAllowed: false };
    }
    // Organic post supports multiple
    return { paid, type: 'post', multiAllowed: attachmentCount > 1 };
  }

  // paid === 'true' (ads)
  if (isStory) {
    return attachmentCount > 1
      ? { paid, type: 'story-carousel', multiAllowed: true }
      : { paid, type: 'story',           multiAllowed: false };
  }
  // Non-story paid: multi → post-carousel, single → post
  return attachmentCount > 1
    ? { paid, type: 'post-carousel', multiAllowed: true }
    : { paid, type: 'post',          multiAllowed: false };
}

// ---------- AD CREATION ----------
async function createSocialAd({ campaignId, card, paid, type }) {
  const form = new FormData();
  form.append('name', card.name);
  form.append('network', FIXED_NETWORK);
  form.append('page_name', derivePageName(card.name));
  form.append('paid', paid); // 'true' | 'false'
  form.append('type', type); // 'post' | 'post-carousel' | 'story' | 'story-carousel'

  console.log(`Creating social ad → campaign=${campaignId}, name="${card.name}", network=${FIXED_NETWORK}, paid=${paid}, type=${type}, page_name="${derivePageName(card.name)}"`);
  const json = await postForm(`campaigns/${encodeURIComponent(campaignId)}/social-ads`, form);
  const adId = json.id || json.adId || json.data?.id;
  if (!adId) throw new Error(`Create social-ad did not return an ad id. Response keys: ${Object.keys(json)}`);
  return { adId, raw: json, paid, type };
}

// ---------- SLIDES ----------
async function uploadOneSlide({ adId, fileBuf, filename, meta }) {
  const form = new FormData();
  if (meta.cta)         form.append('call_to_action',   meta.cta);
  if (meta.displayLink) form.append('display_link',     meta.displayLink);
  if (meta.headline)    form.append('headline',         meta.headline);
  if (meta.description) form.append('description',      meta.description);

  // Only send landing_page_url if absolute & valid
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
  console.log(`✅ Slide uploaded to ad ${adId}: ${filename}`);
  return { raw: json };
}

async function uploadSlidesToAd({ cardId, adId, attachments, meta, allowMultiple }) {
  const uploaded = [];
  const sorted = (attachments || []).slice().sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' })
  );

  let count = 0;
  for (const att of sorted) {
    if (!att || !att.id) continue;

    // If multi not allowed, only the first slide is legal
    if (!allowMultiple && count >= 1) break;

    try {
      const { buffer, filename } = await downloadAttachmentBuffer(cardId, att);
      const res = await uploadOneSlide({ adId, fileBuf: buffer, filename: filename || `asset-${att.id}`, meta });
      uploaded.push({ attachmentId: att.id, filename: filename || att.name, result: res.raw });
      console.log(`📎 Added slide ${count + 1}: ${filename || att.name}`);
      count++;
      await new Promise(r => setTimeout(r, 200)); // gentle pacing
    } catch (e) {
      console.warn(`⚠️ Slide upload failed for ${att.id} (${att.name || ''}): ${e.message}`);
    }
  }

  if (uploaded.length === 0 && (attachments?.length || 0) > 0) {
    throw new Error('No attachments could be uploaded (ensure at least one is an uploaded Trello file or a public URL).');
  }

  return uploaded;
}

// ---------- MAIN ENTRY ----------
async function uploadToAdpiler(card, attachments, { postTrelloComment } = {}) {
  assertEnv();

  // 0) Resolve mapping and campaignId (use this mapping later for preview code)
  let mapping;
  try {
    mapping = await getClientMapping(card.name);
  } catch (e) {
    console.warn(`Mapping lookup failed; using DEFAULT_PROJECT_ID. Reason: ${e.message}`);
    mapping = { clientId: DEFAULT_CLIENT_ID, campaignId: DEFAULT_PROJECT_ID, projectId: DEFAULT_PROJECT_ID, folderId: '', campaignCode: '' };
  }
  const campaignId = mapping.campaignId || mapping.projectId || DEFAULT_PROJECT_ID;
  if (!campaignId) throw new Error('No campaignId found (CSV "Adpiler Campaign ID" or DEFAULT_PROJECT_ID required)');

  // 1) Decide paid + type based on card + attachments
  const meta = extractAdMetaFromCard(card);
  const { paid, type, multiAllowed } = decidePaidAndType({
    cardName: card.name,
    attachmentCount: attachments?.length || 0
  });

  // 2) Create the ONE ad
  const { adId } = await createSocialAd({ campaignId, card, paid, type });

  // 3) Upload slides to that same ad (obeying multiAllowed)
  const uploaded = await uploadSlidesToAd({
    cardId: card.id,
    adId,
    attachments,
    meta,
    allowMultiple: !!multiAllowed
  });

  // 4) Build preview URL (CSV code → ENV override → API)
  let previewUrl = '';
  try {
    const campaignCode = await getCampaignCode(campaignId, mapping);
    if (campaignCode) previewUrl = buildPreviewUrl({ campaignCode, adId });
  } catch (e) {
    console.warn('Preview URL build warning:', e.message);
  }

  // 5) Comment back to Trello (best-effort)
  if (postTrelloComment) {
    const lines = [];
    lines.push(`Created AdPiler Social Ad (id: ${adId}, paid: ${paid}, type: ${type}).`);
    lines.push(`Uploaded ${uploaded.length} slide(s) out of ${attachments?.length || 0}:`);
    for (const u of uploaded) lines.push(`• ${u.filename || u.attachmentId}`);
    if (!multiAllowed && (attachments?.length || 0) > 1) {
      lines.push(`Note: "${type}" supports only 1 slide for paid=${paid}.`);
    }
    if (previewUrl) lines.push(previewUrl);
    try { await postTrelloComment(card.id, lines.join('\n')); } catch {}
  }

  return { adId, previewUrls: previewUrl ? [previewUrl] : [] };
}

// Export for server.js
module.exports = { uploadToAdpiler };
module.exports.default = uploadToAdpiler;
