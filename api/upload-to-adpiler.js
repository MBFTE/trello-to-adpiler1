// api/upload-to-adpiler.js
import express from 'express';
import fetch from 'node-fetch';
import csv from 'csvtojson';
import FormData from 'form-data';
import { fileTypeFromBuffer } from 'file-type';
import sizeOf from 'image-size';

const PORT = process.env.PORT || 3000;
const SHEET_URL = process.env.CLIENT_CSV_URL
  || 'https://docs.google.com/spreadsheets/d/e/…/pub?output=csv';
const ADPILER_API_KEY = process.env.ADPILER_API_KEY || 'YOUR_API_KEY_HERE';

let clientMap = {};

/**
 * Fetch and parse the Google Sheet CSV into clientMap:
 *   { "Zia Clovis": "69144", "Zia Roswell": "69144", … }
 */
async function refreshClientMap() {
  console.log('🔄 Refreshing client map from sheet…');
  const res = await fetch(SHEET_URL);
  if (!res.ok) {
    console.error(`❌ Failed to fetch CSV: ${res.status}`);
    return;
  }
  const text = await res.text();
  const rows = await csv().fromString(text);
  clientMap = {};
  for (const row of rows) {
    const name = row['Trello Client Name']?.trim();
    const id   = row['Adpiler Client ID']?.trim();
    if (name && id) clientMap[name] = id;
  }
  console.log('✅ Loaded client IDs for', Object.keys(clientMap).length, 'clients');
}

// initial load + hourly refresh
await refreshClientMap();
setInterval(refreshClientMap, 1000 * 60 * 60);

const app = express();
app.use(express.json());

app.post('/upload-to-adpiler', async (req, res) => {
  try {
    const card = req.body?.action?.data?.card;
    if (!card || !card.name) {
      return res.status(400).json({ error: 'No card data' });
    }

    // extract client name from "ClientName: Ad title"
    const fullName   = card.name;
    const clientName = fullName.split(':')[0].trim();
    const clientId   = clientMap[clientName];
    if (!clientId) {
      console.error(`❌ No AdPiler client found for "${clientName}"`);
      return res.status(404).json({ error: `No AdPiler client for "${clientName}"` });
    }

    const attachments = card.attachments || [];
    if (!attachments.length) {
      console.log('ℹ️ No attachments to upload for', fullName);
      return res.json({ success: true, uploaded: 0 });
    }

    let uploadedCount = 0;
    for (const att of attachments) {
      // download the file
      const fileRes = await fetch(att.url);
      if (!fileRes.ok) {
        console.error('❌ Download failed', att.url, fileRes.status);
        continue;
      }
      const buffer = Buffer.from(await fileRes.arrayBuffer());

      // detect mime and extension
      const ft = await fileTypeFromBuffer(buffer);
      if (!ft) {
        console.error('❌ Unsupported file type for', att.name);
        continue;
      }

      // get dimensions
      let dims;
      try {
        dims = sizeOf(buffer);
      } catch (e) {
        console.warn('⚠️ Could not read image dimensions for', att.name, e.message);
      }

      // build form
      const form = new FormData();
      form.append('name',       fullName);
      form.append('campaign',   clientId);                // path param too, but keep for body
      if (dims) {
        form.append('width',    dims.width.toString());
        form.append('height',   dims.height.toString());
      }
      form.append('file', buffer, { 
        filename: att.name, 
        contentType: ft.mime 
      });

      // fire off the upload
      const apiUrl = `https://platform.adpiler.com/api/clients/${clientId}/folders/${att.idFolder}/campaigns/${att.idCampaign}/ads`;
      // adjust the path above to match your folder/campaign structure…
      const adpilerRes = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'X-API-KEY': ADPILER_API_KEY },
        body: form
      });
      const text = await adpilerRes.text();
      if (!adpilerRes.ok) {
        console.error(`❌ AdPiler upload failed ${adpilerRes.status}:`, text);
      } else {
        uploadedCount++;
      }
    }

    res.json({ success: true, uploaded: uploadedCount });
  } catch (err) {
    console.error('🔥 Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});
