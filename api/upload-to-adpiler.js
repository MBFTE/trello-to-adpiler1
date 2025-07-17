// api/upload-to-adpiler.js
import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { fileTypeFromBuffer } from 'file-type';
import sizeOf from 'image-size';
import csv from 'csvtojson';

const app = express();
app.use(express.json());

const PORT           = process.env.PORT || 10000;
const CLIENT_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/…/pub?output=csv';
const TRELLO_KEY     = process.env.TRELLO_KEY;
const TRELLO_TOKEN   = process.env.TRELLO_TOKEN;
const ADPILER_API_KEY= process.env.ADPILER_API_KEY;
const ADPILER_BASE_URL = process.env.ADPILER_BASE_URL || 'https://platform.adpiler.com/api';

// Will hold { "Zia Clovis": "69144", "Zia Roswell": "69144", … }
let clientMap = {};

// Hard‑coded mapping of Trello LIST NAME → AdPiler CAMPAIGN (folder) ID:
const campaignMap = {
  'Clovis':  '45740',
  'Roswell': '45739',
};

;(async function loadClientMap() {
  try {
    const csvText = await fetch(CLIENT_CSV_URL).then(r => r.text());
    const rows = await csv().fromString(csvText);
    rows.forEach(r => {
      const name = r['Trello Client Name']?.trim();
      const id   = r['Adpiler Client ID']?.trim();
      if (name && id) clientMap[name] = id;
    });
    console.log('✅ Loaded clientMap:', clientMap);
  } catch (err) {
    console.error('❌ Failed loading client CSV:', err);
  }
})();

async function bufferFromUrl(url) {
  // Append your Trello key/token so you can download private attachments
  const u = new URL(url);
  u.searchParams.set('key',   TRELLO_KEY);
  u.searchParams.set('token', TRELLO_TOKEN);

  const res = await fetch(u.href);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

app.post('/upload-to-adpiler', async (req, res) => {
  try {
    console.log('📩 Webhook:', req.body.action.type);

    // 1) Identify client + campaign
    const card      = req.body.action.data.card;
    const cardName  = card.name;
    const clientKey = cardName.split(':')[0].trim();
    const clientId  = clientMap[clientKey];
    if (!clientId) throw new Error(`No Adpiler client for "${clientKey}"`);

    const listName   = req.body.action.data.list?.name;
    const campaignId = campaignMap[listName];
    if (!campaignId) throw new Error(`No campaign mapping for list "${listName}"`);

    // 2) Fetch every attachment on this card
    const attsRes = await fetch(
      `https://api.trello.com/1/cards/${card.id}/attachments?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
    );
    const attachments = await attsRes.json();
    if (!Array.isArray(attachments) || !attachments.length) {
      console.log('ℹ️ No attachments to upload.');
      return res.sendStatus(200);
    }

    // 3) Upload each one
    for (const att of attachments) {
      try {
        const buf = await bufferFromUrl(att.url);
        const type = await fileTypeFromBuffer(buf);
        if (!type) throw new Error(`Unknown file type for ${att.url}`);

        // get image dimensions
        let dims = { width: null, height: null };
        try { dims = sizeOf(buf); } catch {}

        const form = new FormData();
        form.append('name',            att.name || att.id);
        form.append('width',           dims.width);
        form.append('height',          dims.height);
        form.append('file',            buf, {
          filename: `${att.name || att.id}.${type.ext}`,
          contentType: type.mime
        });

        const uploadRes = await fetch(
          `${ADPILER_BASE_URL}/campaigns/${campaignId}/ads`, {
            method:  'POST',
            headers: {
              'X-API-KEY': ADPILER_API_KEY,
              ...form.getHeaders()
            },
            body: form
          }
        );

        if (!uploadRes.ok) {
          const txt = await uploadRes.text();
          throw new Error(`AdPiler upload failed ${uploadRes.status}: ${txt}`);
        }

        console.log(`✅ Uploaded attachment "${att.name}" to campaign ${campaignId}`);
      } catch (err) {
        console.error('❌ Attachment error:', err);
      }
    }

    res.sendStatus(200);

  } catch (err) {
    console.error('🔥 Handler error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

