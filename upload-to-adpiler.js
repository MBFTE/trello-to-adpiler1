/**
 * Trello → AdPiler uploader (API mode)
 * - Single social (image/video) via POST /campaigns/{campaign}/ads   ← includes message + meta + file
 * - Carousel social via /social-ads + /slides
 * - Display 300×600 via POST /campaigns/{campaign}/ads              ← picks GIF else PNG, sets landing_page_url
 * - NEW: If a 1:1 (prefer 1200×1200) image is found, force a single social "post" (not carousel, not display)
 */

const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');
const { URL } = require('url');

// Optional (dimension verification)
let imageSize = null;
try { imageSize = require('image-size'); } catch { /* optional dep */ }

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
  ADPILER_BASE_URL
} = process.env;

const _API_BASE = (ADPILER_API_BASE || ADPILER_BASE_URL || '').trim();

function assertEnv() {
  const miss = [];
  if (!_API_BASE) miss.push('ADPILER_API_BASE (or ADPILER_BASE_URL)');
  if (!ADPILER_API_KEY) miss.push('ADPILER_API_KEY');
  if (!TRELLO_API_KEY) miss.push('TRELLO_API_KEY');
  if (!TRELLO_TOKEN) miss.push('TRELLO_TOKEN');
  if (!CLIENT_CSV_URL && !DEFAULT_CLIENT_ID) miss.push('CLIENT_CSV_URL (or set DEFAULT_CLIENT_ID)');
  if (miss.length) throw new Error(`Missing env vars: ${miss.join(', ')}`);
}

