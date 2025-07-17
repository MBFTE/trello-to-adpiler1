// api/upload-to-adpiler.js
import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { fromBuffer } from 'file-type';
import csv from 'csvtojson';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/…/pub?output=csv';
const ADPILER_TOKEN = process.env.ADPILER_API_KEY;       // set in your Render/Env
const TRELLO_TOKEN  = process.env.TRELLO_TOKEN;         // set in your Render/Env

// map of Trello‑prefix → Adpiler client ID
let clientMap = {};

// load CSV once at startup
async function loadClientMap() {
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`Failed to fetch CSV (${res.status})`);
  const text = await res.text();
  const rows = await csv().fromString(text);
  rows.forEach(r => {
    const key = r['Trello Client Name']?.trim();
    const id  = r['Adpiler Client ID']?.trim();
    if (key && id) clientMap[key] = id;
  });
  console.log('▶️  clientMap loaded:', clientMap);
}
await loadClientMap();

// map your Trello list names → numeric Adpiler campaign IDs
const CAMPAIGN_MAP = {
  Clovis:  /* e.g. */ process.env.CAMPAIGN_CLOVIS_ID,
  Roswell: process.env.CAMPAIGN_ROSWELL_ID,
  // add more as needed…
};

// download a Trello attachment buffer
async function downloadAttachment(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TRELLO_TOKEN}` } });
  if (!r.ok) throw new Error(`Download failed ${r.status}`);
  return r.buffer();
}

app.post('/upload-to-adpiler', async (req, res) => {
  try {
    const act = req.body.action?.data;
    const card = act?.card;
    const list = act?.list;
    if (!card || !list) return res.status(400).json({ error: 'Invalid Trello webhook payload' });

    // extract the prefix before the colon
    const rawPrefix = card.name.split(':')[0].trim();
    // find a CSV key that rawPrefix *contains*
    const clientKey = Object.keys(clientMap).find(k => rawPrefix.includes(k));
    if (!clientKey) throw new Error(`No Adpiler client found for "${rawPrefix}"`);
    const clientId = clientMap[clientKey];

    // lookup campaign ID by Trello list name
    const campaignId = CAMPAIGN_MAP[list.name];
    if (!campaignId) throw new Error(`No campaign ID mapped for list "${list.name}"`);

    const atts = card.attachments || [];
    if (!atts.length) throw new Error('No attachments on this Trello card');

    for (const att of atts) {
      const buf = await downloadAttachment(att.url);
      const ft = await fromBuffer(buf);
      if (!ft) throw new Error(`Unsupported file type for ${att.url}`);

      const form = new FormData();
      form.append('name', card.name);
      form.append('client_id', clientId);
      form.append('file', buf, {
        filename: att.name,
        contentType: ft.mime
      });

      const apiRes = await fetch(
        `https://platform.adpiler.com/api/campaigns/${campaignId}/ads`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ADPILER_TOKEN}`,
            ...form.getHeaders()
          },
          body: form
        }
      );
      if (!apiRes.ok) {
        const txt = await apiRes.text();
        throw new Error(`Adpiler upload failed ${apiRes.status}: ${txt}`);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('❌ Upload error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});
