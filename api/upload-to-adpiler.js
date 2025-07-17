import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import csv from 'csvtojson';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const CLIENT_CSV_URL =
  process.env.CLIENT_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const TARGET_LIST_NAME = process.env.TARGET_LIST_NAME || 'READY FOR ADPILER';
const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const ADPILER_API_KEY = process.env.ADPILER_API_KEY;
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID;

let clientMap = {};

async function refreshClientMap() {
  try {
    console.log('🔄 Refreshing client map from sheet…');
    const res = await fetch(CLIENT_CSV_URL, { timeout: 15000 });
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
await refreshClientMap();
setInterval(refreshClientMap, 1000 * 60 * 60);

// Helper: Get all attachments for a Trello card
async function getCardAttachments(cardId) {
  const url = `https://api.trello.com/1/cards/${cardId}/attachments?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`Failed to fetch attachments: ${res.status}`);
  return res.json();
}

// Helper: Download an attachment robustly
async function downloadTrelloAttachment(cardId, att) {
  // 1. Try the meta url (often public)
  let fileRes = await fetch(att.url, { redirect: 'follow', timeout: 15000 });
  if (!fileRes.ok) {
    // 2. Try the Trello authenticated download endpoint
    const trelloDownloadUrl = `https://api.trello.com/1/cards/${cardId}/attachments/${att.id}/download?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
    fileRes = await fetch(trelloDownloadUrl, { redirect: 'follow', timeout: 15000 });
    if (!fileRes.ok) {
      throw new Error(`Download failed ${fileRes.status}: ${fileRes.statusText}`);
    }
  }
  return await fileRes.buffer();
}

// Helper: Get list id by name from board
async function getListIdByName(boardId, listName) {
  const url = `https://api.trello.com/1/boards/${boardId}/lists?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(url, {timeout: 10000});
  if (!res.ok) throw new Error(`Failed to fetch lists: ${res.status}`);
  const lists = await res.json();
  const list = lists.find(l => l.name.trim().toLowerCase() === listName.trim().toLowerCase());
  return list ? list.id : null;
}

// Helper: Find cardId by name within a specific list
async function findCardIdByName(cardName, boardId, listName) {
  const listId = await getListIdByName(boardId, listName);
  if (!listId) return null;
  const url = `https://api.trello.com/1/lists/${listId}/cards?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(url, {timeout: 10000});
  if (!res.ok) throw new Error(`Failed to fetch cards: ${res.status}`);
  const cards = await res.json();
  const card = cards.find(c => c.name.trim() === cardName.trim());
  return card ? card.id : null;
}

app.head('/upload-to-adpiler', (_req, res) => res.sendStatus(200));
app.get('/', (_req, res) => res.send('OK'));

app.post('/upload-to-adpiler', async (req, res) => {
  try {
    const action = req.body.action;
    if (action?.type !== 'updateCard' || !action.data?.listAfter) return res.sendStatus(200);

    const listName = action.data.listAfter.name;
    if (listName !== TARGET_LIST_NAME) return res.sendStatus(200);

    let card = action.data.card;
    let cardId = card.id;
    let cardName = card.name;

    // Failsafe: If cardId is missing, search for it by name
    if (!cardId) {
      cardId = await findCardIdByName(cardName, TRELLO_BOARD_ID, TARGET_LIST_NAME);
      if (!cardId) {
        console.error(`❌ Could not find card "${cardName}" in list "${TARGET_LIST_NAME}"`);
        return res.status(404).json({ error: 'Card not found' });
      }
    }

    // Get Adpiler clientId from mapping
    const clientName = cardName.split(':')[0].trim().toLowerCase();
    const clientId = clientMap[clientName];
    if (!clientId) {
      console.error(`❌ No Adpiler client found for "${clientName}"`);
      return res.status(400).json({ error: `No Adpiler client for ${clientName}` });
    }

    // Get attachments
    let attachments = [];
    try {
      attachments = await getCardAttachments(cardId);
    } catch (err) {
      console.error('❌ Failed to fetch attachments from Trello:', err.message);
      return res.status(500).json({ error: 'Failed to fetch attachments from Trello' });
    }

    if (!attachments.length) {
      console.log(`ℹ️  No attachments on "${cardName}"`);
      return res.sendStatus(200);
    }

    // Upload each attachment robustly
    for (const att of attachments) {
      try {
        const buffer = await downloadTrelloAttachment(cardId, att);
        const form = new FormData();
        form.append('name', att.name);
        form.append('file', buffer, att.name);

        const apiRes = await fetch(
          `https://platform.adpiler.com/api/campaigns/${clientId}/ads`,
          {
            method: 'POST',
            headers: { 'X-API-KEY': ADPILER_API_KEY },
            body: form,
            timeout: 20000,
          },
        );

        if (!apiRes.ok) {
          const text = await apiRes.text();
          throw new Error(`Adpiler upload failed ${apiRes.status}: ${text.substring(0, 200)}`);
        }

        console.log(`✅ Uploaded ${att.name} to campaign ${clientId}`);
      } catch (err) {
        console.error('❌ Upload error:', err.message, 'Attachment:', att.name, att.id, att.url);
        // Continue to next attachment
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('❌ Top-level error:', e.message, e.stack);
    res.status(500).send('Internal server error');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});
