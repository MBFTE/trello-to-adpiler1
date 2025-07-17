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
const PORT = 10000;

app.use(express.json());

const ADPILER_TOKEN = process.env.ADPILER_TOKEN;
const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const LABEL_NAME = 'Uploaded';
const CLIENT_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';

const downloadFile = async (url, dest) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}`);
  const fileStream = fs.createWriteStream(dest);
  await finished(response.body.pipe(fileStream));
};

const getClientMapping = async () => {
  const res = await fetch(CLIENT_CSV_URL);
  const text = await res.text();
  const rows = text.trim().split('\n').slice(1); // Skip header
  const map = {};
  for (const row of rows) {
    const [clientName, clientId] = row.split(',');
    if (clientName && clientId) map[clientName.trim()] = clientId.trim();
  }
  return map;
};

const getOrCreateLabelId = async (boardId) => {
  const labelRes = await fetch(`https://api.trello.com/1/boards/${boardId}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
  const labels = await labelRes.json();
  let label = labels.find(l => l.name === LABEL_NAME);
  if (!label) {
    const createRes = await fetch(`https://api.trello.com/1/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: LABEL_NAME, color: 'green', idBoard: boardId }),
    });
    label = await createRes.json();
  }
  return label.id;
};

const uploadToAdpiler = async (card) => {
  const mapping = await getClientMapping();
  const clientId = mapping[card.name];
  if (!clientId) throw new Error(`No AdPiler client found for "${card.name}"`);

  const attachmentRes = await fetch(`https://api.trello.com/1/cards/${card.id}/attachments?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
  const attachments = await attachmentRes.json();

  const form = new FormData();
  form.append('client', clientId);

  const fields = {
    headline: '',
    description: '',
    primaryText: '',
    cta: '',
    clickThroughUrl: ''
  };

  const cardRes = await fetch(`https://api.trello.com/1/cards/${card.id}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
  const cardData = await cardRes.json();
  const fieldsFromDesc = cardData.desc.match(/(Headline|Description|Primary Text|CTA|Click Through URL):(.+)/gi);

  if (fieldsFromDesc) {
    fieldsFromDesc.forEach(line => {
      const [key, ...rest] = line.split(':');
      const value = rest.join(':').trim();
      switch (key.trim().toLowerCase()) {
        case 'headline': fields.headline = value; break;
        case 'description': fields.description = value; break;
        case 'primary text': fields.primaryText = value; break;
        case 'cta': fields.cta = value; break;
        case 'click through url': fields.clickThroughUrl = value; break;
      }
    });
  }

  form.append('headline', fields.headline);
  form.append('description', fields.description);
  form.append('caption', fields.primaryText);
  form.append('cta', fields.cta);
  form.append('url', fields.clickThroughUrl);

  for (const attachment of attachments) {
    const url = attachment.url;
    const ext = path.extname(url).split('?')[0];
    const filename = `tmp_${Date.now()}${ext}`;
    await downloadFile(url, filename);

    const buffer = fs.readFileSync(filename);
    const type = await fileTypeFromBuffer(buffer);
    if (!type || !type.mime) {
      fs.unlinkSync(filename);
      continue;
    }

    const { width, height } = sizeOf(buffer);
    const isSocial = width === 1200 && height === 1200;
    const isDisplay = width === 300 && height === 600;
    const isAllowed = ['image/png', 'image/jpeg', 'image/gif', 'video/mp4'].includes(type.mime);

    if (isAllowed && (isSocial || isDisplay)) {
      form.append('files[]', fs.createReadStream(filename), { filename: attachment.name });
    }

    fs.unlinkSync(filename);
  }

  const res = await fetch('https://app.adpiler.com/api/v1/creatives', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADPILER_TOKEN}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`AdPiler upload failed: ${errText}`);
  }

  return true;
};

app.post('/api/upload-to-adpiler', async (req, res) => {
  try {
    const card = req.body.action?.data?.card;
    if (!card) return res.status(400).send('No card data');

    await uploadToAdpiler(card);

    const boardId = req.body.model.id;
    const labelId = await getOrCreateLabelId(boardId);

    await fetch(`https://api.trello.com/1/cards/${card.id}/idLabels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: labelId }),
    });

    console.log(`✅ Uploaded card "${card.name}" to AdPiler`);
    res.status(200).send('Uploaded to AdPiler');
  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).send('Upload failed');
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

