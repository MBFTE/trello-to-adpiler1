// api/upload-to-adpiler.js
import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import sizeOf from 'image-size';
import { fileTypeFromBuffer } from 'file-type';
import path from 'path';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const ADPILER_API_KEY = process.env.ADPILER_API_KEY;
const TRELLO_API_KEY    = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN      = process.env.TRELLO_TOKEN;

// load client map once at startup
let clientMap = {};
async function fetchClientMap() {
  const res = await fetch(SHEET_URL);
  const csv = await res.text();
  csv.split('\n').slice(1).forEach(line => {
    const [name, id] = line.split(',');
    if (name && id) clientMap[name.trim().toLowerCase()] = id.trim();
  });
}
await fetchClientMap();

// helper to download & buffer an attachment URL
async function bufferFromUrl(url) {
  const res = await fetch(url);
  const ab  = await res.arrayBuffer();
  return Buffer.from(ab);
}

// add or reuse a green “Uploaded” label on the card
async function addUploadedLabel(cardId) {
  // fetch existing labels on the card
  const resp = await fetch(
    `https://api.trello.com/1/cards/${cardId}/labels?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
  );
  const labels = await resp.json();
  let lbl = labels.find(l => l.name === 'Uploaded');
  let lblId = lbl?.id;

  if (!lblId) {
    // create it on the board
    const create = await fetch(
      `https://api.trello.com/1/labels?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({
          name: 'Uploaded',
          color: 'green',
          idBoard: (await fetchCard(cardId)).idBoard
        })
      }
    );
    lblId = (await create.json()).id;
  }

  // attach it
  await fetch(
    `https://api.trello.com/1/cards/${cardId}/idLabels?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`,
    {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ value: lblId })
    }
  );
}

// fetch full card (including board ID)
async function fetchCard(cardId) {
  const r = await fetch(
    `https://api.trello.com/1/cards/${cardId}?fields=idBoard&key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
  );
  return r.json();
}

app.post('/api/upload-to-adpiler', async (req, res) => {
  try {
    const action = req.body.action;
    if (!action || action.type !== 'updateCard') {
      return res.status(200).send('Ignored');
    }
    const cardId = action.data.card.id;
    // get card with desc + attachments
    const card = await (await fetch(
      `https://api.trello.com/1/cards/${cardId}?attachments=true&fields=name,desc&key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
    )).json();

    // figure out client ID
    const nameKey = card.name.split(':')[0].toLowerCase();
    const clientId = clientMap[nameKey];
    if (!clientId) throw new Error(`No AdPiler client found for "${card.name}"`);

    // parse description lines into a map
    const meta = {};
    (card.desc||'').split('\n').forEach(line => {
      const [k, ...rest] = line.split(':');
      if (!rest.length) return;
      meta[k.trim().toLowerCase()] = rest.join(':').trim();
    });

    // assemble multipart form
    const form = new FormData();
    form.append('client_id', clientId);
    form.append('headline',           meta['headline']           || '');
    form.append('description',        meta['description']        || '');
    form.append('primary_text',       meta['primary text']       || '');
    form.append('cta',                meta['cta']                || '');
    form.append('click_through_url',  meta['click through url']  || '');

    // attach files
    for (const a of card.attachments||[]) {
      const ext = path.extname(a.name).toLowerCase();
      if (!['.png','.jpg','.jpeg','.gif','.mp4'].includes(ext)) continue;
      const buf = await bufferFromUrl(a.url);
      let ok = false;

      if (ext === '.mp4') {
        ok = true;
      } else {
        const dims = sizeOf(buf);
        ok = [ {w:1200,h:1200}, {w:300,h:600} ]
          .some(s => s.w===dims.width && s.h===dims.height);
      }
      if (!ok) continue;

      const type = await fileTypeFromBuffer(buf);
      form.append('files[]', buf, { filename: a.name, contentType: type?.mime });
    }

    // send to AdPiler
    const ap = await fetch('https://api.adpiler.com/v1/creatives', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADPILER_API_KEY}` },
      body: form
    });
    if (!ap.ok) {
      const err = await ap.text();
      throw new Error(`AdPiler upload failed: ${err}`);
    }

    // add “Uploaded” label on Trello card
    await addUploadedLabel(cardId);

    res.status(200).send('✅ Uploaded');
  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).send(`Error: ${err.message}`);
  }
});

app.listen(PORT, ()=> console.log(`🚀 Listening on ${PORT}`));
