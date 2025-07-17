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

// 1) Load client map once at startup
let clientMap = {};
async function loadClientMap() {
  const csv = await (await fetch(SHEET_URL)).text();
  csv.split('\n').slice(1).forEach(line => {
    const [name, id] = line.split(',');
    if (name && id) clientMap[name.trim().toLowerCase()] = id.trim();
  });
}
await loadClientMap();

// 2) Helpers --------------------------------------------------

// Fetch a Trello attachment with authentication → Buffer
async function bufferFromUrl(url) {
  const authSuffix = `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(url + (url.includes('?') ? '&' : '?') + authSuffix);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// Fetch Trello card (name, desc, attachments)
async function fetchCard(cardId) {
  const url =
    `https://api.trello.com/1/cards/${cardId}`
    + `?fields=name,desc&attachments=true`
    + `&key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Card fetch failed ${res.status}`);
  return res.json();
}

// Ensure green "Uploaded" label exists and attach it
async function addUploadedLabel(cardId, boardId) {
  // 2.1) list existing labels on card
  const existing = await (await fetch(
    `https://api.trello.com/1/cards/${cardId}/labels`
    + `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
  )).json();

  let label = existing.find(l => l.name === 'Uploaded');
  if (!label) {
    // 2.2) create it on the board
    label = await (await fetch(
      `https://api.trello.com/1/labels`
      + `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`,
      {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          idBoard: boardId,
          name:    'Uploaded',
          color:   'green'
        })
      }
    )).json();
  }

  // 2.3) attach to card
  await fetch(
    `https://api.trello.com/1/cards/${cardId}/idLabels`
    + `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`,
    {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({value: label.id})
    }
  );
}

// 3) Webhook endpoint ----------------------------------------
app.post('/api/upload-to-adpiler', async (req, res) => {
  try {
    const action = req.body.action;
    if (!action || action.type !== 'updateCard') {
      return res.status(200).send('ignored');
    }

    const cardId = action.data.card.id;
    const card   = await fetchCard(cardId);

    // 3.1) find client ID
    const clientKey = card.name.split(':')[0].trim().toLowerCase();
    const clientId  = clientMap[clientKey];
    if (!clientId) throw new Error(`No AdPiler client for "${card.name}"`);

    // 3.2) parse meta‑fields from description
    const meta = {};
    (card.desc||'').split('\n').forEach(line => {
      const [k, ...rest] = line.split(':');
      if (rest.length) meta[k.trim().toLowerCase()] = rest.join(':').trim();
    });

    // 3.3) build multipart form
    const form = new FormData();
    form.append('client_id',         clientId);
    form.append('headline',          meta['headline']          || '');
    form.append('description',       meta['description']       || '');
    form.append('primary_text',      meta['primary text']      || '');
    form.append('cta',               meta['cta']               || '');
    form.append('click_through_url', meta['click through url'] || '');

    // 3.4) attachments → files[]
    for (const att of card.attachments||[]) {
      const buf  = await bufferFromUrl(att.url);
      const ft   = await fileTypeFromBuffer(buf);
      if (!ft) continue;

      if (ft.mime.startsWith('image/')) {
        const dim = sizeOf(buf);
        const okImage = (dim.width===1200 && dim.height===1200)
                     || (dim.width===300  && dim.height===600);
        if (!okImage) continue;
      } else if (ft.mime !== 'video/mp4') {
        continue;
      }

      form.append('files[]', buf, {filename:att.name, contentType:ft.mime});
    }

    // 3.5) POST to AdPiler
    const apRes = await fetch('https://api.adpiler.com/v1/creatives', {
      method: 'POST',
      headers: {Authorization: `Bearer ${ADPILER_API_KEY}`},
      body: form
    });
    if (!apRes.ok) {
      const txt = await apRes.text();
      throw new Error(`AdPiler ${apRes.status}: ${txt}`);
    }

    // 3.6) on success, add label
    const { idBoard } = await (await fetch(
      `https://api.trello.com/1/cards/${cardId}?fields=idBoard`
      + `&key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
    )).json();

    await addUploadedLabel(cardId, idBoard);

    return res.status(200).send('✅ uploaded');
  } catch (err) {
    console.error('❌ Upload error:', err);
    return res.status(500).send(`Error: ${err.message}`);
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));
