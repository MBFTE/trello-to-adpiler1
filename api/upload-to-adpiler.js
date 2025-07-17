import express from 'express';
import fetch from 'node-fetch';
import csv from 'csvtojson';
import FormData from 'form-data';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CLIENT_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const ADPILER_API_KEY = process.env.ADPILER_API_KEY || '11|8u3W1oxoMT0xYCGa91Q7HjznUYfEqODrhVShcXCj';

// In-memory maps
const clientMap = {};
const folderMap = {};

// Fetch and parse CSV for client & folder mappings
async function fetchMappings() {
  const res = await fetch(CLIENT_CSV_URL);
  if (!res.ok) throw new Error(`Failed to fetch CSV: ${res.status}`);
  const raw = await res.text();
  const rows = await csv().fromString(raw);

  rows.forEach(r => {
    const clientName = r['Trello Client Name']?.trim();
    const clientId   = r['Adpiler Client ID']?.trim();
    const listName   = r['Trello List Name']?.trim();
    const folderId   = r['Adpiler Folder ID']?.trim();

    if (clientName && clientId) {
      clientMap[clientName] = clientId;
    }
    if (clientName && listName && folderId) {
      folderMap[`${clientName}|${listName}`] = folderId;
    }
  });
}

// Initialize mappings
await fetchMappings();

app.post('/upload-to-adpiler', async (req, res) => {
  try {
    const card   = req.body.action?.data?.card;
    const list   = req.body.action?.data?.list;
    if (!card || !list) return res.status(400).send('Missing card or list data');

    const cardName = card.name;
    const listName = list.name;
    const clientName = cardName.split(':')[0].trim();

    const clientId = clientMap[clientName];
    const folderKey = `${clientName}|${listName}`;
    const folderId  = folderMap[folderKey];

    if (!clientId) {
      return res.status(404).send(`No Adpiler client for "${clientName}"`);
    }
    if (!folderId) {
      return res.status(404).send(`No Adpiler folder for "${folderKey}"`);
    }

    const attachments = card.attachments || [];
    for (const att of attachments) {
      // Download Trello attachment
      const fileRes = await fetch(att.url);
      if (!fileRes.ok) {
        console.error('Download failed', att.url, fileRes.status);
        continue;
      }
      const buffer = await fileRes.buffer();

      // Build multipart form-data
      const form = new FormData();
      form.append('name', cardName);
      form.append('file', buffer, { filename: att.name || 'upload' });
      // Upload parameters
      form.append('campaign', folderId);

      // Send to Adpiler
      const uploadRes = await fetch(
        `https://platform.adpiler.com/api/campaigns/${folderId}/ads`,
        {
          method: 'POST',
          headers: { 'X-API-KEY': ADPILER_API_KEY },
          body: form,
        }
      );

      if (!uploadRes.ok) {
        const text = await uploadRes.text();
        console.error('Adpiler upload failed', uploadRes.status, text);
      }
    }

    res.status(200).send('Upload job complete');
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});


app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});
