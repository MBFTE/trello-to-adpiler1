// api/upload-to-adpiler.js
import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';
import https from 'https';
import path from 'path';
import sizeOf from 'image-size';
import { fileTypeFromBuffer } from 'file-type';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const TRELLO_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const ADPILER_API_KEY = process.env.ADPILER_API_KEY;

// download a remote file to local disk
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', err => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

// fetch and parse your CSV into a { clientName: clientId } map
async function getClientMap() {
  const res = await fetch(SHEET_URL);
  const csv = await res.text();
  return csv
    .split('\n')
    .slice(1) // skip header
    .map(line => line.split(','))
    .reduce((map, [name, id]) => {
      if (name && id) map[name.trim()] = id.trim();
      return map;
    }, {});
}

// send the card data + valid attachments up to AdPiler
async function uploadToAdpiler(card, clientId, attachments) {
  const form = new FormData();

  // basic fields
  form.append('client_id', clientId);
  form.append('headline', card.name || '');
  form.append('description', card.desc || '');

  // parse additional lines in desc for primary text, cta, click URL
  const fields = {};
  (card.desc || '').split('\n').forEach(line => {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) {
      fields[key.trim().toLowerCase()] = rest.join(':').trim();
    }
  });
  form.append('primary_text', fields['primary text'] || '');
  form.append('cta', fields['cta'] || '');
  form.append('click_through_url', fields['click through url'] || '');

  // process each attachment
  for (const att of attachments) {
    const ext = path.extname(att.url).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.gif', '.mp4'].includes(ext)) continue;

    const tmp = `./temp_${Date.now()}${ext}`;
    await downloadFile(att.url, tmp);

    const buffer = fs.readFileSync(tmp);
    let dims;
    if (ext === '.mp4') {
      // assume spec size for video
      dims = { width: 1200, height: 1200 };
    } else {
      dims = sizeOf(buffer);
    }
    fs.unlinkSync(tmp);

    // only include if matches spec sizes
    const okSizes = [
      { width: 1200, height: 1200 },
      { width: 300,  height: 600  }
    ];
    if (!okSizes.some(s => s.width === dims.width && s.height === dims.height)) {
      continue;
    }

    // detect mime
    const ft = await fileTypeFromBuffer(buffer);
    const mime = ft?.mime || 'application/octet-stream';

    form.append('files[]', buffer, {
      filename: `upload${ext}`,
      contentType: mime
    });
  }

  // send to AdPiler
  const headers = {
    ...form.getHeaders(),
    Authorization: `Bearer ${ADPILER_API_KEY}`
  };
  const res = await fetch('https://api.adpiler.com/v1/creatives', {
    method: 'POST',
    headers,
    body: form
  });
  return res.ok;
}

// after successful upload, add an "Uploaded" label
async function addUploadedLabel(cardId, boardId) {
  // fetch existing labels on board
  const lblsRes = await fetch(
    `https://api.trello.com/1/boards/${boardId}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
  );
  const labels = await lblsRes.json();
  let uploaded = labels.find(l => l.name === 'Uploaded');

  if (!uploaded) {
    // create it
    const create = await fetch(
      `https://api.trello.com/1/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idBoard: boardId,
          name: 'Uploaded',
          color: 'green'
        })
      }
    );
    uploaded = await create.json();
  }

  // add label to card
  await fetch(
    `https://api.trello.com/1/cards/${cardId}/idLabels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: uploaded.id })
    }
  );
}

app.post('/api/upload-to-adpiler', async (req, res) => {
  try {
    const action = req.body.action;
    if (!action || action.type !== 'updateCard') {
      return res.status(200).send('Not a card update');
    }

    const cardId = action.data.card.id;
    // fetch full card with desc, attachments, and board ID
    const trelloRes = await fetch(
      `https://api.trello.com/1/cards/${cardId}?attachments=true&fields=name,desc,idBoard&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
    );
    const card = await trelloRes.json();

    // load map and find matching client
    const clientMap = await getClientMap();
    const matchKey = Object.keys(clientMap)
      .find(k => card.name.toLowerCase().startsWith(k.toLowerCase()));
    const clientId = matchKey ? clientMap[matchKey] : null;
    if (!clientId) {
      throw new Error(`No AdPiler client found for "${card.name}"`);
    }

    // upload and then label
    const ok = await uploadToAdpiler(card, clientId, card.attachments || []);
    if (ok) {
      await addUploadedLabel(cardId, card.idBoard);
      return res.status(200).send('Upload & label OK');
    } else {
      throw new Error('AdPiler upload failed');
    }
  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).send(err.message);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
