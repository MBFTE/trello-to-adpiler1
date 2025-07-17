// api/upload-to-adpiler.js
import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import csv from 'csvtojson';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const CLIENT_CSV_URL = process.env.CLIENT_CSV_URL;
const TARGET_LIST_NAME = process.env.TARGET_LIST_NAME;

// In‐memory map Trello Client Name → Adpiler Client ID
let clientMap = {};

// Fetch and parse your Google Sheet CSV
async function refreshClientMap() {
  console.log('🔄 Refreshing client map from sheet…');
  try {
    const res = await fetch(CLIENT_CSV_URL);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const text = await res.text();
    const rows = await csv().fromString(text);

    const map = {};
    for (const row of rows) {
      if (row['Trello Client Name'] && row['Adpiler Client ID']) {
        map[row['Trello Client Name'].trim()] = row['Adpiler Client ID'].trim();
      }
    }
    clientMap = map;
    console.log('✅ Loaded clients:', clientMap);
  } catch (err) {
    console.error('❌ Failed to fetch CSV:', err.message);
  }
}

// Initial load + hourly refresh
await refreshClientMap();
setInterval(refreshClientMap, 1000 * 60 * 60);

// HEAD handler for Trello webhook verification
app.head('/upload-to-adpiler', (_req, res) => res.sendStatus(200));

// Health check
app.get('/', (_req, res) => res.send('OK'));

// Main webhook receiver
app.post('/upload-to-adpiler', async (req, res) => {
  const action = req.body.action;
  if (action?.type !== 'updateCard' || !action.data?.listAfter) {
    // ignore everything except list moves
    return res.sendStatus(200);
  }

  const listName = action.data.listAfter.name;
  if (listName !== TARGET_LIST_NAME) {
    // only trigger on your configured target list
    return res.sendStatus(200);
  }

  const card = action.data.card;
  const cardName = card.name;
  const clientName = cardName.split(':')[0].trim();
  const clientId = clientMap[clientName];

  if (!clientId) {
    console.error(`❌ No Adpiler client found for "${clientName}"`);
    return res.status(400).json({ error: `No Adpiler client for ${clientName}` });
  }

  // find every attachment
  const attachments = action.data.card.attachments || [];
  if (attachments.length === 0) {
    console.log(`ℹ️  No attachments on "${cardName}"`);
    return res.sendStatus(200);
  }

  for (const att of attachments) {
    try {
      // download the file
      const fileRes = await fetch(att.url);
      if (!fileRes.ok) throw new Error(`Download failed ${fileRes.status}`);
      const buffer = await fileRes.buffer();

      // upload to Adpiler
      const form = new FormData();
      form.append('name', att.name);
      form.append('file', buffer, att.name);

      // here we've assumed that campaign ID = clientId;
      // if you need a folder/campaign mapping, swap in your logic
      const apiRes = await fetch(
        `https://platform.adpiler.com/api/campaigns/${clientId}/ads`,
        {
          method: 'POST',
          headers: { 'X-API-KEY': process.env.ADPILER_API_KEY },
          body: form
        }
      );
      if (!apiRes.ok) {
        const text = await apiRes.text();
        throw new Error(`Adpiler upload failed ${apiRes.status}: ${text.substring(0,200)}`);
      }

      console.log(`✅ Uploaded ${att.name} to campaign ${clientId}`);
    } catch (err) {
      console.error('❌ Upload error:', err);
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});

