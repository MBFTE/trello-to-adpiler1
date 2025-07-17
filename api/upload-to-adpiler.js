// api/upload-to-adpiler.js
import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { fileTypeFromBuffer } from 'file-type';
import sizeOf from 'image-size';

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;

// Make sure these env vars are set in your Render/Vercel dashboard
const ADPILER_API_KEY = process.env.ADPILER_API_KEY;
const TRELLO_KEY      = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN    = process.env.TRELLO_TOKEN;

// Your published CSV URL
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';

/** Download your sheet and build a lowercase‐keyed map */
async function getClientMap() {
  const res = await fetch(SHEET_URL);
  const csv = await res.text();
  const map = {};
  csv
    .split('\n').slice(1)
    .forEach(line => {
      const [name,id] = line.split(',');
      if (name && id) map[name.trim().toLowerCase()] = id.trim();
    });
  return map;
}

/** Fetch a Trello attachment with key/token and return a Buffer */
async function bufferFromUrl(url) {
  const sep    = url.includes('?') ? '&' : '?';
  const authed = `${url}${sep}key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
  const res    = await fetch(authed);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  return await res.buffer();
}

async function uploadToAdpiler(card, clientId) {
  const form = new FormData();
  form.append('client_id', clientId);
  form.append('headline',    card.name  || '');
  form.append('description', card.desc  || '');

  // parse lines like "Primary Text: …"
  const fields = {};
  (card.desc||'').split('\n').forEach(line => {
    const [k,...rest] = line.split(':');
    if (k && rest.length) fields[k.trim().toLowerCase()] = rest.join(':').trim();
  });
  form.append('primary_text',       fields['primary text']    || '');
  form.append('cta',                fields['cta']             || '');
  form.append('click_through_url',  fields['click through url'] || '');

  // iterate attachments
  for (const att of card.attachments||[]) {
    try {
      const buf = await bufferFromUrl(att.url);
      const ft  = await fileTypeFromBuffer(buf);
      const ext = ft?.ext ? `.${ft.ext}` : '';
      if (!['.png','.jpg','.jpeg','.gif','.mp4'].includes(ext)) continue;

      // if image, check dimensions; skip MP4
      if (ext !== '.mp4') {
        const { width, height } = sizeOf(buf);
        if (!(
          (width===1200 && height===1200) ||
          (width===300  && height===600 )
        )) continue;
      }

      const mime = ft?.mime || (ext==='.mp4' ? 'video/mp4' : 'application/octet-stream');
      form.append('files[]', buf, {
        filename: `upload${ext}`,
        contentType: mime
      });
    } catch (err) {
      console.error('Attachment skipped/error:', err.message);
    }
  }

  const resp = await fetch('https://api.adpiler.com/v1/creatives', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ADPILER_API_KEY}` },
    body: form
  });
  if (!resp.ok) throw new Error(`AdPiler upload failed ${resp.status}`);
}

async function addUploadedLabel(card) {
  // ensure a green "Uploaded" label exists on the board
  const boardId = card.idBoard;
  let labels = await fetch(
    `https://api.trello.com/1/boards/${boardId}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
  ).then(r=>r.json());

  let lbl = labels.find(l => l.name==='Uploaded');
  if (!lbl) {
    lbl = await fetch(
      `https://api.trello.com/1/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`,
      {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ name:'Uploaded', color:'green', idBoard: boardId })
      }
    ).then(r=>r.json());
  }

  // add it to the card
  await fetch(
    `https://api.trello.com/1/cards/${card.id}/idLabels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`,
    {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ value: lbl.id })
    }
  );
}

app.post('/api/upload-to-adpiler', async (req, res) => {
  try {
    const action = req.body.action;
    if (!action || action.type !== 'updateCard') {
      return res.status(200).send('Ignored non‐card‐move');
    }

    // fetch full card with attachments & desc
    const cardId = action.data.card.id;
    const card   = await fetch(
      `https://api.trello.com/1/cards/${cardId}?attachments=true&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
    ).then(r=>r.json());

    const clientMap = await getClientMap();
    // match by lowercased prefix before colon
    const key = Object.keys(clientMap)
      .find(name => card.name.toLowerCase().startsWith(name));
    if (!key) {
      throw new Error(`No AdPiler client found for "${card.name}"`);
    }

    // 1) upload everything
    await uploadToAdpiler(card, clientMap[key]);
    // 2) label the card
    await addUploadedLabel(card);

    return res.status(200).send('✅ Uploaded');
  } catch (err) {
    console.error('❌ Upload error:', err);
    return res.status(500).send(`Upload failed: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});

