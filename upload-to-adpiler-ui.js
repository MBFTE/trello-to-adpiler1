// upload-to-adpiler-ui.js
// Browserless/Puppeteer UI automation for Trello → AdPiler

const fs = require('fs');
const os = require('os');
const path = require('path');
const fetch = require('node-fetch');
const csv = require('csvtojson');
const puppeteer = require('puppeteer-core');

const {
  // Trello
  TRELLO_API_KEY,
  TRELLO_TOKEN,

  // Mapping
  CLIENT_CSV_URL,          // published CSV (Google Sheets → "Publish to web" → CSV)
  DEFAULT_CLIENT_ID,       // optional fallback (e.g., 69144)
  DEFAULT_PROJECT_ID,      // optional fallback (e.g., Adpiler Campaign ID)

  // AdPiler login + tenant
  ADPILER_USER,
  ADPILER_PASS,
  ADPILER_LOGIN_URL,       // e.g., https://platform.adpiler.com/login
  ADPILER_BASE_URL,        // optional base like https://platform.adpiler.com

  // Browserless connection
  BROWSERLESS_WS_URL,      // e.g., wss://chrome.browserless.io?token=XXXXX
  BROWSERLESS_URL,         // alt: https://chrome.browserless.io
  BROWSERLESS_TOKEN,       // alt token used with BROWSERLESS_URL

  // Debug
  DEBUG_UI
} = process.env;

/* ------------------------- Browserless helpers ------------------------- */

function wsEndpoint() {
  if (BROWSERLESS_WS_URL) return BROWSERLESS_WS_URL;
  if (BROWSERLESS_URL && BROWSERLESS_TOKEN) {
    const u = new URL(BROWSERLESS_URL);
    u.protocol = u.protocol.replace('http', 'ws');
    u.searchParams.set('token', BROWSERLESS_TOKEN);
    return u.toString();
  }
  throw new Error('Missing Browserless endpoint (set BROWSERLESS_WS_URL or BROWSERLESS_URL + BROWSERLESS_TOKEN).');
}

async function connectWithRetry(endpoint, attempts = 5) {
  let delay = 2000;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await puppeteer.connect({ browserWSEndpoint: endpoint });
    } catch (e) {
      const msg = String(e && (e.message || e));
      if (msg.includes('429') || msg.includes('Too Many Requests')) {
        console.warn(`Browserless 429; retrying in ${delay}ms (attempt ${i}/${attempts})`);
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 15000);
        continue;
      }
      throw e;
    }
  }
  throw new Error('Failed to connect to Browserless after retries');
}

/* --------------------------- Mapping helpers --------------------------- */
/**
 * Your CSV headers (per screenshot):
 * - "Trello Client Name"
 * - "Adpiler Client ID"
 * - "Trello List Name"
 * - "Adpiler Folder ID"
 * - "Adpiler Campaign ID"
 */
async function getClientMapping(cardName /*, cardListName? */) {
  const DEF_CLIENT = (DEFAULT_CLIENT_ID || '').toString().trim();
  const DEF_PROJECT = (DEFAULT_PROJECT_ID || '').toString().trim(); // can represent Campaign/Project ID

  // No CSV? fall back if provided
  if (!CLIENT_CSV_URL) {
    if (DEF_CLIENT) return { clientId: DEF_CLIENT, projectId: DEF_PROJECT, folderId: '', campaignId: DEF_PROJECT };
    throw new Error('CLIENT_CSV_URL not set and no DEFAULT_CLIENT_ID provided');
  }

  const res = await fetch(CLIENT_CSV_URL);
  if (!res.ok) throw new Error(`Mapping CSV fetch failed (${res.status})`);
  const text = await res.text();
  const rows = await csv().fromString(text);

  const n = s => (s || '').toLowerCase().trim();

  // Primary match: card title contains "Trello Client Name"
  let match = rows.find(r => n(cardName).includes(n(r['Trello Client Name'])));

  // If you want to match by Trello list name instead, pass it in and enable this:
  // if (!match && cardListName) {
  //   match = rows.find(r => n(cardListName) === n(r['Trello List Name']));
  // }

  if (match) {
    const clientId   = (match['Adpiler Client ID'] || '').toString().trim();
    const folderId   = (match['Adpiler Folder ID'] || '').toString().trim();
    const campaignId = (match['Adpiler Campaign ID'] || '').toString().trim();
    if (clientId) return { clientId, projectId: campaignId, folderId, campaignId };
  }

  // Fallback
  if (DEF_CLIENT) {
    console.warn(`No CSV match for "${cardName}". Falling back to DEFAULT_CLIENT_ID.`);
    return { clientId: DEF_CLIENT, projectId: DEF_PROJECT, folderId: '', campaignId: DEF_PROJECT };
  }

  throw new Error(`No client mapping found for card name "${cardName}"`);
}

