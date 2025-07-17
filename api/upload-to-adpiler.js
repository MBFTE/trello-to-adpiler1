// api/upload-to-adpiler.js
import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import csv from 'csvtojson';

const app = express();
const PORT = process.env.PORT || 10000;

// ←– your published‑to‑web CSV URL:
const CLIENT_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';

let clientMap = {};

/**
 * Fetches and parses the CSV, rebuilding clientMap[name] = id
 */
async function refreshClientMap() {
  try {
    console.log('🔄 Refreshing client map from sheet…');
    const resp = await fetch(CLIENT_CSV_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const rows = await csv().fromString(text);

    clientMap = {};
    for (const row of rows) {
      const name = row['Trello Client Name']?.trim();
      const id   = row['Adpiler Client ID']?.trim();
      if (name && id) clientMap[name] = id;
    }
    console.log('✅ Loaded clients:', clientMap);
  } catch (err) {
    console.error('❌ Failed to fetch CSV:', err.message);
  }
}

// initial load + hourly refresh
await refreshClientMap();
setInterval(refreshClientMap, 60 * 60 * 1000);

app.use(express.json());

app.post('/upload-to-adpiler', async (req, res) => {
  const cardName = req.body?.action?.data?.card?.name;
  if (!cardName) return res.status(400).json({ error: 'Missing card name' });

  // before colon is your key in the CSV
  const clientKey = cardName.split(':')[0].trim();
  const clientId  = clientMap[clientKey];
  if (!clientId) {
    console.error(`❌ No AdPiler client found for "${clientKey}"`);
    return res.status(404).json({ error: `No AdPiler client for "${clientKey}"` });
  }

  // any attachments on the Trello card?
  const attachments = req.body.action.data.card.attachments || [];
  if (!attachments.length) {
    console.error('❌ No attachments to upload');
    return res.status(400).json({ error: 'No attachments' });
  }

  for (const att of attachments) {
    try {
      // download the file
      const fileResp = await fetch(att.url);
      if (!fileResp.ok) {
        console.error(`❌ Download failed ${fileResp.status}`);
        continue;
      }
      const buffer = await fileResp.buffer();

      // build multipart form
      const form = new FormData();
      form.append('campaign', clientId);             // path param in docs is {campaign}
      form.append('name', att.name || 'attachment');
      form.append('file', buffer, { filename: att.name });

      // send to AdPiler
      const apiUrl = `https://platform.adpiler.com/api/campaigns/${clientId}/ads`;
      const adpilerRes = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'X-API-KEY': process.env.ADPILER_API_KEY },
        body: form
      });

      if (!adpilerRes.ok) {
        const bodyText = await adpilerRes.text();
        console.error(`❌ AdPiler upload failed ${adpilerRes.status}: ${bodyText}`);
      } else {
        console.log(`✅ Uploaded "${att.name}" to campaign ${clientId}`);
      }
    } catch (err) {
      console.error('❌ Upload error:', err);
    }
  }

  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});
