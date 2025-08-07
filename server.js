const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const fetch = require('node-fetch');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const READY_LIST_NAME = (process.env.READY_LIST_NAME || 'Ready For AdPiler').toLowerCase();
const UPLOAD_MODE = (process.env.ADPILER_UPLOAD_MODE || 'ui').toLowerCase();

let uploadApi, uploadUI;
try { uploadApi = require('./upload-to-adpiler'); } catch(_) {}
try { uploadUI = require('./upload-to-adpiler-ui'); } catch(_) {}

app.use(bodyParser.json());

// Trello webhook handshake
app.head('/trello-webhook', (req, res) => res.sendStatus(200));
app.get('/trello-webhook', (req, res) => res.status(200).send('OK'));

// Health
app.get('/', (req, res) => res.send(`✅ Trello → AdPiler is running (mode: ${UPLOAD_MODE})`));

// Helpers
async function getFullCard(cardId) {
  const base = `https://api.trello.com/1/cards/${cardId}`;
  const auth = `key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`;

  const fieldsRes = await fetch(`${base}?fields=name,desc,idList&customFieldItems=true&${auth}`);
  if (!fieldsRes.ok) throw new Error(`Failed to fetch card fields (${fieldsRes.status})`);
  const card = await fieldsRes.json();

  const labelsRes = await fetch(`${base}/labels?${auth}`);
  card.labels = labelsRes.ok ? await labelsRes.json() : [];

  const attachmentsRes = await fetch(`${base}/attachments?fields=all&${auth}`);
  card.attachments = attachmentsRes.ok ? await attachmentsRes.json() : [];

  return card;
}

async function postTrelloComment(cardId, text) {
  const base = `https://api.trello.com/1/cards/${cardId}/actions/comments`;
  const auth = `key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`;
  await fetch(`${base}?${auth}&text=${encodeURIComponent(text)}`, { method: 'POST' });
}

// Webhook handler
app.post('/trello-webhook', async (req, res) => {
  res.sendStatus(200); // ack fast

  try {
    const action = req.body && req.body.action;
    if (!action) return;

    if (action.type === 'updateCard' && action.data && action.data.listAfter) {
      const listAfterName = (action.data.listAfter.name || '').toLowerCase();
      if (listAfterName === READY_LIST_NAME) {
        const cardId = action.data.card.id;
        const card = await getFullCard(cardId);

        let result = null;
        if (UPLOAD_MODE === 'api' && uploadApi?.uploadToAdpiler) {
          result = await uploadApi.uploadToAdpiler(card, card.attachments, { postTrelloComment });
        } else if (UPLOAD_MODE === 'ui' && uploadUI?.uploadToAdpilerUI) {
          result = await uploadUI.uploadToAdpilerUI(card, card.attachments, { postTrelloComment });
        } else {
          console.error('No upload mode available. Set ADPILER_UPLOAD_MODE to "ui" or "api".');
          return;
        }

        if (result?.previewUrls?.length) {
          await postTrelloComment(cardId, `Uploaded to AdPiler:\n${result.previewUrls.join('\n')}`);
        } else {
          await postTrelloComment(cardId, `Uploaded to AdPiler.`);
        }
      }
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT} (mode: ${UPLOAD_MODE})`);
});