/* ---------------------------- Trello helpers --------------------------- */

async function downloadAttachmentToTemp(attachmentId, filenameHint = '') {
  const auth = `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const dlUrl = `https://api.trello.com/1/attachments/${attachmentId}/download?${auth}`;
  const res = await fetch(dlUrl);
  if (!res.ok) throw new Error(`Failed to download attachment ${attachmentId} (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const name = filenameHint || `asset-${attachmentId}`;
  const tmp = path.join(os.tmpdir(), name);
  fs.writeFileSync(tmp, buf);
  return tmp;
}

function extractAdMetaFromCard(card) {
  const desc = card.desc || '';
  const grab = (label) => {
    const rx = new RegExp(`${label}:\s*(.+)`, 'i');
    const m = desc.match(rx);
    return m ? m[1].trim() : '';
  };
  const url = grab('Click Through URL') || grab('Landing Page URL') || grab('URL') || grab('Link');
  const ctaRaw = grab('Call To Action') || grab('CTA');
  let displayLink = '';
  try { if (url) displayLink = new URL(url).hostname.replace(/^www\./,''); } catch {}
  const primary = grab('Primary Text') || grab('Primary');
  const shortDesc = grab('Description');
  const combinedDesc = `${primary} ${shortDesc}`.trim();

  return {
    headline:    grab('Headline'),
    description: combinedDesc || shortDesc || primary,
    cta:         (ctaRaw || '').toUpperCase().replace(/\s+/g, '_'),
    url,
    displayLink
  };
}

/* ------------------------------- UI utils ------------------------------ */

async function clickByText(page, text) {
  const [el] = await page.$x(`//*[contains(normalize-space(text()), "${text}")]`);
  if (!el) throw new Error(`Could not find element with text: ${text}`);
  await el.click();
}

async function logStep(msg) { if (DEBUG_UI) console.log(`🔎 UI: ${msg}`); }

/* ------------------------------- Main run ------------------------------ */

async function uploadToAdpilerUI(card, attachments, { postTrelloComment } = {}) {
  if (!ADPILER_USER || !ADPILER_PASS) throw new Error('Missing ADPILER_USER/ADPILER_PASS');
  if (!ADPILER_LOGIN_URL) throw new Error('Missing ADPILER_LOGIN_URL');

  const browser = await connectWithRetry(wsEndpoint());
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);

  const meta = extractAdMetaFromCard(card);
  const mapping = await getClientMapping(card.name /*, card.listNameIfYouPassIt */);

  const tmpFiles = [];
  try {
    /* 1) Login */
    await logStep('Navigating to login');
    await page.goto(ADPILER_LOGIN_URL, { waitUntil: 'networkidle2' });

    await logStep('Typing credentials');
    await page.type('input[type="email"], input[name="email"]', ADPILER_USER, { delay: 10 });
    await page.type('input[type="password"], input[name="password"]', ADPILER_PASS, { delay: 10 });
    await Promise.all([
      page.click('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")').catch(() => clickByText(page, 'Log in')),
      page.waitForNavigation({ waitUntil: 'networkidle2' })
    ]);

    /* 2) Navigate to client/project (tenant-specific) */
    // If you have a direct URL pattern for client/campaign, you can jump straight there:
    // Example patterns — adjust to your tenant’s real URLs if available:
    // if (ADPILER_BASE_URL && mapping.clientId) {
    //   await logStep(`Opening client ${mapping.clientId}`);
    //   await page.goto(`${ADPILER_BASE_URL}/clients/${mapping.clientId}`, { waitUntil: 'networkidle2' });
    // }
    // if (ADPILER_BASE_URL && mapping.campaignId) {
    //   await logStep(`Opening campaign ${mapping.campaignId}`);
    //   await page.goto(`${ADPILER_BASE_URL}/campaigns/${mapping.campaignId}`, { waitUntil: 'networkidle2' });
    // }

    /* 3) Start "New Ad" / Upload flow */
    await logStep('Opening New Ad / Upload flow');
    try { await clickByText(page, 'New Ad'); } catch { await clickByText(page, 'Upload'); }
    await page.waitForSelector('input[type="file"], input[name="headline"], input[name="title"]', { timeout: 30000 });

    /* 4) Download & attach files */
    await logStep('Downloading attachments');
    for (const att of (attachments || [])) {
      if (!att?.id) continue;
      const tmp = await downloadAttachmentToTemp(att.id, att.name || `asset-${att.id}`);
      tmpFiles.push(tmp);
    }

    await logStep(`Uploading ${tmpFiles.length} file(s)`);
    const fileInput = await page.$('input[type="file"]');
    if (fileInput && tmpFiles.length) await fileInput.uploadFile(...tmpFiles);

    /* 5) Fill metadata (best-effort; adjust selectors to match tenant) */
    const setIfExists = async (selectors, value) => {
      if (!value) return;
      for (const sel of selectors) {
        const el = await page.$(sel);
        if (el) {
          await el.click({ clickCount: 3 }).catch(() => {});
          await page.type(sel, value, { delay: 5 });
          return;
        }
      }
    };

    await logStep('Filling metadata fields');
    await setIfExists(['input[name="headline"]','input[name="title"]','input[placeholder*="Headline"]'], meta.headline);
    await setIfExists(['textarea[name="description"]','textarea[placeholder*="Description"]'], meta.description);
    await setIfExists(['input[name="cta"]','input[placeholder*="CTA"]'], meta.cta);
    await setIfExists(['input[name="url"]','input[name="click_url"]','input[placeholder*="URL"]'], meta.url);

    /* 6) Submit */
    await logStep('Submitting');
    try { await clickByText(page, 'Create'); } catch { await clickByText(page, 'Save'); }

    /* 7) Harvest preview/share URLs */
    await page.waitForTimeout(1500);
    const anchors = await page.$$eval('a', as => as.map(a => a.href).filter(Boolean));
    const previewUrls = anchors.filter(u => /preview|share/i.test(u));

    await logStep(`Done. Found ${previewUrls.length} preview URL(s).`);

    // Optional: let Trello know if we fell back to default mapping
    if (!CLIENT_CSV_URL || !previewUrls.length) {
      if (DEFAULT_CLIENT_ID && postTrelloComment) {
        try { await postTrelloComment(card.id, `No CSV match for "${card.name}" – used DEFAULT_CLIENT_ID=${DEFAULT_CLIENT_ID}.`); } catch (_) {}
      }
    }

    return { previewUrls };
  } catch (err) {
    if (DEBUG_UI) {
      try {
        const shot = path.join(os.tmpdir(), `adpiler-ui-fail-${Date.now()}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        console.error('UI failed. Screenshot saved at:', shot);
      } catch (_) {}
    }
    throw err;
  } finally {
    // cleanup temp files and session
    try { tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch(_){} }); } catch(_) {}
    try { await page.close(); } catch(_) {}
    try { await browser.disconnect(); } catch(_) {}
  }
}

module.exports = { uploadToAdpilerUI };