const API = (p) => `${_API_BASE.replace(/\/+$/,'')}/${String(p || '').replace(/^\/+/, '')}`;
const normalize = (s) => (s || '').toLowerCase().trim();

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
    console.warn(`CSV match for "${cardName}" missing required fields; falling back to defaults.`);
  } else {
    console.warn(`No CSV match for "${cardName}".`);
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
  let description   = pick('Description'); // keep separate; do NOT overwrite primary

  const clean = (s) => (isBlank(s) ? '' : norm(s));
  const cleanedUrl = clean(url);

  let displayLink = '';
  try {
    if (cleanedUrl) {
      const u = new URL(cleanedUrl);
      displayLink = u.hostname.replace(/^www\./, '');
    }
  } catch {}

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

// ---------- DECIDE paid + type ----------
function decidePaidAndType({ cardName, attachmentCount }) {
  const lc = normalize(cardName);
  const isStory = /\bstory\b/.test(lc);
  const isOrganic = /\borganic\b/.test(lc);
  const paidDefault = String(ADPILER_PAID_DEFAULT || 'true').toLowerCase() !== 'false';
  const paid = isOrganic ? false : !!paidDefault; // boolean

  if (!paid) { // organic
    if (isStory) {
      return attachmentCount > 1
        ? { paid, type: 'story-carousel', multiAllowed: true }
        : { paid, type: 'story',           multiAllowed: false };
    }
    return { paid, type: 'post', multiAllowed: attachmentCount > 1 };
  }

  // paid ads
  if (isStory) {
    return attachmentCount > 1
      ? { paid, type: 'story-carousel', multiAllowed: true }
      : { paid, type: 'story',           multiAllowed: false };
  }
  return attachmentCount > 1
    ? { paid, type: 'post-carousel', multiAllowed: true }
    : { paid, type: 'post',          multiAllowed: false };
}

// ---------- /ads helpers (single social + display) ----------
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

async function createSocialSingleGraphicViaAds({ campaignId, card, meta, media, type='post', paid=true }) {
  const form = new FormData();
  form.append('name', card.name);
  form.append('network', FIXED_NETWORK);
  form.append('page_name', derivePageName(card.name));
  form.append('paid', paid ? 'true' : 'false');
  form.append('type', 'post'); // ← force single post (not carousel, not story)
  if (meta?.primary)     form.append('message',         meta.primary);
  if (meta?.headline)    form.append('headline',        meta.headline);
  if (meta?.description) form.append('description',     meta.description);
  if (meta?.cta)         form.append('call_to_action',  meta.cta);
  if (meta?.url)         form.append('landing_page_url',meta.url);
  if (meta?.displayLink) form.append('display_link',    meta.displayLink);
  form.append('file', media.buffer, { filename: media.filename });
  const id = await postAdsCreate(campaignId, form);
  console.log(`✅ Social single /ads created ${id} (${media.filename})`);
  return id;
}

// DISPLAY picking utilities (kept for your 300×600 flow; won't be used for 1:1 social)
function _looks300x600(name=''){const s=(name||'').toLowerCase();return /\b300x600\b/.test(s)||/\b300\D*600\b/.test(s);}
function _isGifOrPng(name='',mime=''){const n=(name||'').toLowerCase();const m=(mime||'').toLowerCase();return n.endsWith('.gif')||n.endsWith('.png')||/image\/(gif|png)/.test(m);}
async function selectDisplay300x600Asset(cardId, attachments=[]) {
  const cand=[];
  for (const att of attachments||[]) {
    if (!att?.id || !_isGifOrPng(att.name, att.mimeType)) continue;
    try {
      const { buffer, filename } = await downloadAttachmentBuffer(cardId, att);
      let w=0,h=0;
      if (imageSize) { try { const d=imageSize(buffer); w=d?.width||0; h=d?.height||0; } catch {} }
      const okDim=(w===300&&h===600)||(w===600&&h===300);
      cand.push({ buffer, filename: filename||att.name||`asset-${att.id}`, isGif:/\.gif$/i.test(filename||att.name||''), hinted:_looks300x600(filename||att.name), okDim });
    } catch(e){ console.warn('display pick skip:', e.message); }
  }
  if (!cand.length) return null;
  cand.sort((a,b)=>{
    const A=[a.okDim?1:0,a.hinted?1:0,a.isGif?1:0,(a.filename||'').toLowerCase()];
    const B=[b.okDim?1:0,b.hinted?1:0,b.isGif?1:0,(b.filename||'').toLowerCase()];
    return (B[0]-A[0])||(B[1]-A[1])||(B[2]-A[2])||(A[3]<B[3]?-1:1);
  });
  return cand[0];
}
function extractLandingPageUrlOnly(card){
  const desc=card.desc||'';
  const grab=(label)=>{ const m = desc.match(new RegExp('^\\s*[*_~`]*' + label + '[*_~`]*\\s*:\\s*(.+)$','im')); return m?m[1].trim():''; };
  return (grab('Landing Page URL')||grab('URL')||grab('Link')||grab('Landing Page')||'').trim();
}
async function createDisplay300x600ViaAds({ campaignId, card, asset, landingUrl }) {
  const form=new FormData();
  form.append('name', card.name);
  form.append('width','300');
  form.append('height','600');
  if (landingUrl) form.append('landing_page_url', landingUrl);
  form.append('file', asset.buffer, { filename: asset.filename });
  const id = await postAdsCreate(campaignId, form);
  console.log(`✅ Display 300x600 /ads created ${id} (${asset.filename})`);
  return id;
}

// ---------- Carousel social via social-ads + slides ----------
async function createSocialAdWithMessage({ campaignId, card, paid, type, primaryText }) {
  const form = new FormData();
  form.append('name', card.name);
  form.append('network', FIXED_NETWORK);
  form.append('page_name', derivePageName(card.name));
  form.append('paid', paid ? 'true' : 'false');
  form.append('type', type);
  if (primaryText) form.append('message', primaryText);
  console.log(`Creating social (carousel-capable) → ${type}`);
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
    if (!allowMultiple && count >= 1) break;
    try {
      const { buffer, filename } = await downloadAttachmentBuffer(cardId, att);
      const res = await uploadOneSlide({ adId, fileBuf: buffer, filename: filename || `asset-${att.id}`, meta });
      uploaded.push({ attachmentId: att.id, filename: filename || att.name, result: res.raw });
      console.log(`📎 Added slide ${count + 1}: ${filename || att.name}`);
      count++;
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.warn(`⚠️ Slide upload failed for ${att.id} (${att.name || ''}): ${e.message}`);
    }
  }
  if (uploaded.length === 0 && (attachments?.length || 0) > 0) {
    throw new Error('No attachments could be uploaded (need at least one uploaded file or public URL).');
  }
  return uploaded;
}

