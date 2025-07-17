// api/upload-to-adpiler.js
import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';
import { fileTypeFromBuffer } from 'file-type';
import sizeOf from 'image-size';
import https from 'https';
import path from 'path';
import { finished } from 'stream/promises';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

const ADPILER_TOKEN   = process.env.ADPILER_TOKEN;
const TRELLO_KEY      = process.env.TRELLO_KEY;
const TRELLO_TOKEN    = process.env.TRELLO_TOKEN;
const LABEL_NAME      = 'Uploaded';
const CLIENT_CSV_URL  =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';

// Download a remote file to disk
async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}`);
  const stream = fs.createWriteStream(dest);
  await finished(res.body.pipe(stream));
}

// Read Google Sheet CSV into a mapping { "Client Name": "ID", ... }
async function getClientMapping() {
  const res = await fetch(CLIENT_CSV_URL);
  const text = await res.text();
  return text
    .trim()
    .split('\n')
    .slice(1) // skip header
    .reduce((map, line) => {
      const [name, id] = line.split(',');
      if (name && id) map[name.trim()] = id.trim();
      return map;
    }, {});
}

// Ensure the “Uploaded” label exists on the board, return its ID
async function getOrCreateLabelId(boardId) {
  const lst = await fetch(
    `https://api.trello.com/1/boards/${boardId}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
  ).then(r => r.json());

  let label = lst.find(l => l.name === LABEL_NAME);
  if (!label) {
    label = await fetch(
      `https://api.trello.com/1/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: LABEL_NAME,
          color: 'green',
          idBoard: boardId
        })
      }
    ).then(r => r.json());
  }
  return label.id;
}

// Push card data + valid attachments to AdPiler
async function uploadToAdpiler(card) {
  const mapping = await getClientMapping();
  // match by prefix (case-insensitive)
  const clientKey = Object.keys(mapping).find(key =>
    card.name.toLowerCase().startsWith(key.toLowerCase())
  );
  if (!clientKey) {
    throw new Error(`No AdPiler client found for "${card.name}"`);
  }
  const clientId = mapping[clientKey];

  // fetch full card data + attachments
  const full = await fetch(
    `https://api.trello.com/1/cards/${card.id}?attachments=true&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
  ).then(r => r.json());

  // build form
  const form = new FormData();
  form.append('client', clientId);

  // parse description fields
  const fields = {
    headline: '',
    description: '',
    'primary text': '',
    cta: '',
    'click through url': ''
  };
  (full.desc || '')
    .split('\n')
    .forEach(line => {
      const [k, ...rest] = line.split(':');
      if (k && rest.length) fields[k.trim().toLowerCase()] = rest.join(':').trim();
    });

  form.append('headline', fields.headline);
  form.append('description', fields.description);
  form.append('caption', fields['primary text']);
  form.append('cta', fields.cta);
  form.append('url', fields['click through url']);

  // handle attachments
  for (const att of full.attachments || []) {
    const ext = path.extname(att.url).split('?')[0].toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.gif', '.mp4'].includes(ext)) continue;

    const tmpFile = `tmp_${Date.now()}${ext}`;
    await downloadFile(att.url, tmpFile);

    const buffer = fs.readFileSync(tmpFile);
    const ft = await fileTypeFromBuffer(buffer);
    fs.unlinkSync(tmpFile);
    if (!ft || !ft.mime) continue;

    const { width, height } = sizeOf(buffer);
    const isSocial = width === 1200 && height === 1200;
    const isDisplay = width === 300 && height === 600;
    const allowedMime = ['image/png', 'image/jpeg', 'image/gif', 'video/mp4'];

    if (allowedMime.includes(ft.mime) && (isSocial || isDisplay)) {
      form.append('files[]', buffer, { filename: att.name, contentType: ft.mime });
    }
  }

  // send to AdPiler
  const resp = await fetch('https://app.adpiler.com/api/v1/creatives', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADPILER_TOKEN}` },
    body: form
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`AdPiler upload failed: ${txt}`);
  }
}

// webhook endpoint
app.post('/api/upload-to-adpiler', async (req, res) => {
  try {
    const card = req.body.action?.data?.card;
    const boardId = req.body.model?.id;
    if (!card || !boardId) return res.status(400).send('Invalid webhook payload');

    await uploadToAdpiler(card);
    const labelId = await getOrCreateLabelId(boardId);

    // attach “Uploaded” label
    await fetch(
      `https://api.trello.com/1/cards/${card.id}/idLabels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: labelId })
      }
    );

    console.log(`✅ "${card.name}" uploaded and labeled`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).send('Upload failed');
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

