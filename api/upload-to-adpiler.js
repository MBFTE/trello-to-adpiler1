// api/upload-to-adpiler.js

import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import csv from 'csvtojson';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const CLIENT_CSV_URL = process.env.CLIENT_CSV_URL
  || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const TARGET_LIST_NAME = process.env.TARGET_LIST_NAME || "READY FOR ADPILER"; // Update as needed

// Required: set these in Render dashboard (or .env)
const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const ADPILER_API_KEY = process.env.ADPILER_API_KEY;

let clientMap = {};

async function refreshClientMap() {
  console.log('🔄 Refreshing client map from sheet…');
  try {
    console.log('Fetching client map from:', CLIENT_CSV_URL);
    const res = await fetch(CLIENT_CSV_URL);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const text = await res.text();
    const rows = await csv().fromString(text);

    const map = {};
    for (const row of rows) {
      if (row['Trello Client Name'] && row['Adpiler Client ID']) {
        const key = row['Trello Client Name'].trim().toLowerCase();
        map[key] = row['Adpiler Client ID'].trim();
      }
    }
    clientMap = map;
    console.log('✅ Loaded clients:', Object.keys(clientMap));
  } catch (err) {
    console.error('❌ Failed to fetch CSV:', err.message);
  }
}

// Immediately load the client map and refresh hourly
await refreshClientMap();
setInterval(refreshClientMap, 1000 * 60 * 60);

// --- Helper to fetch attachments from Trello API ---
async function getCardAttachments(cardId) {
  if (!TRELLO_API_KEY || !TRELLO_TOKEN) throw new Error("Missing Trello API credentials");
  const url = `https://api.trello.com/1/cards/${cardId}/attachments?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch attachments: ${res.status}`);
  return res.json();
}

// --- Webhook verification endpoint ---
app.head('/upload-to-adpiler', (_req, res) => res.sendStatus(200));

// --- Health check ---
app.get('/', (_req, res) => res.send('OK'));

// --- Main webhook handler ---
app.post('/upload-to-adpiler', async (req, res) => {
  const action = req.body.action;
  if (action?.type !== 'updateCard' || !action.data?.listAfter) {
    return res.sendStatus(200);
  }

  const listName = action.data.listAfter.name;
  if (listName !== TARGET_LIST_NAME) {
    return res.sendStatus(200);
  }

  const card = action.data.card;
  const cardId = card.id;
  const cardName = card.name;
  const clientName = cardName.split(':')[0].trim().toLowerCase();
  const clientId = clientMap[clientName];

  if (!clientId) {
    console.error(`❌ No Adpiler client found for "${clientName}"`);
    return res.status(400).json({ error: `No Adpiler client for ${clientName}` });
  }

  let attachments = [];
  try {
    attachments = await getCardAttachments(cardId);
  } catch (err) {
    console.error("❌ Failed to fetch attachments from Trello:", err.message);
    return res.status(500).json({ error: "Failed to fetch attachments from Trello" });
  }

  if (!attachments.length) {
    console.log(`ℹ️  No attachments on "${cardName}"`);
    return res.sendStatus(200);
  }

  for (const att of attachments) {
    try {
      const fileRes = await fetch(att.url);
      if (!fileRes.ok) throw new Error(`Download failed ${fileRes.status}`);
      const buffer = await fileRes.buffer();

      const form = new FormData();
      form.append('name', att.name);
      form.append('file', buffer, att.name);

      const apiRes = await fetch(
        `https://platform.adpiler.com/api/campaigns/${clientId}/ads`,
        {
          method: 'POST',
          headers: { 'X-API-KEY': ADPILER_API_KEY },
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
