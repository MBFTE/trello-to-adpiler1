// api/upload-to-adpiler.js

import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import csv from 'csvtojson';
import sizeOf from 'image-size';
import { fileTypeFromBuffer } from 'file-type';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const CLIENT_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const ADPILER_API_KEY = process.env.ADPILER_API_KEY;
const ADPILER_BASE_URL = process.env.ADPILER_BASE_URL || 'https://platform.adpiler.com/api';
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;

let clientMap = {};

async function loadClientMap() {
  const res = await fetch(CLIENT_CSV_URL);
  if (!res.ok) throw new Error(`Failed to fetch client CSV: ${res.status}`);
  const text = await res.text();
  const rows = await csv().fromString(text);
  rows.forEach(r => {
    clientMap[r['Trello Client Name'].trim()] = r['Adpiler Client ID'].trim();
  });
  console.log('Loaded client map:', clientMap);
}

await loadClientMap();

async function bufferFromUrl(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TRELLO_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  return await res.buffer();
}

async function uploadFileToAdpiler({ campaignId, name, buffer }) {
  const type = await fileTypeFromBuffer(buffer);
  if (!type) throw new Error('Unsupported file type: cannot determine MIME');

  const { width, height } = sizeOf(buffer);

  const form = new FormData();
  form.append('name', name);
  form.append('width', width);
  form.append('height', height);
  form.append('file', buffer, {
    filename: `${name}.${type.ext}`,
    contentType: type.mime,
  });

  const res = await fetch(`${ADPILER_BASE_URL}/campaigns/${campaignId}/ads`, {
    method: 'POST',
    headers: { 'X-API-KEY': ADPILER_API_KEY },
    body: form
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AdPiler upload failed ${res.status}: ${text}`);
  }

  return res.json();
}

app.post('/upload-to-adpiler', async (req, res) => {
  try {
    const card = req.body.action.data.card;
    const cardName = card.name;
    const clientKey = cardName.split(':')[0].trim();
    const clientId = clientMap[clientKey];
    if (!clientId) throw new Error(`No Adpiler client found for "${clientKey}"`);

    const attachments = card.attachments || [];
    for (const att of attachments) {
      try {
        const buf = await bufferFromUrl(att.url);
        await uploadFileToAdpiler({ campaignId: clientId, name: cardName, buffer: buf });
        console.log('Uploaded attachment:', att.url);
      } catch (e) {
        console.error('Attachment skipped/error:', e.message);
      }
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));

