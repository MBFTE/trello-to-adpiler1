// api/upload-to-adpiler.js

import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import csv from 'csvtojson';

const app = express();
app.use(express.json());

const PORT             = process.env.PORT || 3000;
const CLIENT_CSV_URL   =
  process.env.CLIENT_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const TARGET_LIST_NAME = process.env.TARGET_LIST_NAME || 'READY FOR ADPILER';
const TRELLO_API_KEY   = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN     = process.env.TRELLO_TOKEN;
const ADPILER_API_KEY  = process.env.ADPILER_API_KEY;
const ADPILER_BASE_URL =
  process.env.ADPILER_BASE_URL || 'https://platform.adpiler.com/api';

let clientMap = {};

// Refresh clientMap at startup and every hour
;(async function refreshClientMap() {
  try {
    console.log('🔄 Refreshing client map…');
    const res = await fetch(CLIENT_CSV_URL, { timeout: 15000 });
    if (!res.ok) throw new Error(`CSV fetch ${res.status}`);
    const text = await res.text();
    const rows = await csv().fromString(text);

    clientMap = rows.reduce((map, row) => {
      const key = row['Trello Client Name']?.trim().toLowerCase();
      const id  = row['Adpiler Client ID']?.trim();
      if (key && id) map[key] = id;
      return map;
    }, {});

    console.log('✅ Loaded clients:', Object.keys(clientMap).join(', '));
  } catch (err) {
    console.error('❌ refreshClientMap error:', err.message);
  }
  setTimeout(refreshClientMap, 1000 * 60 * 60);
})();

// ─── Trello Helpers ────────────────────────────────────────────────────────────

async function getCardAttachments(cardId) {
  const url = `https://api.trello.com/1/cards/${cardId}/attachments`
    + `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`getCardAttachments ${res.status}`);
  return res.json();
}

async function downloadTrelloAttachment(cardId, att) {
  let res = await fetch(att.url, { redirect: 'follow', timeout: 15000 });
  if (!res.ok) {
    const dl = `https://api.trello.com/1/cards/${cardId}`
             + `/attachments/${att.id}/download`
             + `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
    res = await fetch(dl, { redirect: 'follow', timeout: 15000 });
    if (!res.ok) throw new Error(`download failed ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ─── Health Checks ─────────────────────────────────────────────────────────────

app.head('/upload-to-adpiler', (_req, res) => res.sendStatus(200));
app.get('/',               (_req, res) => res.send('OK'));

// ─── Webhook Handler ───────────────────────────────────────────────────────────

app.post('/upload-to-adpiler', async (req, res) => {
  try {
    const action = req.body.action;
    if (
      action?.type !== 'updateCard' ||
      action.data?.listAfter?.name !== TARGET_LIST_NAME
    ) {
      return res.sendStatus(200);
    }

    const cardId = action.data.card.id;

    // 1️⃣ Fetch card details including labels
    const cardRes = await fetch(
      `https://api.trello.com/1/cards/${cardId}`
      + `?fields=name,desc,url,labels`
      + `&key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
    );
    if (!cardRes.ok) throw new Error(`card fetch ${cardRes.status}`);
    const { name: cardName, desc = '', labels = [] } = await cardRes.json();

    // 2️⃣ Parse ad‐copy fields from description
    const fieldMap = {};
    desc.split('\n').forEach(line => {
      const [rawKey, ...vals] = line.split(':');
      if (!rawKey || vals.length === 0) return;
      fieldMap[rawKey.trim().toLowerCase()] = vals.join(':').trim();
    });
    const primaryText     = fieldMap['primary text']      || '';
    const headline        = fieldMap['headline']          || '';
    const descriptionText = fieldMap['description']       || '';
    const callToAction    = fieldMap['call to action']    || '';
    const clickUrl        = fieldMap['click through url'] || '';

    // 3️⃣ Determine ad format from Trello labels
    const labelNames = labels.map(l => l.name.trim().toLowerCase());
    const format     = labelNames.includes('social') ? 'social' : 'display';

    // 4️⃣ Map Trello client → Adpiler campaign
    const clientKey  = cardName.split(':')[0].trim().toLowerCase();
    const campaignId = clientMap[clientKey];
    if (!campaignId) {
      console.error(`❌ No campaign for "${clientKey}"`);
      return res.status(400).json({ error: `No campaign for ${clientKey}` });
    }

    // 5️⃣ Download attachments
    const attachments = await getCardAttachments(cardId);
    const buffers = await Promise.all(
      attachments.map(att =>
        downloadTrelloAttachment(cardId, att)
          .then(buf => ({ name: att.name, buf }))
          .catch(err => {
            console.error(`❌ download "${att.name}" failed:`, err.message);
            return null;
          })
      )
    );

    // 6️⃣ Build FormData
    const form = new FormData();
    // common ad-copy fields
    form.append('primary_text',      primaryText);
    form.append('headline',          headline);
    form.append('description',       descriptionText);
    form.append('call_to_action',    callToAction);
    form.append('click_through_url', clickUrl);

    let uploadPath;
    if (format === 'social') {
      uploadPath = `/v1/campaign/${campaignId}/social-ads`;
      form.append('name',       cardName);
      form.append('network',    fieldMap['network']    || 'facebook');
      form.append('type',       fieldMap['type']       || 'post');
      form.append('page_name',  fieldMap['page name']  || '');
      const logo = buffers.find(b => b !== null);
      if (logo) form.append('logo', logo.buf, logo.name);
    } else {
      uploadPath = `/v1/campaign/${campaignId}/ads`;
      form.append('name',              cardName);
      form.append('width',             fieldMap['width']       || '300');
      form.append('height',            fieldMap['height']      || '250');
      form.append('max_width',         fieldMap['max width']   || '300');
      form.append('max_height',        fieldMap['max height']  || '250');
      form.append('responsive_width',  'true');
      form.append('responsive_height', 'true');
      const file = buffers.find(b => b !== null);
      if (file) form.append('file', file.buf, file.name);
    }

    // 7️⃣ Upload to Adpiler
    const url = `${ADPILER_BASE_URL}${uploadPath}`;
    console.log(`➡️ Uploading ${format} ad to`, url);

    const apiRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADPILER_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
      timeout: 20000
    });

    if (!apiRes.ok) {
      const body = await apiRes.text();
      console.error(`❌ Adpiler ${apiRes.status}:`, body);
      return res.status(apiRes.status).send(body);
    }

    console.log(`✅ ${format} ad uploaded for campaign ${campaignId}`);
    return res.sendStatus(200);

  } catch (err) {
    console.error('❌ Handler error:', err.message);
    return res.status(500).send('Internal server error');
  }
});

// ─── Start Server ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});
