// api/upload-to-adpiler.js

import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import csv from 'csvtojson';

const app = express();
app.use(express.json());

const PORT              = process.env.PORT;  // Render sets this
const CLIENT_CSV_URL    = process.env.CLIENT_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const TARGET_LIST_NAME  = process.env.TARGET_LIST_NAME || 'READY FOR ADPILER';
const TRELLO_API_KEY    = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN      = process.env.TRELLO_TOKEN;
const TRELLO_BOARD_ID   = process.env.TRELLO_BOARD_ID;
const ADPILER_API_KEY   = process.env.ADPILER_API_KEY;

let clientMap = {};

/**
 * Refresh the mapping from Trello client name → Adpiler client ID
 */
async function refreshClientMap() {
  try {
    console.log('🔄 Refreshing client map from sheet…');
    const res = await fetch(CLIENT_CSV_URL, { timeout: 15_000 });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const text = await res.text();
    const rows = await csv().fromString(text);

    const map = {};
    for (const row of rows) {
      const trelloName = row['Trello Client Name']?.trim()?.toLowerCase();
      const adpilerId  = row['Adpiler Client ID']?.trim();
      if (trelloName && adpilerId) {
        map[trelloName] = adpilerId;
      }
    }

    clientMap = map;
    console.log('✅ Loaded clients:', Object.keys(clientMap).join(', '));
  } catch (err) {
    console.error('❌ Failed to fetch CSV:', err.message);
  }
}

// do it at startup, then every hour
await refreshClientMap();
setInterval(refreshClientMap, 1000 * 60 * 60);

/**
 * Fetch attachments metadata for a card
 */
async function getCardAttachments(cardId) {
  const url = `https://api.trello.com/1/cards/${cardId}/attachments`
    + `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(url, { timeout: 10_000 });
  if (!res.ok) throw new Error(`getCardAttachments ${res.status}`);
  return res.json();
}

/**
 * Download one Trello attachment, trying public URL then authenticated
 */
async function downloadTrelloAttachment(cardId, att) {
  let fileRes = await fetch(att.url, { redirect: 'follow', timeout: 15_000 });
  if (!fileRes.ok) {
    const dl = `https://api.trello.com/1/cards/${cardId}`
      + `/attachments/${att.id}/download`
      + `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
    fileRes = await fetch(dl, { redirect: 'follow', timeout: 15_000 });
    if (!fileRes.ok) {
      throw new Error(`download failed ${fileRes.status}`);
    }
  }
  const buf = await fileRes.arrayBuffer();
  return Buffer.from(buf);
}

// simple health checks
app.head('/upload-to-adpiler', (_req, res) => res.sendStatus(200));
app.get('/', (_req, res) => res.send('OK'));

/**
 * Webhook endpoint: fire when a card moves into TARGET_LIST_NAME
 * Then: fetch card details, parse five fields from description,
 * download attachments, and upload everything to Adpiler.
 */
app.post('/upload-to-adpiler', async (req, res) => {
  try {
    const action = req.body.action;

    // only handle updateCard → moved into our target list
    if (
      action?.type !== 'updateCard' ||
      action.data?.listAfter?.name !== TARGET_LIST_NAME
    ) {
      return res.sendStatus(200);
    }

    // get the new card’s ID
    const cardId = action.data.card.id;

    // fetch full card info (name, desc, url)
    const cardRes = await fetch(
      `https://api.trello.com/1/cards/${cardId}`
      + `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
      + `&fields=name,desc,url`
    );
    if (!cardRes.ok) {
      throw new Error(`fetch card info ${cardRes.status}`);
    }
    const cardInfo = await cardRes.json();
    const cardName = cardInfo.name.trim();

    // parse the five ad fields from the description
    const lines = (cardInfo.desc || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    const fieldMap = {};
    for (const line of lines) {
      const [rawKey, ...rest] = line.split(':');
      if (!rawKey || !rest.length) continue;
      fieldMap[rawKey.trim().toLowerCase()] = rest.join(':').trim();
    }

    const primaryText     = fieldMap['primary text']      || '';
    const headline        = fieldMap['headline']          || '';
    const descriptionText = fieldMap['description']       || '';
    const callToAction    = fieldMap['call to action']    || '';
    const clickUrl        = fieldMap['click through url'] || '';

    // lookup Adpiler campaign ID
    const clientKey = cardName.split(':')[0].trim().toLowerCase();
    const campaignId = clientMap[clientKey];
    if (!campaignId) {
      console.error(`❌ No Adpiler client for ${clientKey}`);
      return res.status(400).json({ error: `No client for ${clientKey}` });
    }

    // fetch attachments metadata
    let attachments = [];
    try {
      attachments = await getCardAttachments(cardId);
    } catch (err) {
      console.error('❌ Trello attachments error:', err.message);
      return res.status(500).json({ error: 'Trello attachment fetch error' });
    }

    // build FormData payload
    const form = new FormData();
    form.append('primary_text',      primaryText);
    form.append('headline',          headline);
    form.append('description',       descriptionText);
    form.append('call_to_action',    callToAction);
    form.append('click_through_url', clickUrl);

    // attach every image file
    for (const att of attachments) {
      try {
        const buf = await downloadTrelloAttachment(cardId, att);
        form.append('files', buf, att.name);
      } catch (err) {
        console.error(`❌ Download attachment "${att.name}" failed:`, err.message);
      }
    }

    // POST to Adpiler
    const apiRes = await fetch(
      `https://platform.adpiler.com/api/campaigns/${campaignId}/ads`,
      {
        method: 'POST',
        headers: {
          'X-API-KEY': ADPILER_API_KEY,
          ...form.getHeaders()
        },
        body: form,
        timeout: 20_000
      }
    );

    if (!apiRes.ok) {
      const body = await apiRes.text();
      console.error(`❌ Adpiler upload failed ${apiRes.status}:`, body);
      return res.status(apiRes.status).send(body);
    }

    console.log(`✅ Uploaded "${cardName}" to campaign ${campaignId}`);
    return res.sendStatus(200);

  } catch (err) {
    console.error('❌ Handler error:', err.message);
    return res.status(500).send('Internal server error');
  }
});

// start server
app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});