// ---------- 1:1 social asset picking (NEW) ----------
function isLikelySquareName(name='') {
  const s = String(name).toLowerCase();
  return /\b1200x1200\b/.test(s) || /\b1\s*:\s*1\b/.test(s) || /\b1080x1080\b/.test(s) || /\bsquare\b/.test(s);
}
function isImageName(name='') {
  const n = (name||'').toLowerCase();
  return /\.(png|jpe?g|gif|webp)$/i.test(n);
}
async function pickOneToOneSocialAsset(cardId, attachments=[]) {
  const candidates = [];
  for (const att of attachments||[]) {
    if (!att?.id || !isImageName(att.name||'')) continue;
    try {
      const { buffer, filename, mimeType } = await downloadAttachmentBuffer(cardId, att);
      let w=0,h=0, exact1200=false, squareHint=isLikelySquareName(filename||att.name||'');
      if (imageSize) {
        try {
          const d=imageSize(buffer);
          w=d?.width||0; h=d?.height||0;
          exact1200 = (w===1200 && h===1200);
        } catch {}
      }
      const isSquare = exact1200 || (w>0 && h>0 && w===h);
      candidates.push({
        buffer, filename: filename||att.name||`asset-${att.id}`,
        exact1200, isSquare, squareHint,
        // simple preference for PNG/JPG over GIF for social stills:
        isPreferredStill: /\.(png|jpe?g|jpg|webp)$/i.test(filename||'')
      });
    } catch (e) {
      console.warn('1:1 pick skip:', e.message);
    }
  }
  if (!candidates.length) return null;

  // Sort: exact1200 desc → isSquare desc → squareHint desc → preferred still desc → name asc
  candidates.sort((a,b)=>{
    const A=[a.exact1200?1:0,a.isSquare?1:0,a.squareHint?1:0,a.isPreferredStill?1:0,(a.filename||'').toLowerCase()];
    const B=[b.exact1200?1:0,b.isSquare?1:0,b.squareHint?1:0,b.isPreferredStill?1:0,(b.filename||'').toLowerCase()];
    return (B[0]-A[0])||(B[1]-A[1])||(B[2]-A[2])||(B[3]-A[3])||(A[4]<B[4]?-1:1);
  });
  return candidates[0];
}

