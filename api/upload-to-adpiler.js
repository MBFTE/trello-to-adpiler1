// api/upload-to-adpiler.js
import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { fileTypeFromBuffer } from 'file-type';

const app = express();
app.use(express.json());

//─── CONFIG ──────────────────────────────────────────────────────────────────
const TRELLO_KEY    = process.env.TRELLO_KEY;
const TRELLO_TOKEN  = process.env.TRELLO_TOKEN;
const ADPILER_KEY   = process.env.ADPILER_API_KEY;
const CLIENT_CSV    = 'https://docs.google.com/spreadsheets/d/e/…/pub?output=csv';

//─── UTILS ───────────────────────────────────────────────────────────────────
async function fetchCsvMap() {
  const res = await fetch(CLIENT_CSV);
  const text = await res.text();
  const lines = text.trim().split('\n').map(r => r.split(','));
  // header: Trello Client Name,Adpiler Client ID,Trello List Name,Adpiler Folder ID
  const map = { clients: {}, folders: {} };
  lines.slice(1).forEach(([tName, cId, listName, fId]) => {
    map.clients[tName.trim()] = cId.trim();
    map.folders[listName.trim()] = fId.trim();
  });
  return map;
}

async function downloadAttachment(url) {
  // authenticate Trello file download
  const res = await fetch(`${url}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  return res.buffer();
}

//─── LOAD MAPPINGS ON START ──────────────────────────────────────────────────
let lookup = null;
fetchCsvMap()
  .then(m => lookup = m)
  .catch(err => {
    console.error('❌ Failed to fetch CSV mapping', err);
    process.exit(1);
  });

//─── WEBHOOK ENDPOINT ────────────────────────────────────────────────────────
app.post('/upload-to-adpiler', async (req, res) => {
  try {
    const { card, list } = req.body.action.data;
    const clientName = card.name.split(':')[0].trim();
    const clientId   = lookup.clients[clientName];
    const folderId   = lookup.folders[list.name];
    if (!clientId) return res.status(400).send(`No AdPiler client for "${clientName}"`);
    if (!folderId) return res.status(400).send(`No folder mapped for list "${list.name}"`);

    // loop over attachments
    for (const at of card.attachments || []) {
      const buf = await downloadAttachment(at.url);
      const type = await fileTypeFromBuffer(buf);
      if (!type) {
        console.warn('⚠️ Skipping unsupported file', at.url);
        continue;
      }

      const form = new FormData();
      form.append('name', card.name);
      form.append('file', buf, { filename: at.name, contentType: type.mime });
      form.append('width',  at.width  || '0');
      form.append('height', at.height || '0');

      const apiRes = await fetch(
        `https://platform.adpiler.com/api/campaigns/${folderId}/ads`,
        {
          method: 'POST',
          headers: { 'X-API-KEY': ADPILER_KEY },
          body: form
        }
      );
      if (!apiRes.ok) {
        const text = await apiRes.text();
        throw new Error(`AdPiler upload failed ${apiRes.status}: ${text}`);
      }
      console.log(`✅ Uploaded ${at.name} to campaign ${folderId}`);
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

//─── START SERVER ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
