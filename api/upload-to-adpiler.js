// api/upload-to-adpiler.js
import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { fileTypeFromBuffer } from 'file-type';
import sizeOf from 'image-size';
import fs from 'fs';
import https from 'https';
import path from 'path';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const ADPILER_API_KEY = process.env.ADPILER_API_KEY;
const TRELLO_KEY       = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN     = process.env.TRELLO_TOKEN;
const SHEET_URL        = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const ADPILER_URL      = 'https://platform.adpiler.com/api/v1/creatives';

// download a URL (with Trello auth) into a Buffer
async function bufferFromUrl(url) {
  // append Trello auth so private attachments work
  const sep = url.includes('?') ? '&' : '?';
  const authUrl = `${url}${sep}key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(authUrl);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// read your CSV mapping Trello → Adpiler
async function getClientMap() {
  const res = await fetch(SHEET_URL);
  const csv = await res.text();
  return csv
    .trim()
    .split('\n')
    .slice(1)
    .reduce((map, line) => {
      const [name, id] = line.split(',');
      if (name && id) map[name.trim()] = id.trim();
      return map;
    }, {});
}

async function uploadToAdpiler(card, clientId, attachments) {
  if (!clientId) {
    throw new Error(`No AdPiler client found for "${card.name}"`);
  }

  const form = new FormData();
  form.append('client_id', clientId);
  form.append('headline', card.name || '');
  form.append('description', card.desc || '');

  // parse optional lines in desc
  const fields = {};
  (card.desc || '').split('\n').forEach(line => {
    const [k, ...rest] = line.split(':');
    if (k && rest.length) fields[k.trim().toLowerCase()] = rest.join(':').trim();
  });
  form.append('primary_text', fields['primary text'] || '');
  form.append('cta',          fields['cta'] || '');
  form.append('click_through_url', fields['click through url'] || '');

  // attachments
  for (const att of attachments || []) {
    const ext = path.extname(att.url).toLowerCase();
    if (!['.png','.jpg','.jpeg','.gif','.mp4'].includes(ext)) continue;

    let buffer;
    try {
      buffer = await bufferFromUrl(att.url);
    } catch (err) {
      console.error('Attachment skipped/error:', err.message);
      continue;
    }

    // check dimensions (skip if unsupported)
    let dims;
    try {
      dims = sizeOf(buffer);
    } catch {
      console.error('Unsupported file type:', ext);
      continue;
    }
    const okSize = [
      { width:1200, height:1200 },
      { width:300,  height:600 }
    ].some(s => s.width===dims.width && s.height===dims.height);
    if (!okSize) continue;

    // detect mime
    const ft = await fileTypeFromBuffer(buffer);
    form.append('files[]', buffer, { filename:`upload${ext}`, contentType: ft?.mime });
  }

  const res = await fetch(ADPILER_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ADPILER_API_KEY}` },
    body: form
  });

  if (!res.ok) {
    const text = await res.text().catch(()=>'<no body>');
    throw new Error(`AdPiler upload failed ${res.status}: ${text}`);
  }
}

async function addUploadedLabel(cardId) {
  // fetch existing labels
  const lbls = await fetch(
    `https://api.trello.com/1/cards/${cardId}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
  ).then(r=>r.json());

  let uploadedLabel = lbls.find(l=>l.name==='Uploaded');
  if (!uploadedLabel) {
    uploadedLabel = await fetch(
      `https://api.trello.com/1/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`,
      {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          name: 'Uploaded',
          color: 'green',
          idBoard: cardId
        })
      }
    ).then(r=>r.json());
  }

  // attach it to the card
  await fetch(
    `https://api.trello.com/1/cards/${cardId}/idLabels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`,
    {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ value: uploadedLabel.id })
    }
  );
}

app.post('/api/upload-to-adpiler', async (req, res) => {
  try {
    const action = req.body?.action;
    if (!action || action.type!=='updateCard' || !action.data.card) {
      return res.status(200).send('Not a card update');
    }

    const cardId = action.data.card.id;
    // fetch full card (with attachments)
    const card = await fetch(
      `https://api.trello.com/1/cards/${cardId}?attachments=true&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
    ).then(r=>r.json());

    const clientMap = await getClientMap();
    // find a CSV entry whose name appears in the card title
    const matched = Object.keys(clientMap).find(name =>
      card.name.toLowerCase().includes(name.toLowerCase())
    );
    const clientId = clientMap[matched];

    await uploadToAdpiler(card, clientId, card.attachments);
    await addUploadedLabel(cardId);

    res.status(200).send('Upload success');
  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).send(err.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});

