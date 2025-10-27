/**
 * Trello → AdPiler uploader (Display, Post, Post Carousel) + MP4 support for Post
 *
 * Modes:
 *  - Display (300x600) → POST /campaigns/{campaign}/ads                  (file + width/height + landing_page_url)
 *  - Post (single social) → POST /campaigns/{campaign}/social-ads        (create) → /social-ads/{ad}/slides (upload 1)
 *  - Post Carousel →       POST /campaigns/{campaign}/social-ads         (create) → /social-ads/{ad}/slides (upload many)
 *
 * Auto mode selection (unless ADPILER_FORCE_MODE=display|post|post-carousel):
 *  1) ≥2 square (1:1) images → Post Carousel
 *  2) else ≥2 non-display images (NOT 300×600) → Post Carousel
 *  3) else exactly 1 square → Post (single)
 *  4) else if title hints "display" or a true 300×600 GIF/PNG exists → Display
 *  5) else → Post (single)
 *
 * Single Post media preference:
 *  1) square image → 2) first video (.mp4/.mov/.m4v) → 3) first attachment
 *
 * Labels tolerate markdown wrappers (e.g., **Primary Text**:).
 */

const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');
const { URL } = require('url');

// Optional: pixel detection for asset picking (recommended)
let imageSize = null;
try { imageSize = require('image-size'); } catch { /* optional */ }

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
  ADPILER_PREVIEW_DOMAIN = 'preview.adpiler.com',
  ADPILER_PAID_DEFAULT = 'true',
  ADPILER_CAMPAIGN_CODE_OVERRIDE,
  ADPILER_API_BASE,
  ADPILER_BASE_URL,
  ADPILER_FORCE_MODE // 'display' | 'post' | 'post-carousel'
} = process.env;

const _API_BASE = (ADPILER_API_BASE || ADPILER_BASE_URL || '').trim();
const API = (p) => `${_API_BASE.replace(/\/+$/,'')}/${String(p || '').replace(/^\/+/, '')}`;
const normalize = (s) => (s || '').toLowerCase().trim();

function assertEnv() {
  const miss = [];
  if (!_API_BASE) miss.push('ADPILER_API_BASE (or ADPILER_BASE_URL)');
  if (!ADPILER_API_KEY) miss.push('ADPILER_API_KEY');
  if (!TRELLO_API_KEY) miss.push('TRELLO_API_KEY');
  if (!TRELLO_TOKEN) miss.push('TRELLO_TOKEN');
  if (!CLIENT_CSV_URL && !DEFAULT_CLIENT_ID) miss.push('CLIENT_CSV_URL (or set DEFAULT_CLIENT_ID)');
  if (miss.length) throw new Error(`Missing env vars: ${miss.join(', ')}`);
}

// ---------- CSV CLIENT/CAMPAIGN LOOKUP ----------
async function getClientMapping(cardName) {
  const fallback = {
    clientId: String(DEFAULT_CLIENT_ID || '').trim(),
    campaignId: String(DEFAULT_PROJECT_ID || '').trim(),
    folderId: '',
    campaignCode: ''
  };

  if (!CLIENT_CSV_URL) {
    if (fallback.clientId) return { ...fallback };
    throw new Error('CLIENT_CSV_URL not set and no DEFAULT_CLIENT_ID provided');
  }

  const res = await fetch(CLIENT_CSV_URL);
  if (!res.ok) throw new Error(`Mapping CSV fetch failed (${res.status})`);
  const rows = await csv().fromString(await res.text());

  const lcCard = normalize(cardName);
  let row = rows.find(r => lcCard.includes(normalize(r['Trello Client Name'])));
  if (!row) row = rows.find(r => normalize(r['Trello Client Name']) === lcCard);

  if (row) {
    const clientId     = String(row['Adpiler Client ID'] || '').trim();
    const folderId     = String(row['Adpiler Folder ID'] || '').trim();
    const campaignId   = String(row['Adpiler Campaign ID'] || '').trim();
    const campaignCode = String(row['Adpiler Campaign Code'] || '').trim();
    if (clientId && campaignId) return { clientId, folderId, campaignId, campaignCode };
  } else {
    console.warn(`No CSV match for "${cardName}". Falling back to defaults.`);
  }
  return { ...fallback };
}

