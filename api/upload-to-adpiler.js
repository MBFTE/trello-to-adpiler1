
import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import sharp from 'sharp';
import { createWriteStream, promises as fs } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import https from 'https';
import sizeOf from 'image-size';
import { fileTypeFromFile } from 'file-type';

const app = express();
const port = 10000;
app.use(express.json());

const GOOGLE_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const ADPILER_API_TOKEN = process.env.ADPILER_API_TOKEN;

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const values = line.split(',');
    return Object.fromEntries(values.map((v, i) => [headers[i].trim(), v.trim()]));
  });
}

async function getClientMapping() {
  const res = await fetch(GOOGLE_SHEET_CSV_URL);
  const text = await res.text();
  const rows = parseCSV(text);
  const map = {};
  rows.forEach(row => {
    if (row["Trello Client Name"] && row["Adpiler Client ID"]) {
      map[row["Trello Client Name"]] = row["Adpiler Client ID"];
    }
  });
  return map;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error(`Request Failed. Status: ${res.statusCode}`));
      const stream = createWriteStream(dest);
      pipeline(res, stream).then(resolve).catch(reject);
    });
  });
}

async function isValidImage(filePath) {
  const type = await fileTypeFromFile(filePath);
  if (!['image/png', 'image/jpeg', 'image/gif', 'video/mp4'].includes(type?.mime)) return false;
  const dim = sizeOf(filePath);
  return (
    (dim.width === 1200 && dim.height === 1200) ||
    (dim.width === 300 && dim.height === 600)
  );
}

app.post('/api/upload-to-adpiler', async (req, res) => {
  try {
    const action = req.body?.action;
    const card = action?.data?.card;
    const list = action?.data?.listAfter?.name || action?.data?.list?.name;
    const board = action?.data?.board?.name;

    if (!card || !board || list !== 'Ready For AdPiler') return res.status(200).send('Ignored');

    const cardRes = await fetch(`https://api.trello.com/1/cards/${card.id}?fields=name,desc,url&attachments=true&customFieldItems=true&token=${process.env.TRELLO_TOKEN}&key=${process.env.TRELLO_KEY}`);
    const cardData = await cardRes.json();

    const name = cardData.name || '';
    const description = cardData.desc || '';
    const attachments = cardData.attachments || [];
    const customFields = {};
    (cardData.customFieldItems || []).forEach(field => {
      customFields[field.idCustomField] = field.value?.text || field.value?.checked || '';
    });

    const mapping = await getClientMapping();
    const adpilerId = mapping[board];
    if (!adpilerId) return res.status(400).send('No Adpiler client mapping found');

    const uploadPromises = [];
    for (const att of attachments) {
      const tempFile = path.join('/tmp', path.basename(att.url));
      await downloadFile(att.url, tempFile);
      if (await isValidImage(tempFile)) {
        const form = new FormData();
        form.append('name', name);
        form.append('description', description);
        form.append('client', adpilerId);
        form.append('caption', customFields.caption || '');
        form.append('cta', customFields.cta || '');
        form.append('clickurl', customFields.clickurl || '');
        form.append('file', fs.createReadStream(tempFile));
        uploadPromises.push(
          fetch('https://app.adpiler.com/api/upload', {
            method: 'POST',
            headers: { Authorization: `Bearer ${ADPILER_API_TOKEN}` },
            body: form,
          })
        );
      }
    }

    await Promise.all(uploadPromises);

    await fetch(`https://api.trello.com/1/cards/${card.id}/labels?color=green&name=Uploaded&key=${process.env.TRELLO_KEY}&token=${process.env.TRELLO_TOKEN}`, {
      method: 'POST',
    });

    res.status(200).send('Uploaded');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error uploading');
  }
});

app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
