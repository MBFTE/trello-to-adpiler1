/**
 * Trello → AdPiler uploader
 * Supports both:
 *  - ONE multi-slide ad (if tenant accepts a multi type), OR
 *  - Fallback: one POST ad per image when multi types are rejected.
 */

const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');
const { URL } = require('url');

// ---------- FIXED VALUES ----------
const FIXED_NETWORK = 'facebook';
const POST_TYPE = 'post';
const MULTI_TYPE_CANDIDATES = ['carousel', 'album', 'multi', 'gallery', 'slideshow'];
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
  let row = rows.find(r => lcCard.includes(normalize(r['Trello Client Name'])));
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

// ---------- HTTP (with retries) ----------
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
      throw new Error(`AdPiler ${resp.status} on ${path}: ${text}`);
    } catch (e) {
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

// ---------- AdPiler: Create ----------
async function tryCreateAd({ campaignId, card, typeVal }) {
  const form = new FormData();
  form.append('name', card.name);
  form.append('network', FIXED_NETWORK);
  form.append('type', typeVal);
  form.append('page_name', derivePageName(card.name));

  console.log(`Creating social ad → campaign=${campaignId}, name="${card.name}", network=${FIXED_NETWORK}, type=${typeVal}, page_name="${derivePageName(card.name)}"`);
  const json = await postForm(`campaigns/${encodeURIComponent(campaignId)}/social-ads`, form);
  const adId = json.id || json.adId || json.data?.id;
  if (!adId) throw new Error(`Create social-ad did not return an ad id. Response keys: ${Object.keys(json)}`);
  return { adId, raw: json, typeUsed: typeVal };
}

async function createBestAd({ campaignId, card, wantMulti }) {
  if (wantMulti) {
    for (const t of MULTI_TYPE_CANDIDATES) {
      try {
        const made = await tryCreateAd({ campaignId, card, typeVal: t });
        made.supportsMulti = true; // by design, these types are multi
        return made;
      } catch (e) {
        const msg = String(e?.message || '').toLowerCase();
        if (msg.includes('selected type is invalid') || msg.includes('"type"') && msg.includes('invalid')) {
          console.warn(`Type "${t}" rejected by tenant; trying next candidate...`);
          continue;
        }
        throw e; // other error—bubble up
      }
    }
    console.warn('All multi-slide types rejected; falling back to "post" (one slide per ad).');
  }
  const made = await tryCreateAd({ campaignId, card, typeVal: POST_TYPE });
  made.supportsMulti = false;
  return made;
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

async function uploadSlidesToAd({ cardId, adId, attachments, meta }) {
  const allPreviewUrls = [];
  let successCount = 0;

  const sorted = (attachments || []).slice().sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' })
  );

  for (const att of sorted) {
    if (!att || !att.id) continue;
    try {
      const { buffer, filename } = await downloadAttachmentBuffer(cardId, att);
      const urls = await uploadOneSlide({ adId, fileBuf: buffer, filename: filename || `asset-${att.id}`, meta });
      allPreviewUrls.push(...(urls || []));
      successCount++;
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.warn(`⚠️ Slide upload failed for ${att.id} (${att.name || ''}): ${e.message}`);
      // If API enforces "only 1 slide" on this type, it will error here.
      const msg = String(e?.message || '').toLowerCase();
      if (msg.includes("can't have more than 1 slide") || msg.includes('more than 1 slide')) {
        throw new Error('SINGLE_SLIDE_LIMIT');
      }
    }
  }

  return { previewUrls: allPreviewUrls, successCount };
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

  const meta = extractAdMetaFromCard(card);
  const wantMulti = (attachments && attachments.length > 1) || /carousel/i.test(card.name);

  // 1) Create the best possible ad for this card
  const { adId, typeUsed, supportsMulti } = await createBestAd({ campaignId, card, wantMulti });

  let createdAdsSummary = [`Ad ${adId} (type: ${typeUsed || (supportsMulti ? 'multi' : 'post')})`];
  let previewUrls = [];

  if (!supportsMulti) {
    // Tenant rejected all multi types → create one POST per image (fallback)
    if (wantMulti && (attachments?.length || 0) > 1) {
      console.warn('Multi not supported; creating one POST per image as fallback.');
      const created = [];
      for (const att of (attachments || [])) {
        try {
          // Fresh ad for this image
          const single = await tryCreateAd({ campaignId, card, typeVal: POST_TYPE });
          const { buffer, filename } = await downloadAttachmentBuffer(card.id, att);
          const urls = await uploadOneSlide({ adId: single.adId, fileBuf: buffer, filename: filename || att.name || `asset-${att.id}`, meta });
          created.push({ adId: single.adId, filename: filename || att.name, previewUrls: urls });
          previewUrls.push(...(urls || []));
          await new Promise(r => setTimeout(r, 200));
        } catch (e) {
          console.warn(`⚠️ Fallback POST creation/upload failed for attachment ${att.id}: ${e.message}`);
        }
      }
      createdAdsSummary = created.map(c => `Ad ${c.adId}${c.filename ? ` (${c.filename})` : ''}`);
    } else {
      // Single attachment → just upload to the one POST we made above
      const { previewUrls: urls } = await uploadSlidesToAd({ cardId: card.id, adId, attachments, meta });
      previewUrls.push(...(urls || []));
    }
  } else {
    // Multi supported → upload all slides to the single ad
    try {
      const { previewUrls: urls } = await uploadSlidesToAd({ cardId: card.id, adId, attachments, meta });
      previewUrls.push(...(urls || []));
    } catch (e) {
      if (e.message === 'SINGLE_SLIDE_LIMIT') {
        // Server still enforced single-slide; do fallback posts for remaining files
        console.warn('Server enforced single-slide on purported multi ad; creating POSTs for remaining files.');
        const remaining = (attachments || []).slice(1);
        for (const att of remaining) {
          try {
            const single = await tryCreateAd({ campaignId, card, typeVal: POST_TYPE });
            const { buffer, filename } = await downloadAttachmentBuffer(card.id, att);
            const urls = await uploadOneSlide({ adId: single.adId, fileBuf: buffer, filename: filename || att.name || `asset-${att.id}`, meta });
            createdAdsSummary.push(`Ad ${single.adId}${filename ? ` (${filename})` : ''}`);
            previewUrls.push(...(urls || []));
          } catch (err) {
            console.warn(`⚠️ Fallback POST creation/upload failed for attachment ${att.id}: ${err.message}`);
          }
          await new Promise(r => setTimeout(r, 200));
        }
      } else {
        throw e;
      }
    }
  }

  // 3) Comment back to Trello
  if (postTrelloComment) {
    const lines = [];
    if (createdAdsSummary.length === 1) {
      lines.push(`Created AdPiler ad ${createdAdsSummary[0]} and uploaded ${attachments?.length || 0} attachment(s).`);
    } else {
      lines.push(`Created ${createdAdsSummary.length} AdPiler ad(s):`);
      for (const s of createdAdsSummary) lines.push(`• ${s}`);
      lines.push(`Uploaded ${attachments?.length || 0} attachment(s) in total.`);
    }
    if (previewUrls?.length) lines.push(previewUrls.join('\n'));
    try { await postTrelloComment(card.id, lines.join('\n')); } catch {}
  }

  return { adId, previewUrls };
}

// Export both named and default to be safe with require()
module.exports = { uploadToAdpiler };
module.exports.default = uploadToAdpiler;