// ---------- TRELLO ATTACHMENT HELPERS ----------
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
    return { buffer: Buffer.from(ab), filename: name, mimeType: meta.mimeType || '' };
  }

  const externalUrl = meta.url;
  if (!externalUrl) throw new Error(`Attachment ${attachment.id} is not an uploaded file and has no url`);
  const extRes = await fetch(externalUrl, { redirect: 'follow' });
  if (!extRes.ok) throw new Error(`Attachment ${attachment.id} external fetch failed (${extRes.status}) for ${externalUrl}`);
  const ab = await extRes.arrayBuffer();
  return { buffer: Buffer.from(ab), filename: name, mimeType: meta.mimeType || '' };
}

// ---------- CARD META PARSING ----------
function extractAdMetaFromCard(card) {
  const norm = (s) => (s || '').trim();
  const isBlank = (s) => !s || /^leave\s+blank$/i.test(String(s).trim());

  const desc = card.desc || '';
  const grab = (label) => {
    // allow markdown wrappers: **Label**: value
    const rx = new RegExp('^\\s*[*_~`]*' + label + '[*_~`]*\\s*:\\s*(.+)$', 'im');
    const m = desc.match(rx);
    return m ? m[1].trim() : '';
  };

  let clVals = {};
  try {
    const metaChecklist = (card.checklists || []).find(cl =>
      String(cl.name || '').toLowerCase().trim() === 'ad meta'
    );
    if (metaChecklist) {
      for (const it of metaChecklist.checkItems || []) {
        const txt = String(it.name || '');
        const mm = txt.match(/^\s*([^:]+)\s*:\s*(.+)$/);
        if (mm) {
          const key = String(mm[1]).replace(/[*_`~]/g,'').toLowerCase().trim().replace(/\s+/g,' ');
          clVals[key] = mm[2].trim();
        }
      }
    }
  } catch {}

  const pick = (label, ...aliases) => {
    const keys = [label, ...aliases].map(k => k.toLowerCase());
    for (const k of keys) if (clVals[k]) return clVals[k];
    for (const k of [label, ...aliases]) { const v = grab(k); if (v) return v; }
    return '';
  };

  const primaryText = pick('Primary Text', 'Primary', 'Body', 'Post Text');
  const headline    = pick('Headline', 'Title');
  const cta         = pick('Call To Action', 'CTA');
  const url         = pick('Landing Page URL', 'URL', 'Link', 'Landing Page');
  let description   = pick('Description');

  const clean = (s) => (isBlank(s) ? '' : norm(s));
  const cleanedUrl = clean(url);

  let displayLink = '';
  try { if (cleanedUrl) displayLink = new URL(cleanedUrl).hostname.replace(/^www\./, ''); } catch {}

  return {
    primary:     clean(primaryText),
    headline:    clean(headline),
    description: clean(description),
    cta:         clean(cta),
    url:         cleanedUrl,
    displayLink
  };
}

function derivePageName(cardName) {
  const m = (cardName || '').split(':')[0].trim();
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
      if (e && typeof e.status === 'number' && e.status < 500) throw e;
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
async function getCampaignCodeViaApi(campaignId) {
  const data = await getJSON(`campaigns/${encodeURIComponent(campaignId)}`);
  return data.code || data.data?.code || '';
}

// ---------- DECIDE paid ----------
function decidePaid({ cardName }) {
  const isOrganic = /\borganic\b/.test(normalize(cardName));
  const paidDefault = String(ADPILER_PAID_DEFAULT || 'true').toLowerCase() !== 'false';
  return { paid: isOrganic ? false : !!paidDefault };
}

// ---------- Asset helpers ----------
function _nameLooks300x600(n=''){ return /\b300\D*600\b/i.test(String(n||'')); }
function _isGifOrPng(n='',m=''){ const name=String(n||'').toLowerCase(); const mime=String(m||'').toLowerCase(); return name.endsWith('.gif')||name.endsWith('.png')||/image\/(gif|png)/.test(mime); }
function _isImageName(n=''){ return /\.(png|jpe?g|gif|webp)$/i.test(String(n||'')); }
function _isVideoName(n=''){ return /\.(mp4|mov|m4v)$/i.test(String(n||'')); }

async function collectSquareAssets(cardId, attachments = []) {
  const out = [];
  for (const att of attachments || []) {
    if (!att?.id || !_isImageName(att.name||'')) continue; // images only for “square”
    try {
      const { buffer, filename } = await downloadAttachmentBuffer(cardId, att);
      const fname = filename || att.name || `asset-${att.id}`;
      let w=0,h=0, exactSquare=false, hinted=/\b(1\s*:\s*1|1200x1200|1080x1080|square)\b/i.test(fname);
      if (imageSize) {
        try { const d=imageSize(buffer); w=d?.width||0; h=d?.height||0; exactSquare = (w>0 && h>0 && w===h); } catch {}
      }
      const nameLooksDisplay = _nameLooks300x600(fname);
      const eligibleWhenUnknown = (!imageSize || (w===0||h===0)) && !nameLooksDisplay;
      if (exactSquare || hinted || eligibleWhenUnknown) {
        out.push({
          buffer,
          filename: fname,
          rankExact: exactSquare && (w===1200 || w===1080) ? 2 : (exactSquare ? 1 : 0),
          pixels: (w||0)*(h||0)
        });
      }
    } catch (e) { console.warn('square pick skip:', e.message); }
  }
  out.sort((a,b)=>{
    const A=[a.rankExact, a.pixels, (a.filename||'').toLowerCase()];
    const B=[b.rankExact, b.pixels, (b.filename||'').toLowerCase()];
    return (B[0]-A[0])||(B[1]-A[1])||(A[2]<B[2]?-1:1);
  });
  return out;
}

function collectNonDisplayImages(attachments = []) {
  return (attachments || []).filter(a =>
    a?.name && _isImageName(a.name) && !_nameLooks300x600(a.name)
  );
}

// NEW: pick first video for Post fallback (.mp4/.mov/.m4v)
async function pickFirstVideo(cardId, attachments = []) {
  const vid = (attachments || []).find(a => a?.name && _isVideoName(a.name));
  if (!vid) return null;
  try {
    const { buffer, filename } = await downloadAttachmentBuffer(cardId, vid);
    return { buffer, filename };
  } catch (e) {
    console.warn('video pick failed:', e.message);
    return null;
  }
}

async function pickFirstAttachment(cardId, attachments=[]) {
  if (!attachments?.length) return null;
  try {
    const { buffer, filename } = await downloadAttachmentBuffer(cardId, attachments[0]);
    return { buffer, filename };
  } catch (e) {
    console.warn('first attachment download failed:', e.message);
    return null;
  }
}

async function pickDisplay300x600(cardId, attachments = []) {
  const cand=[];
  for (const att of attachments||[]) {
    if (!att?.id || !_isGifOrPng(att.name, att.mimeType)) continue; // Display: GIF/PNG only
    try {
      const { buffer, filename } = await downloadAttachmentBuffer(cardId, att);
      let w=0,h=0;
      if (imageSize) { try { const d=imageSize(buffer); w=d?.width||0; h=d?.height||0; } catch {} }
      const okDim=(w===300&&h===600)||(w===600&&h===300);
      cand.push({ buffer, filename: filename||att.name||`asset-${att.id}`, gif:/\.gif$/i.test(filename||att.name||''), hinted:_nameLooks300x600(filename||att.name), okDim });
    } catch (e) { console.warn('display pick skip:', e.message); }
  }
  if (!cand.length) return null;
  cand.sort((a,b)=>{
    const A=[a.okDim?1:0,a.hinted?1:0,a.gif?1:0,(a.filename||'').toLowerCase()];
    const B=[b.okDim?1:0,b.hinted?1:0,b.gif?1:0,(b.filename||'').toLowerCase()];
    return (B[0]-A[0])||(B[1]-A[1])||(B[2]-A[2])||(A[3]<B[3]?-1:1);
  });
  return cand[0];
}

// ---------- /ads helper (Display) ----------
async function postAdsCreate(campaignId, form) {
  const resp = await fetch(API(`campaigns/${encodeURIComponent(campaignId)}/ads`), {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ADPILER_API_KEY}`, ...form.getHeaders() },
    body: form
  });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!resp.ok) throw new Error(`POST /ads → ${resp.status}: ${text}`);
  const id = json.id || json.adId || json.data?.id;
  if (!id) throw new Error(`Create /ads returned no id. Keys: ${Object.keys(json)}`);
  return id;
}

async function createDisplay300x600ViaAds({ campaignId, card, asset, landingUrl }) {
  const form = new FormData();
  form.append('name', card.name);
  form.append('width', '300');
  form.append('height','600');
  if (landingUrl) form.append('landing_page_url', landingUrl);
  form.append('file', asset.buffer, { filename: asset.filename });
  const id = await postAdsCreate(campaignId, form);
  console.log(`✅ Display 300x600 (/ads) ${id} file=${asset.filename}`);
  return id;
}

// ---------- Social ads via /social-ads ----------
async function createSocialAd({ campaignId, card, paid, type, primaryText }) {
  // type: 'post' | 'post-carousel' | 'story' | 'story-carousel'
  const form = new FormData();
  form.append('name', card.name);
  form.append('network', FIXED_NETWORK);
  form.append('page_name', derivePageName(card.name));
  form.append('paid', paid ? 'true' : 'false');
  form.append('type', type);
  if (primaryText) form.append('message', primaryText); // ad-level Primary Text
  const json = await postForm(`campaigns/${encodeURIComponent(campaignId)}/social-ads`, form);
  const adId = json.id || json.adId || json.data?.id;
  if (!adId) throw new Error(`Create social-ad did not return id. Keys: ${Object.keys(json)}`);
  return { adId, raw: json };
}

async function uploadOneSlide({ adId, fileBuf, filename, meta }) {
  const form = new FormData();
  if (meta.cta)         form.append('call_to_action',   meta.cta);
  if (meta.displayLink) form.append('display_link',     meta.displayLink);
  if (meta.headline)    form.append('headline',         meta.headline);
  if (meta.description) form.append('description',      meta.description);
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
  console.log(`✅ Slide → ad ${adId}: ${filename}`);
  return { raw: json };
}

async function uploadSlidesToAd({ cardId, adId, attachments, meta, onlyThese }) {
  const list = (onlyThese && onlyThese.length) ? onlyThese : (attachments || []);
  const sorted = list.slice().sort((a, b) => (a.filename||a.name||'').localeCompare((b.filename||b.name||''), undefined, { numeric: true, sensitivity: 'base' }));

  let count = 0;
  for (const att of sorted) {
    try {
      let buffer, filename;
      if (att.buffer) { buffer = att.buffer; filename = att.filename; }
      else { const dl = await downloadAttachmentBuffer(cardId, att); buffer = dl.buffer; filename = dl.filename || att.name || `asset-${att.id}`; }
      await uploadOneSlide({ adId, fileBuf: buffer, filename, meta });
      count++;
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.warn(`⚠️ Slide upload failed (${att.name || att.filename || ''}): ${e.message}`);
    }
  }
  if (count === 0 && list.length > 0) throw new Error('No slides uploaded (check file accessibility).');
  return count;
}

// ---------- MAIN ----------
async function uploadToAdpiler(card, attachments, { postTrelloComment } = {}) {
  assertEnv();

  // Mapping
  let mapping;
  try { mapping = await getClientMapping(card.name); }
  catch (e) { console.warn(`Mapping lookup failed; using defaults. ${e.message}`); mapping = { clientId: DEFAULT_CLIENT_ID, campaignId: DEFAULT_PROJECT_ID, campaignCode: '' }; }
  const campaignId = mapping.campaignId || mapping.projectId || DEFAULT_PROJECT_ID;
  if (!campaignId) throw new Error('No campaignId found (CSV "Adpiler Campaign ID" or DEFAULT_PROJECT_ID required)');

  // Meta & paid
  const meta = extractAdMetaFromCard(card);
  const { paid } = decidePaid({ cardName: card.name });

  // Decide mode (force / auto)
  const title = String(card.name || '');
  const wantsDisplayHint = /\bdisplay\b/i.test(title) || /\b300\D*600\b/i.test(title);
  const forceMode = (ADPILER_FORCE_MODE || '').toLowerCase().trim(); // 'display' | 'post' | 'post-carousel'

  let mode = forceMode || '';
  let socialAdId = '';
  let displayAdId = '';
  let uploadedCount = 0;

  try {
    // Pre-scan
    const displayAsset = await pickDisplay300x600(card.id, attachments);
    const squareAssets = await collectSquareAssets(card.id, attachments);
    const nonDisplayImages = collectNonDisplayImages(attachments);
    const firstVideo = await pickFirstVideo(card.id, attachments);
    const firstAsset = await pickFirstAttachment(card.id, attachments);

    if (!mode) {
      if (squareAssets.length >= 2)            mode = 'post-carousel';
      else if (nonDisplayImages.length >= 2)   mode = 'post-carousel';   // fallback heuristic
      else if (squareAssets.length === 1)      mode = 'post';
      else if (wantsDisplayHint || displayAsset) mode = 'display';
      else                                     mode = 'post';
    }

    console.log(`Mode decided: ${mode}`);

    if (mode === 'display') {
      if (!displayAsset) throw new Error('Display mode selected but no 300x600 GIF/PNG found.');
      const lp = meta.url || '';
      displayAdId = await createDisplay300x600ViaAds({ campaignId, card, asset: displayAsset, landingUrl: lp });

    } else if (mode === 'post') {
      // Create Social Ad (type=post), then upload exactly one slide.
      // Preference: square image → first video → first attachment
      const media = squareAssets[0] || firstVideo || firstAsset;
      if (!media) throw new Error('Post mode selected but no usable attachment found.');

      const { adId } = await createSocialAd({ campaignId, card, paid, type: 'post', primaryText: meta.primary });
      socialAdId = adId;

      await uploadSlidesToAd({
        cardId: card.id,
        adId: socialAdId,
        attachments,
        meta,
        onlyThese: [media]
      });

    } else if (mode === 'post-carousel') {
      const { adId } = await createSocialAd({ campaignId, card, paid, type: 'post-carousel', primaryText: meta.primary });
      socialAdId = adId;

      // Slides: prefer squares → else non-display images → else everything (images only)
      const slideSet = squareAssets.length ? squareAssets
                        : (nonDisplayImages.length ? nonDisplayImages : attachments.filter(a => a?.name && _isImageName(a.name)));

      uploadedCount = await uploadSlidesToAd({
        cardId: card.id,
        adId: socialAdId,
        attachments,
        meta,
        onlyThese: slideSet
      });

    } else {
      throw new Error(`Unknown mode "${mode}"`);
    }
  } catch (e) {
    console.error('Uploader error:', e.message);
    throw e;
  }

  // Preview URL (social ads)
  let previewUrl = '';
  try {
    if (socialAdId) {
      let campaignCode = mapping.campaignCode || ADPILER_CAMPAIGN_CODE_OVERRIDE || '';
      if (!campaignCode) campaignCode = await getCampaignCodeViaApi(campaignId);
      if (campaignCode) previewUrl = buildPreviewUrl({ domain: ADPILER_PREVIEW_DOMAIN, campaignCode, adId: socialAdId });
    }
  } catch (e) { console.warn('Preview URL build warning:', e.message); }

  // Trello comment
  if (postTrelloComment) {
    const lines = [];
    if (socialAdId && mode === 'post') {
      lines.push(`✅ Social POST (social-ads + 1 slide) id: ${socialAdId}, paid: ${paid ? 'true' : 'false'}.`);
    }
    if (socialAdId && mode === 'post-carousel') {
      lines.push(`✅ Social POST CAROUSEL (social-ads) id: ${socialAdId}, slides uploaded: ${uploadedCount}.`);
    }
    if (displayAdId && mode === 'display') {
      lines.push(`✅ DISPLAY 300x600 (/ads) id: ${displayAdId}.`);
    }
    lines.push('—');
    if (meta.primary)  lines.push(`Primary Text: ${meta.primary.substring(0,120)}${meta.primary.length>120?'…':''}`);
    if (meta.headline) lines.push(`Headline: ${meta.headline}`);
    if (meta.cta)      lines.push(`CTA: ${meta.cta}`);
    if (meta.url)      lines.push(`URL: ${meta.url}`);
    if (previewUrl)    lines.push(previewUrl);
    try { await postTrelloComment(card.id, lines.join('\n')); } catch {}
  }

  const out = { previewUrls: previewUrl ? [previewUrl] : [] };
  if (socialAdId) out.adId = socialAdId;
  if (displayAdId) out.displayAdId = displayAdId;
  out.mode = mode;
  return out;
}

module.exports = { uploadToAdpiler };
