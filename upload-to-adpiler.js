const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');

const ADPILER_API_KEY = process.env.ADPILER_API_KEY;
const ADPILER_BASE_URL = process.env.ADPILER_BASE_URL; // e.g., https://platform.adpiler.com/api
const CLIENT_CSV_URL = process.env.CLIENT_CSV_URL;
const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;

function assertEnv() {
  const miss = [];
  if (!ADPILER_API_KEY) miss.push('ADPILER_API_KEY');
  if (!ADPILER_BASE_URL) miss.push('ADPILER_BASE_URL');
  if (!CLIENT_CSV_URL) miss.push('CLIENT_CSV_URL');
  if (!TRELLO_API_KEY) miss.push('TRELLO_API_KEY');
  if (!TRELLO_TOKEN) miss.push('TRELLO_TOKEN');
  if (miss.length) throw new Error(`Missing env vars: ${miss.join(', ')}`);
}

async function getClientMapping(cardName) {
  const res = await fetch(CLIENT_CSV_URL);
  if (!res.ok) throw new Error(`Mapping CSV fetch failed (${res.status})`);
  const rows = await csv().fromString(await res.text());
  const norm = s => (s || '').toLowerCase().trim();
  const match = rows.find(r => norm(cardName).includes(norm(r['Trello Client Name'])));
  if (!match) throw new Error(`No client mapping found for card name "${cardName}"`);
  if (!match.clientId) throw new Error(`Mapping row missing clientId for "${match['Trello Client Name']}"`);
  return { clientId: match.clientId, projectId: match.projectId || '' };
}

async function downloadAttachmentBuffer(attachmentId) {
  const auth = `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const dlUrl = `https://api.trello.com/1/attachments/${attachmentId}/download?${auth}`;
  const res = await fetch(dlUrl);
  if (!res.ok) throw new Error(`Failed to download attachment ${attachmentId} (${res.status})`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function extractAdMetaFromCard(card) {
  const desc = card.desc || '';
  const grab = (label) => {
    const m = desc.match(new RegExp(`${label}:\\s*(.+)`, 'i'));
    return m ? m[1].trim() : '';
  };
  return {
    headline: grab('Headline'),
    description: grab('Description'),
    cta: grab('CTA'),
    url: grab('URL')
  };
}

async function postFormWithRetry(url, headers, form, maxAttempts = 4) {
  let attempt = 0; let lastErr;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      const resp = await fetch(url, { method: 'POST', headers, body: form });
      const text = await resp.text();
      let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
      if (resp.ok) return json;
      if (resp.status >= 500) {
        const delay = 400 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
        console.warn(`AdPiler ${resp.status} attempt ${attempt}/${maxAttempts}; retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`AdPiler error ${resp.status}: ${text}`);
    } catch (e) {
      lastErr = e;
      const delay = 400 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
      if (attempt < maxAttempts) {
        console.warn(`AdPiler request failed (attempt ${attempt}/${maxAttempts}): ${e.message}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr || new Error('AdPiler upload failed after retries');
}

async function uploadSingleAsset({ mapping, meta, card, attachment }) {
  const fileBuf = await downloadAttachmentBuffer(attachment.id);
  const filename = attachment.name || `asset-${attachment.id}`;

  const form = new FormData();
  form.append('client_id', mapping.clientId);
  if (mapping.projectId) form.append('project_id', mapping.projectId);
  form.append('name', card.name || filename);
  form.append('headline', meta.headline || '');
  form.append('description', meta.description || '');
  form.append('cta', meta.cta || '');
  form.append('click_url', meta.url || '');
  form.append('file', fileBuf, { filename });

  const url = `${ADPILER_BASE_URL.replace(/\/+$/,'')}/ads/upload`;
  const headers = { 'Authorization': `Bearer ${ADPILER_API_KEY}` };

  const json = await postFormWithRetry(url, headers, form);
  const previewUrls = [];
  if (json.preview_url) previewUrls.push(json.preview_url);
  if (Array.isArray(json.links)) json.links.forEach(l => { if (l && typeof l === 'string') previewUrls.push(l); });
  if (Array.isArray(json.preview_urls)) json.preview_urls.forEach(l => { if (l && typeof l === 'string') previewUrls.push(l); });

  return { previewUrls, raw: json };
}

async function uploadToAdpiler(card, attachments, { postTrelloComment } = {}) {
  assertEnv();

  const mapping = await getClientMapping(card.name);
  const meta = extractAdMetaFromCard(card);

  const previewUrls = [];
  const files = (attachments || []).filter(a => a && a.id);

  if (!files.length) {
    console.warn('No attachments found on card; nothing to upload.');
    if (postTrelloComment) await postTrelloComment(card.id, 'No attachments found to upload to AdPiler.');
    return { previewUrls: [] };
    }

  for (const att of files) {
    try {
      const { previewUrls: urls } = await uploadSingleAsset({ mapping, meta, card, attachment: att });
      if (urls.length) previewUrls.push(...urls);
    } catch (e) {
      console.error(`Upload failed for ${att.name || att.id}:`, e.message);
      if (postTrelloComment) {
        await postTrelloComment(card.id, `⚠️ AdPiler upload failed for ${att.name || att.id}: ${e.message}`);
      }
    }
  }

  return { previewUrls };
}

module.exports = { uploadToAdpiler };
