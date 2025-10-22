/**
 * Trello → AdPiler uploader (API mode)
 * - Reads Trello-parsed card meta and uploads to AdPiler via REST
 * - Uses Primary Text as the ad-level "message"
 * - Respects "Description: LEAVE BLANK" (omits slide description)
 * - Normalizes CTA to uppercase_with_underscores
 * - Derives display_link from Click Through URL
 */

const FormData = require('form-data');
const axios = require('axios');

const API_BASE = (process.env.ADPILER_API_BASE || process.env.ADPILER_BASE_URL || 'https://platform.adpiler.com/api').replace(/\/+$/,''); 
const API_KEY  = process.env.ADPILER_API_KEY;

/**
 * Utility: normalize CTA (e.g., "Shop Now" -> "SHOP_NOW")
 */
function normalizeCta(v) {
  return (v || '').toString().trim().toUpperCase().replace(/\s+/g, '_');
}

/**
 * Utility: get domain from url for display_link
 */
function toDisplayLink(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./,''); 
  } catch {
    return '';
  }
}

/**
 * Extract metadata from a Trello card object that your code passes in.
 * We treat "Primary Text" as ad-level message ONLY; Description may be left blank.
 * "pick" is a helper that should search checklist/body by label precedence.
 */
function extractAdMetaFromCard(card, pick) {
  const primary    = pick('Primary Text', 'Primary');
  const headline   = pick('Headline', 'Title');
  let description  = pick('Description');
  const ctaRaw     = pick('Call To Action', 'CTA');
  let url          = pick('Click Through URL', 'Landing Page URL', 'URL', 'Link');

  if (!url && card && card.desc) {
    const m = card.desc.match(/Click Through URL:\s*(.+)/i);
    if (m) url = m[1].trim();
  }

  // Respect LEAVE BLANK for slide description
  if (/^(leave\s*blank|null|none|n\/a|na)$/i.test((description || '').trim())) {
    description = '';
  }

  return {
    headline: (headline || '').trim(),
    description: (description || '').trim(),       // slide-level
    message: (primary || '').trim(),               // ad-level
    cta: normalizeCta(ctaRaw),
    url: url || '',
    displayLink: toDisplayLink(url)
  };
}

/**
 * Ensure ad-level message (Primary Text) is set
 */
async function ensureAdMessage({ adId, message }) {
  if (!message) return;
  try {
    const resp = await axios.patch(`${API_BASE}/social-ads/${adId}`, 
      { message },
      { headers: { Authorization: `Bearer ${API_KEY}`, accept: 'application/json' } }
    );
    return resp.data;
  } catch (e) {
    console.warn('ensureAdMessage failed', e.response?.status, e.response?.data || e.message);
  }
}

/**
 * Upload a single slide with creative + fields
 */
async function uploadOneSlide({ adId, fileBuf, filename, meta }) {
  const form = new FormData();
  if (meta.cta)         form.append('call_to_action', meta.cta);
  if (meta.displayLink) form.append('display_link',   meta.displayLink);
  if (meta.headline)    form.append('headline',       meta.headline);
  if (meta.description) form.append('description',    meta.description);
  if (meta.url)         form.append('landing_page_url', meta.url);
  form.append('media_file', fileBuf, filename);

  const resp = await axios.post(`${API_BASE}/social-ads/${adId}/slides`, form, {
    headers: { Authorization: `Bearer ${API_KEY}`, ...form.getHeaders(), accept: 'application/json' }
  });
  return resp.data;
}

/**
 * Public entry: uploadToAdpiler(card, attachments, helpers)
 * - card: Trello card object (must include .name, .desc)
 * - attachments: array of {name, url, buffer}
 * - helpers: { pickFromCard, createAdReturnId }
 *   - pickFromCard(labelA, labelB, ...) should search checklist/body by label
 *   - createAdReturnId() must create or fetch the social ad and return { adId }
 */
async function uploadToAdpiler(card, attachments, { pickFromCard, createAdReturnId } = {}) {
  if (!API_KEY) throw new Error('Missing ADPILER_API_KEY');

  // pick helper default
  const pick = pickFromCard || ((...labels) => {
    const body = card?.desc || '';
    for (const lab of labels) {
      const m = body.match(new RegExp(`${lab}:\\s*(.+)`, 'i'));
      if (m) return m[1].trim();
    }
    return '';
  });

  const meta = extractAdMetaFromCard(card, pick);

  // create/get ad id via provided helper
  const { adId } = await (createAdReturnId ? createAdReturnId(card, meta) : Promise.resolve({ adId: card.adId || card.id }));
  if (!adId) throw new Error('No adId provided/created');

  // Set ad message first so preview updates
  await ensureAdMessage({ adId, message: meta.message });

  // 1 valid creative only (first image/video)
  const valid = attachments.find(a => /\.(png|jpe?g|gif|mp4)$/i.test(a.name || ''));
  if (!valid) throw new Error('No valid attachment (.png/.jpg/.gif/.mp4)');
  const buf = valid.buffer;
  const filename = valid.name || 'creative';

  // Upload slide
  const slide = await uploadOneSlide({ adId, fileBuf: buf, filename, meta });
  return { adId, slide, meta };
}

module.exports = { uploadToAdpiler, extractAdMetaFromCard, normalizeCta, toDisplayLink };
module.exports.default = uploadToAdpiler;
