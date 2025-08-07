// server.js
const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const fetch = require('node-fetch');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// --- Simple in-process queue & cooldown to avoid Browserless 429s ---
const jobQueue = [];
let processing = false;
async function enqueueJob(fn) {
  return new Promise((resolve, reject) => {
    jobQueue.push({ fn, resolve, reject });
    processQueue();
  });
}
async function processQueue() {
  if (processing) return;
  processing = true;
  while (jobQueue.length) {
    const { fn, resolve, reject } = jobQueue.shift();
    try { resolve(await fn()); } catch (e) { reject(e); }
  }
  processing = false;
}
const lastRun = new Map();
const COOLDOWN_MS = 2 * 60 * 1000;

// Normalize helper (case/space tolerant)
const normalize = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Which list should trigger uploads?
const READY_LIST_NAME = normalize(process.env.READY_LIST_NAME || 'Ready For AdPiler');

// Mode: 'ui' (Browserless) or 'api' (AdPiler API)
const UPLOAD_MODE = (process.env.ADPILER_UPLOAD_MODE || 'ui').toLowerCase();

// Lazy imports so either mode works
let uploadApi, uploadUI;
try { uploadApi = require('./upload-to-adpiler'); } catch (_) {}
try { uploadUI = require('./upload-to-adpiler-ui'); } catch (_) {}

app.use(bodyParser.json({ limit: '5mb' }));

// Health/handshake
app.get('/', (_req, res) => res.status(200).send(`✅ Trello → AdPiler is running (mode: ${UPLOAD_MODE})`));
app.head('/trello-webhook', (_req, res) => res.sendStatus(200));
app.get('/trello-webhook', (_req, res) => res.status(200).send('OK'));

// Helpers
async function getFullCard(cardId) {
  const auth = `key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`;
  const base = `https://api.trello.com/1/cards/${cardId}`;

  const fieldsRes = await fetch(`${base}?fields=name,desc,idList&customFieldItems=true&${auth}`);
  if (!fieldsRes.ok) throw new Error(`Failed to fetch card fields (${fieldsRes.status})`);
  const card = await fieldsRes.json();

  const labelsRes = await fetch(`${base}/labels?${auth}`);
  card.labels = labelsRes.ok ? await labelsRes.json() : [];

  const attsRes = await fetch(`${base}/attachments?fields=all&${auth}`);
  card.attachments = attsRes.ok ? await attsRes.json() : [];

  return card;
}

async function postTrelloComment(cardId, text) {
  const auth = `key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`;
  const url = `https://api.trello.com/1/cards/${cardId}/actions/comments?${auth}&text=${encodeURIComponent(text)}`;
  await fetch(url, { method: 'POST' }).catch(e => console.error('Comment post failed:', e.message));
}

// Webhook handler
app.post('/trello-webhook', async (req, res) => {
  res.sendStatus(200); // ack fast so Trello keeps the webhook active
  try {
    const type = req.body?.action?.type;
    const listAfter = req.body?.action?.data?.listAfter?.name || '';
    const cardId = req.body?.action?.data?.card?.id || '';

    console.log(`📬 Webhook: type=${type || 'n/a'} listAfter="${listAfter}" cardId=${cardId || 'n/a'}`);
    if (type !== 'updateCard' || !listAfter || !cardId) return;

    const movedTo = normalize(listAfter);
    if (movedTo !== READY_LIST_NAME) {
      console.log(`↪️  Ignored (moved to "${listAfter}", expecting "${process.env.READY_LIST_NAME || 'Ready For AdPiler'}")`);
      return;
    }

    console.log(`➡️  Card moved to "${movedTo}": ${cardId} — fetching card details...`);
    const card = await getFullCard(cardId);
    console.log(`🗂️  Card "${card.name}" with ${card.attachments?.length || 0} attachment(s).`);

    // cooldown per card
    const prev = lastRun.get(cardId) || 0;
    const now = Date.now();
    if (now - prev < COOLDOWN_MS) {
      console.log(`⏳ Skip duplicate for ${cardId} (cooldown)`);
      return;
    }
    lastRun.set(cardId, now);

    // enqueue one-at-a-time
    await enqueueJob(async () => {
      let result = null;

      if (UPLOAD_MODE === 'api' && uploadApi?.uploadToAdpiler) {
        console.log('🚀 Using API uploader...');
        result = await uploadApi.uploadToAdpiler(card, card.attachments, { postTrelloComment });
      } else if (UPLOAD_MODE === 'ui' && uploadUI?.uploadToAdpilerUI) {
        console.log('🧭 Using UI uploader (Browserless/Puppeteer)...');
        result = await uploadUI.uploadToAdpilerUI(card, card.attachments, { postTrelloComment });
      } else {
        throw new Error('No uploader available. Ensure ADPILER_UPLOAD_MODE=ui or api and the corresponding file exists.');
      }

      const urls = result?.previewUrls || [];
      if (urls.length) {
        console.log('✅ Upload complete. Preview URLs:', urls);
        await postTrelloComment(cardId, `Uploaded to AdPiler:\n${urls.join('\n')}`);
      } else {
        console.log('✅ Upload complete (no preview URLs returned).');
        await postTrelloComment(cardId, 'Uploaded to AdPiler.');
      }
    });

  } catch (e) {
    console.error('💥 Webhook handler error:', e);
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT} (mode: ${UPLOAD_MODE})`);
});

