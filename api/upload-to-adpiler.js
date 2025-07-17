// api/upload-to-adpiler.js
import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import sizeOf from 'image-size';
import { fileTypeFromBuffer } from 'file-type';
import path from 'path';

const app = express();
app.use(express.json());

const PORT             = process.env.PORT || 10000;
const ADPILER_API_KEY  = process.env.ADPILER_API_KEY;
const TRELLO_API_KEY   = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN     = process.env.TRELLO_TOKEN;
const SHEET_URL        = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const ADPILER_ENDPOINT = 'https://platform.adpiler.com/api/v1/creatives';

// Fetch and parse client → ID map from the published CSV
async function getClientMap() {
  const res = await fetch(SHEET_URL);
  const csv = await res.text();
  return Object.fromEntries(
    csv.trim().split('\n').slice(1)
      .map(line => line.split(',').map(s=>s.trim()))
      .filter(([name,id])=>name && id)
  );
}

// Upload the card’s data + attachments to AdPiler
async function uploadToAdpiler(card, clientId) {
  const form = new FormData();
  form.append('client_id', clientId);
  form.append('headline',     card.name || '');
  form.append('description',  card.desc || '');

  // extract “primary text”, “cta”, “click through url” from the card.desc (newline‑separated key: value)
  const extra = {};
  (card.desc||'').split('\n').forEach(l => {
    const i = l.indexOf(':');
    if (i>0) extra[l.slice(0,i).trim().toLowerCase()] = l.slice(i+1).trim();
  });
  form.append('primary_text',       extra['primary text']       || '');
  form.append('cta',                extra['cta']                || '');
  form.append('click_through_url',  extra['click through url']  || '');

  const allowedExt = ['.png','.jpg','.jpeg','.gif','.mp4'];
  const validSizes = [{w:1200,h:1200},{w:300,h:600}];

  for (const at of card.attachments || []) {
    const url = at.url;
    const ext = path.extname(url).toLowerCase();
    if (!allowedExt.includes(ext)) continue;

    // append your key/token so Trello will let us fetch it
    const sep   = url.includes('?') ? '&' : '?';
    const dlUrl = `${url}${sep}key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
    const resp  = await fetch(dlUrl);
    if (!resp.ok) { console.error('Attachment skipped/error:', resp.status); continue; }
    const buffer = await resp.buffer();

    // skip size‑check on MP4 (image‑size can’t parse video), otherwise enforce 1200×1200 or 300×600
    let ok = ext === '.mp4';
    if (!ok) {
      try {
        const { width, height } = sizeOf(buffer);
        ok = validSizes.some(s=>s.w===width && s.h===height);
      } catch(e) {
        console.error('Size check failed:', e);
      }
    }
    if (!ok) continue;

    const ft   = await fileTypeFromBuffer(buffer);
    const mime = ft?.mime || (ext==='.mp4'?'video/mp4':'application/octet-stream');
    const name = `${at.id}${ext}`;
    form.append('files[]', buffer, { filename: name, contentType: mime });
  }

  const apiRes = await fetch(ADPILER_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADPILER_API_KEY}` },
    body: form
  });
  if (!apiRes.ok) {
    const text = await apiRes.text();
    throw new Error(`AdPiler upload failed ${apiRes.status}: ${text}`);
  }
}

// Add (or create + add) a green “Uploaded” label on the card
async function addUploadedLabel(cardId, boardId) {
  // fetch all board labels
  const lblRes = await fetch(
    `https://api.trello.com/1/boards/${boardId}/labels?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
  );
  const labels = await lblRes.json();
  let label = labels.find(l=>l.name==='Uploaded');
  if (!label) {
    const create = await fetch(
      `https://api.trello.com/1/labels?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`,
      {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ idBoard: boardId, name: 'Uploaded', color: 'green' })
      }
    );
    label = await create.json();
  }
  // attach it to the card
  await fetch(
    `https://api.trello.com/1/cards/${cardId}/idLabels?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`,
    {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ value: label.id })
    }
  );
}

app.post('/api/upload-to-adpiler', async (req, res) => {
  try {
    const act = req.body.action;
    if (!act?.data?.card) return res.status(200).send('No card data');
    const cardId = act.data.card.id;

    // fetch full card (including attachments & board)
    const cardRes = await fetch(
      `https://api.trello.com/1/cards/${cardId}?attachments=true&key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
    );
    const card    = await cardRes.json();

    // build client map + match
    const clients = await getClientMap();
    const match   = Object.keys(clients)
                         .find(k=>card.name.toLowerCase().includes(k.toLowerCase()));
    if (!match) throw new Error(`No AdPiler client found for "${card.name}"`);

    // do the upload + label
    await uploadToAdpiler(card, clients[match]);
    await addUploadedLabel(cardId, card.idBoard);

    res.status(200).send('Uploaded successfully');
  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).send('Upload failed');
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));

