// server.js
const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const fetch = require('node-fetch');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// --- Simple in-process queue ---
const jobQueue = [];
let processing = false;
function enqueueJob(fn) {
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

// --- Cooldown to prevent double-handling ---
const lastRun = new Map();
const COOLDOWN_MS = 2 * 60 * 1000;

// --- Helpers / config ---
const normalize = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const READY_LIST_NAME = normalize(process.env.READY_LIST_NAME || 'Ready For AdPiler');
const UPLOAD_MODE = (process.env.ADPILER_UPLOAD_MODE || 'api').toString().trim().toLowerCase();

app.use(bodyParser.json({ limit: '5mb' }));

// ---------- Uploader resolver (tolerates default/named exports) ----------
function resolveUploader(mod) {
  if (!mod) return null;
  if (typeof mod === 'function') return mod;                       // default = function
  if (typeof mod.uploadToAdpiler === 'function') return mod.uploadToAdpiler; // named
  if (typeof mod.default === 'function') return mod.default;       // ES default
  return null;
}

let uploadApiMod = null;
let uploadUIMod = null;
try {
  uploadApiMod = require('./upload-to-adpiler');
  console.log('✅ Loaded upload-to-adpiler.js');
} catch (e) {
  console.error('❌ Failed to load upload-to-adpiler.js:', e.message);
}
try {
  uploadUIMod = require('./upload-to-adpiler-ui');
  console.log('✅ Loaded upload-to-adpiler-ui.js');
} catch (e) {
  console.error('❌ Failed to load upload-to-adpiler-ui.js:', e.message);
}

const uploadApi = resolveUploader(uploadApiMod);
const uploadUI  = resolveUploader(uploadUIMod);

console.log('🧪 ADPILER_UPLOAD_MODE =', UPLOAD_MODE);
console.log('🧪 uploader api type =', typeof uploadApi);
console.log('🧪 uploader ui  type =', typeof uploadUI);

// ---------- Health checks ----------
app.get('/', (_req, res) => res.status(200).send(`✅ Trello → AdPiler is running (mode: ${UPLOAD_MODE})`));
app.head('/trello-webhook', (_req, res) => res.sendStatus(200));
app.get('/trello-webhook', (_req, res) => res.status(200).send('OK'));

// ---------- Trello helpers ----------
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

// ---------- Webhook ----------
app.post('/trello-webhook', async (req, res) => {
  res.sendStatus(200); // acknowledge immediately
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

    await enqueueJob(async () => {
      let result = null;

      if (UPLOAD_MODE === 'api' && uploadApi) {
        console.log('🚀 Using API uploader...');
        result = await uploadApi(card, card.attachments, { postTrelloComment });
      } else if (UPLOAD_MODE === 'ui' && uploadUI) {
        console.log('🧭 Using UI uploader...');
        result = await uploadUI(card, card.attachments, { postTrelloComment });
      } else {
        console.error('🔍 uploadApi keys:', Object.keys(uploadApiMod || {}));
        console.error('🔍 uploadUIMod keys:', Object.keys(uploadUIMod || {}));
        throw new Error('No uploader available. Ensure ADPILER_UPLOAD_MODE=ui or api and the corresponding export exists.');
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

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT} (mode: ${UPLOAD_MODE})`);
});