// ---------- MAIN ----------
async function uploadToAdpiler(card, attachments, { postTrelloComment } = {}) {
  assertEnv();

  // 0) mapping/campaign
  let mapping;
  try { mapping = await getClientMapping(card.name); }
  catch (e) { console.warn(`Mapping lookup failed; using defaults. ${e.message}`); mapping = { clientId: DEFAULT_CLIENT_ID, campaignId: DEFAULT_PROJECT_ID, campaignCode: '' }; }
  const campaignId = mapping.campaignId || mapping.projectId || DEFAULT_PROJECT_ID;
  if (!campaignId) throw new Error('No campaignId found (CSV "Adpiler Campaign ID" or DEFAULT_PROJECT_ID required)');

  // 1) meta + choose social path
  const meta = extractAdMetaFromCard(card);
  const { paid, type, multiAllowed } = decidePaidAndType({ cardName: card.name, attachmentCount: attachments?.length || 0 });

  let socialAdId = '';
  let uploadedSlides = [];

  // NEW PRIORITY: if a 1:1 asset exists (prefer exact 1200×1200), do a single social "post" via /ads (even if multiple attachments are on the card)
  let squareAsset = null;
  try { squareAsset = await pickOneToOneSocialAsset(card.id, attachments); } catch {}

  if (squareAsset) {
    socialAdId = await createSocialSingleGraphicViaAds({
      campaignId, card, meta, media: squareAsset, type: 'post', paid
    });
  } else if ((attachments?.length || 0) === 1 && (type === 'post' || type === 'story')) {
    // Single social via /ads (fallback: only one asset present)
    const media = await downloadAttachmentBuffer(card.id, attachments[0]); // {buffer, filename}
    socialAdId = await createSocialSingleGraphicViaAds({
      campaignId, card, meta, media, type: 'post', paid
    });
  } else {
    // Carousel social via social-ads + slides
    const { adId } = await createSocialAdWithMessage({ campaignId, card, paid, type, primaryText: meta.primary });
    socialAdId = adId;
    uploadedSlides = await uploadSlidesToAd({ cardId: card.id, adId: socialAdId, attachments, meta, allowMultiple: !!multiAllowed });
  }

  // 2) Display 300×600 (only when card/title/asset indicates display; do NOT create display when we selected 1:1 single social)
  const wantsDisplay = !squareAsset && (/\bdisplay\b/i.test(card.name) || /\b300\D*600\b/i.test(card.name));
  let displayAdId = '';
  let displayPicked = '';
  try {
    if (wantsDisplay) {
      const asset = await selectDisplay300x600Asset(card.id, attachments);
      if (!asset) throw new Error('Requested display but no 300x600 GIF/PNG found');
      displayPicked = asset.filename;
      const lp = extractLandingPageUrlOnly(card) || meta.url || '';
      displayAdId = await createDisplay300x600ViaAds({ campaignId, card, asset, landingUrl: lp });
    }
  } catch (e) {
    console.warn('DISPLAY /ads skipped:', e.message);
  }

  // 3) Preview URL for social ad
  let previewUrl = '';
  try {
    let campaignCode = mapping.campaignCode || ADPILER_CAMPAIGN_CODE_OVERRIDE || '';
    if (!campaignCode) campaignCode = await getCampaignCodeViaApi(campaignId);
    if (campaignCode) previewUrl = buildPreviewUrl({ domain: ADPILER_PREVIEW_DOMAIN, campaignCode, adId: socialAdId });
  } catch (e) { console.warn('Preview URL build warning:', e.message); }

  // 4) Trello comment
  if (postTrelloComment) {
    const lines = [];
    if (squareAsset) {
      lines.push(`✅ Social single (/ads, 1:1) created → id: ${socialAdId}, paid: ${paid ? 'true':'false'}, type: post. (file: ${squareAsset.filename})`);
    } else if ((attachments?.length || 0) === 1) {
      lines.push(`✅ Social single (/ads) created → id: ${socialAdId}, paid: ${paid ? 'true':'false'}, type: post. (file from only attachment)`);
    } else {
      lines.push(`✅ Social carousel (social-ads) created → id: ${socialAdId}, paid: ${paid ? 'true':'false'}, type: ${type}.`);
      lines.push(`   Uploaded ${uploadedSlides.length} slide(s) out of ${attachments?.length || 0}.`);
    }
    if (displayAdId)  lines.push(`✅ Display 300x600 (/ads) id: ${displayAdId}${displayPicked?` (file: ${displayPicked})`:''}.`);
    lines.push('—');
    if (meta.primary)  lines.push(`Primary Text: ${meta.primary.substring(0,120)}${meta.primary.length>120?'…':''}`);
    if (meta.headline) lines.push(`Headline: ${meta.headline}`);
    if (meta.cta)      lines.push(`CTA: ${meta.cta}`);
    if (meta.url)      lines.push(`URL: ${meta.url}`);
    if (previewUrl)    lines.push(previewUrl);
    try { await postTrelloComment(card.id, lines.join('\n')); } catch {}
  }

  const out = { adId: socialAdId, previewUrls: previewUrl ? [previewUrl] : [] };
  if (displayAdId) out.displayAdId = displayAdId;
  return out;
}

module.exports = { uploadToAdpiler };
