// api/upload-to-adpiler.js
import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { fileTypeFromBuffer } from 'file-type';
import sizeOf from 'image-size';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';

const ADPILER_API_KEY = process.env.ADPILER_API_KEY;
const TRELLO_API_KEY    = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN      = process.env.TRELLO_TOKEN;

// 1) Fetch and cache client map at startup
let clientMap = {};
async function loadClientMap() {
  const csv = await (await fetch(SHEET_URL)).text();
  csv.split('\n').slice(1).forEach(line => {
    const [rawName, rawId] = line.split(',');
    if (!rawName || !rawId) return;
    clientMap[ rawName.trim().toLowerCase() ] = rawId.trim();
  });
}
await loadClientMap();

// 2) Helpers --------------------------------------------------

// Download URL into a Buffer
async function bufferFromUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed ${r.status}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

// Fetch minimal card info
async function fetchCard(cardId) {
  const url = `https://api.trello.com/1/cards/${cardId}`
    + `?attachments=true&fields=name,desc&key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Trello card fetch ${r.status}`);
  return r.json();
}

// Ensure green "Uploaded" label exists & attach it
async function addUploadedLabel(cardId, boardId) {
  // 2.1) see if card already has it
  const existing = await (await fetch(
    `https://api.trello.com/1/cards/${cardId}/labels`
    + `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
  )).json();

  let label = existing.find(l => l.name==='Uploaded');
  if (!label) {
    // 2.2) create it on the board
    label = await (await fetch(
      `https://api.trello.com/1/labels`
      + `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`,
      {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          idBoard:   boardId,
          name:      'Uploaded',
          color:     'green'
        })
      }
    )).json();
  }

  // 2.3) attach it
  await fetch(
    `https://api.trello.com/1/cards/${cardId}/idLabels`
    + `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`,
    {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ value: label.id })
    }
  );
}

// 3) Main webhook handler ------------------------------------
app.post('/api/upload-to-adpiler', async (req, res) => {
  try {
    const action = req.body.action;
    // only fire on a list‑move
    if (!action || action.type!=='updateCard') {
      return res.status(200).send('ignored');
    }

    const cardId = action.data.card.id;
    const card   = await fetchCard(cardId);

    // 3.1) lookup client
    const key   = card.name.split(':')[0].trim().toLowerCase();
    const cid   = clientMap[key];
    if (!cid) throw new Error(`No AdPiler client for "${card.name}"`);

    // 3.2) parse desc meta‑fields
    const meta = {};
    (card.desc||'').split('\n').forEach(line => {
      const [k, ...rest] = line.split(':');
      if (!rest.length) return;
      meta[k.trim().toLowerCase()] = rest.join(':').trim();
    });

    // 3.3) build form
    const form = new FormData();
    form.append('client_id',        cid);
    form.append('headline',         meta['headline']           || '');
    form.append('description',      meta['description']        || '');
    form.append('primary_text',     meta['primary text']       || '');
    form.append('cta',              meta['cta']                || '');
    form.append('click_through_url',meta['click through url']  || '');

    // 3.4) attachments
    for (const att of card.attachments||[]) {
      const buf = await bufferFromUrl(att.url);
      // sniff type
      const info = await fileTypeFromBuffer(buf);
      if (!info) continue;
      if (info.mime.startsWith('image/')) {
        // validate dims
        const d = sizeOf(buf);
        if (!((d.width===1200 && d.height===1200)
           || (d.width===300  && d.height===600))) {
          continue;
        }
      } else if (!info.mime.startsWith('video/mp4')) {
        continue;
      }
      form.append('files[]', buf, { filename: att.name, contentType: info.mime });
    }

    // 3.5) POST to AdPiler
    const ap = await fetch('https://api.adpiler.com/v1/creatives', {
      method:'POST',
      headers:{ Authorization: `Bearer ${ADPILER_API_KEY}` },
      body: form
    });
    if (!ap.ok) {
      const err = await ap.text();
      throw new Error(`AdPiler error ${ap.status}: ${err}`);
    }

    // 3.6) success → label the Trello card
    const minimal = await fetch(
      `https://api.trello.com/1/cards/${cardId}?fields=idBoard`
      + `&key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
    ).then(r => r.json());
    await addUploadedLabel(cardId, minimal.idBoard);

    return res.status(200).send('✅ OK');
  } catch (e) {
    console.error('❌ Upload error:', e);
    return res.status(500).send(`Error: ${e.message}`);
  }
});

app.listen(PORT, ()=> console.log(`🚀 Listening on ${PORT}`));

