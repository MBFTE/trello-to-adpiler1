import express from 'express';
import fetch from 'node-fetch';
import { google } from 'googleapis';
import { createRequire } from 'module';
import sizeOf from 'image-size';
import fileType from 'file-type';
import fs from 'fs';
import https from 'https';
import path from 'path';

const require = createRequire(import.meta.url);
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;

const ADPILER_API_KEY = process.env.ADPILER_API_KEY;
const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';

const downloadFile = (url, dest) => {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, response => {
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', reject);
  });
};

const getClientMap = async () => {
  const res = await fetch(SHEET_URL);
  const csv = await res.text();
  const rows = csv.split('\n').slice(1);
  const map = {};
  rows.forEach(row => {
    const [clientName, clientId] = row.split(',');
    if (clientName && clientId) {
      map[clientName.trim()] = clientId.trim();
    }
  });
  return map;
};

const uploadToAdpiler = async (card, clientId, attachments) => {
  const formData = new FormData();
  formData.append('client_id', clientId);
  formData.append('headline', card.name || '');
  formData.append('description', card.desc || '');

  const fields = {};
  (card.desc || '').split('\n').forEach(line => {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) {
      fields[key.trim().toLowerCase()] = rest.join(':').trim();
    }
  });

  formData.append('primary_text', fields['primary text'] || '');
  formData.append('cta', fields['cta'] || '');
  formData.append('click_through_url', fields['click through url'] || '');

  for (const attachment of attachments) {
    const ext = path.extname(attachment.url).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.gif', '.mp4'].includes(ext)) continue;

    const filename = `temp_${Date.now()}${ext}`;
    await downloadFile(attachment.url, filename);

    const buffer = fs.readFileSync(filename);
    const dimensions = ext === '.mp4' ? { width: 1200, height: 1200 } : sizeOf(buffer);

    const validSizes = [
      { width: 1200, height: 1200 },
      { width: 300, height: 600 }
    ];

    const isValidSize = validSizes.some(s => s.width === dimensions.width && s.height === dimensions.height);
    if (!isValidSize) {
      fs.unlinkSync(filename);
      continue;
    }

    const type = await fileType.fromBuffer(buffer);
    formData.append('files[]', buffer, { filename, contentType: type?.mime });
    fs.unlinkSync(filename);
  }

  const res = await fetch('https://api.adpiler.com/v1/creatives', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ADPILER_API_KEY}`,
    },
    body: formData
  });

  return res.ok;
};

const addUploadedLabel = async (cardId) => {
  const labelRes = await fetch(`https://api.trello.com/1/cards/${cardId}/labels?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`);
  const labels = await labelRes.json();
  let labelId = labels.find(l => l.name === 'Uploaded')?.id;

  if (!labelId) {
    const createLabelRes = await fetch(`https://api.trello.com/1/labels?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Uploaded',
        color: 'green',
        idBoard: cardId
      })
    });
    const newLabel = await createLabelRes.json();
    labelId = newLabel.id;
  }

  await fetch(`https://api.trello.com/1/cards/${cardId}/idLabels?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: labelId })
  });
};

app.post('/api/upload-to-adpiler', async (req, res) => {
  try {
    const action = req.body.action;
    if (!action || action.type !== 'updateCard' || !action.data?.card) {
      return res.status(200).send('Not a card update action');
    }

    const cardId = action.data.card.id;
    const cardRes = await fetch(`https://api.trello.com/1/cards/${cardId}?attachments=true&key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`);
    const card = await cardRes.json();

    const clientMap = await getClientMap();
    const matchedClient = Object.keys(clientMap).find(name => card.name.toLowerCase().includes(name.toLowerCase()));
    const clientId = matchedClient ? clientMap[matchedClient] : null;

    if (!clientId) return res.status(400).send('Client not matched');

    const uploaded = await uploadToAdpiler(card, clientId, card.attachments || []);
    if (uploaded) await addUploadedLabel(cardId);

    res.status(200).send('Upload success');
  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).send('Upload failed');
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
