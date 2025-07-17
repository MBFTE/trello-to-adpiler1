// upload-to-adpiler.js

import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import csv from 'csvtojson';
import dotenv from 'dotenv';

dotenv.config();

const PORT             = process.env.PORT;
const CLIENT_CSV_URL   = process.env.CLIENT_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const TARGET_LIST_NAME = process.env.TARGET_LIST_NAME || 'READY FOR ADPILER';
const TRELLO_API_KEY   = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN     = process.env.TRELLO_TOKEN;
const TRELLO_BOARD_ID  = process.env.TRELLO_BOARD_ID;
const ADPILER_API_KEY  = process.env.ADPILER_API_KEY;

const app = express();
app.use(express.json());

let clientMap = {};

/**
 * Load mapping of Trello client names → Adpiler campaign IDs
 */
async function refreshClientMap() {
  try {
    console.log('🔄 Refreshing client map…');
    const res = await fetch(CLIENT_CSV_URL, { timeout: 15000 });
    if (!res.ok) throw new Error(`CSV fetch ${res.status}`);
    const text = await res.text();
    const rows = await csv().fromString(text);

    const map = {};
    for (const row of rows) {
      const key = row['Trello Client Name']?.trim().toLowerCase();
      const id  = row['Adpiler Client ID']?.trim();
      if (key && id) map[key] = id;
    }

    clientMap = map;
    console.log('✅ Loaded clients:', Object.keys(map).join(', '));
  } catch (err) {
    console.error('❌ refreshClientMap error:', err.message);
  }
}

// initialize and refresh hourly
await refreshClientMap();
setInterval(refreshClientMap, 1000 * 60 * 60);

/**
 * Get all attachments metadata for a Trello card
 */
async function getCardAttachments(cardId) {
  const url = `https://api.trello.com/1/cards/${cardId}/attachments`
    + `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`getCardAttachments ${res.status}`);
  return res.json();
}

/**
 * Download a Trello attachment (public URL then authenticated fallback)
 */
async function downloadTrelloAttachment(cardId, att) {
  let res = await fetch(att.url, { redirect: 'follow', timeout: 15000 });
  if (!res.ok) {
    const dl = `https://api.trello.com/1/cards/${cardId}`
             + `/attachments/${att.id}/download`
             + `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
    res = await fetch(dl, { redirect: 'follow', timeout: 15000 });
    if (!res.ok) {
      throw new Error(`download failed ${res.status}`);
    }
  }
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

// health checks
app.head('/upload-to-adpiler', (_req, res) => res.sendStatus(200));
app.get('/', (_req, res) => res.send('OK'));

/**
 * Webhook: when a card is moved into TARGET_LIST_NAME,
 * fetch its details, parse ad copy, download attachments,
 * and upload everything to Adpiler.
 */
app.post('/upload-to-adpiler', async (req, res) => {
  try {
    const action = req.body.action;

    // only handle moved-into-list events
    if (
      action?.type !== 'updateCard' ||
      action.data?.listAfter?.name !== TARGET_LIST_NAME
    ) {
      return res.sendStatus(200);
    }

    const cardId = action.data.card.id;

    // fetch full card info
    const cardRes = await fetch(
      `https://api.trello.com/1/cards/${cardId}`
      + `?fields=name,desc,url`
      + `&key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
    );
    if (!cardRes.ok) {
      throw new Error(`card fetch ${cardRes.status}`);
    }
    const cardInfo = await cardRes.json();
    const cardName = cardInfo.name.trim();

    // parse ad copy fields from card description
    const lines = (cardInfo.desc || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    const fieldMap = {};
    for (const line of lines) {
      const [rawKey, ...rest] = line.split(':');
      if (!rawKey || rest.length === 0) continue;
      fieldMap[rawKey.trim().toLowerCase()] = rest.join(':').trim();
    }

    const primaryText     = fieldMap['primary text']      || '';
    const headline        = fieldMap['headline']          || '';
    const descriptionText = fieldMap['description']       || '';
    const callToAction    = fieldMap['call to action']    || '';
    const clickUrl        = fieldMap['click through url'] || '';

    // map Trello client → Adpiler campaign ID
    const clientKey  = cardName.split(':')[0].trim().toLowerCase();
    const campaignId = clientMap[clientKey];
    if (!campaignId) {
      console.error(`❌ No campaign for "${clientKey}"`);
      return res.status(400).json({ error: `No campaign for ${clientKey}` });
    }

    // fetch and download attachments
    const attachments = await getCardAttachments(cardId);

    // build FormData
    const form = new FormData();
    form.append('primary_text',      primaryText);
    form.append('headline',          headline);
    form.append('description',       descriptionText);
    form.append('call_to_action',    callToAction);
    form.append('click_through_url', clickUrl);

    for (const att of attachments) {
      try {
        const buf = await downloadTrelloAttachment(cardId, att);
        form.append('files[]', buf, att.name);
      } catch (err) {
        console.error(`❌ download ${att.name} failed:`, err.message);
      }
    }

    // upload to Adpiler
    const apiRes = await fetch(
      `https://api.adpiler.com/v1/campaigns/${campaignId}/ads`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ADPILER_API_KEY}`,
          ...form.getHeaders(),
        },
        body: form,
      }
    );

    if (!apiRes.ok) {
      const body = await apiRes.text();
      console.error(`❌ Adpiler ${apiRes.status}:`, body);
      return res.status(apiRes.status).send(body);
    }

    console.log(`✅ Uploaded "${cardName}" to campaign ${campaignId}`);
    return res.sendStatus(200);

  } catch (err) {
    console.error('❌ Handler error:', err.message);
    return res.status(500).send('Internal server error');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});

