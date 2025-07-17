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

// must be set in your Render environment
const ADPILER_API_KEY = process.env.ADPILER_API_KEY;
const TRELLO_API_KEY   = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN     = process.env.TRELLO_TOKEN;
const SHEET_URL        = process.env.SHEET_URL || 
  'https://docs.google.com/spreadsheets/d/e/…/pub?output=csv';

// download an attachment, injecting Trello auth to avoid 401
async function bufferFromUrl(url) {
  const authUrl = `${url}${url.includes('?') ? '&' : '?'}key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  return new Promise((resolve, reject) => {
    https.get(authUrl, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// build a map of Trello‐name → Adpiler campaign ID
async function getClientMap() {
  const resp = await fetch(SHEET_URL);
  const csv  = await resp.text();
  return csv
    .split('\n')
    .slice(1)
    .reduce((map, line) => {
      const [name, id] = line.split(',');
      if (name && id) map[name.trim().toLowerCase()] = id.trim();
      return map;
    }, {});
}

// upload each valid attachment as an “ad” to Adpiler
async function uploadToAdpiler(card, campaignId, attachments) {
  for (const att of attachments) {
    try {
      // only images/videos we support
      const buffer = await bufferFromUrl(att.url);
      const type   = await fileTypeFromBuffer(buffer);
      if (!type) throw new Error('could not detect file type');

      const { width, height } = sizeOf(buffer);
      // Adpiler only accepts exact sizes—skip otherwise
      const okSizes = [
        { width: 1200, height: 1200 },
        { width: 300,  height: 600  }
      ];
      if (!okSizes.some(s => s.width===width && s.height===height)) {
        console.log(`Skipping ${att.url}: ${width}x${height} not allowed`);
        continue;
      }

      // assemble form for /campaigns/{campaign}/ads
      const endpoint = `https://platform.adpiler.com/api/campaigns/${campaignId}/ads`;
      const form = new FormData();
      form.append('name',            card.name);
      form.append('width',           width);
      form.append('height',          height);
      form.append('max_width',       width);
      form.append('max_height',      height);
      form.append('responsive_width','false');
      form.append('responsive_height','false');
      form.append('file', buffer, {
        filename: path.basename(att.url),
        contentType: type.mime
      });

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'X-API-KEY': ADPILER_API_KEY,
          ...form.getHeaders()
        },
        body: form
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Adpiler upload failed ${res.status}: ${body}`);
      }

      console.log(`✅ Uploaded ${att.url} to campaign ${campaignId}`);
    } catch (err) {
      console.error(`Attachment skipped/error for ${att.url}:`, err.message);
    }
  }
}

// add a green “Uploaded” label back on Trello
async function addUploadedLabel(cardId) {
  // fetch existing labels on board
  const list = await fetch(
    `https://api.trello.com/1/cards/${cardId}/labels?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
  ).then(r => r.json());

  let label = list.find(l => l.name==='Uploaded');
  if (!label) {
    label = await fetch(
      `https://api.trello.com/1/labels?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`,
      {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          name: 'Uploaded',
          color: 'green',
          idBoard: cardId
        })
      }
    ).then(r => r.json());
  }

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
    const action = req.body.action;
    if (!action || action.type !== 'updateCard' || !action.data?.card) {
      return res.status(200).send('Not a card update');
    }

    const cardId = action.data.card.id;
    // fetch full card with attachments
    const card = await fetch(
      `https://api.trello.com/1/cards/${cardId}` +
      `?attachments=true&key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
    ).then(r => r.json());

    // find matching campaign ID
    const clients = await getClientMap();
    const matchKey = Object.keys(clients)
      .find(k => card.name.toLowerCase().includes(k));
    if (!matchKey) {
      throw new Error(`No Adpiler client found for "${card.name}"`);
    }
    const campaignId = clients[matchKey];

    await uploadToAdpiler(card, campaignId, card.attachments || []);
    await addUploadedLabel(cardId);
    res.status(200).send('Upload complete');
  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).send(err.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});
