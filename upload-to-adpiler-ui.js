// Browserless/puppeteer UI automation for Trello → AdPiler
const fs = require('fs');
const os = require('os');
const path = require('path');
const fetch = require('node-fetch');
const csv = require('csvtojson');
const puppeteer = require('puppeteer-core');

const {
  TRELLO_API_KEY,
  TRELLO_TOKEN,
  CLIENT_CSV_URL,
  ADPILER_USER,
  ADPILER_PASS,
  ADPILER_LOGIN_URL, // e.g., https://platform.adpiler.com/login
  ADPILER_BASE_URL,  // optional base, e.g., https://platform.adpiler.com
  BROWSERLESS_WS_URL,
  BROWSERLESS_URL,
  BROWSERLESS_TOKEN,
  DEBUG_UI
} = process.env;

function wsEndpoint() {
  if (BROWSERLESS_WS_URL) return BROWSERLESS_WS_URL;
  if (BROWSERLESS_URL && BROWSERLESS_TOKEN) {
    const u = new URL(BROWSERLESS_URL);
    u.protocol = u.protocol.replace('http', 'ws');
    u.searchParams.set('token', BROWSERLESS_TOKEN);
    return u.toString();
  }
  throw new Error('Missing Browserless endpoint (BROWSERLESS_WS_URL or BROWSERLESS_URL + BROWSERLESS_TOKEN).');
}

async function getClientMapping(cardName) {
  if (!CLIENT_CSV_URL) throw new Error('CLIENT_CSV_URL not set');
  const res = await fetch(CLIENT_CSV_URL);
  if (!res.ok) throw new Error(`Mapping CSV fetch failed (${res.status})`);
  const rows = await csv().fromString(await res.text());
  const n = s => (s || '').toLowerCase().trim();
  const match = rows.find(r => n(cardName).includes(n(r['Trello Client Name'])));
  if (!match || !match.clientId) throw new Error(`No mapping found for "${cardName}"`);
  return { clientId: match.clientId, projectId: match.projectId || '' };
}

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
    const m = desc.match(new RegExp(`${label}:\\s*(.+)`, 'i'));
    return m ? m[1].trim() : '';
  };
  return {
    headline:    grab('Headline'),
    description: grab('Description'),
    cta:         grab('CTA'),
    url:         grab('URL')
  };
}

async function clickByText(page, text) {
  const [el] = await page.$x(`//*[contains(normalize-space(text()), "${text}")]`);
  if (!el) throw new Error(`Could not find element with text: ${text}`);
  await el.click();
}

async function logStep(msg) { if (DEBUG_UI) console.log(`🔎 UI: ${msg}`); }

async function uploadToAdpilerUI(card, attachments, { postTrelloComment } = {}) {
  if (!ADPILER_USER || !ADPILER_PASS) throw new Error('Missing ADPILER_USER/ADPILER_PASS');
  if (!ADPILER_LOGIN_URL) throw new Error('Missing ADPILER_LOGIN_URL');

  const browser = await connectWithRetry(wsEndpoint());
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);

  const meta = extractAdMetaFromCard(card);
  const mapping = await getClientMapping(card.name);

  const tmpFiles = [];
  try {
    await logStep('Navigating to login');
    await page.goto(ADPILER_LOGIN_URL, { waitUntil: 'networkidle2' });

    await logStep('Typing credentials');
    await page.type('input[type="email"], input[name="email"]', ADPILER_USER, { delay: 10 });
    await page.type('input[type="password"], input[name="password"]', ADPILER_PASS, { delay: 10 });
    await Promise.all([
      page.click('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")').catch(() => clickByText(page, 'Log in')),
      page.waitForNavigation({ waitUntil: 'networkidle2' })
    ]);

    // Navigate to client/project if you have a deterministic URL structure in your tenant.
    // Example (adjust/enable if your tenant supports direct client URL):
    // if (ADPILER_BASE_URL && mapping.clientId) {
    //   await logStep(`Opening client ${mapping.clientId}`);
    //   await page.goto(`${ADPILER_BASE_URL}/clients/${mapping.clientId}`, { waitUntil: 'networkidle2' });
    // }

    await logStep('Opening New Ad / Upload flow');
    try { await clickByText(page, 'New Ad'); } catch { await clickByText(page, 'Upload'); }
    await page.waitForSelector('input[type="file"], input[name="headline"], input[name="title"]', { timeout: 30000 });

    await logStep('Downloading attachments');
    for (const att of (attachments || [])) {
      if (!att.id) continue;
      const tmp = await downloadAttachmentToTemp(att.id, att.name || `asset-${att.id}`);
      tmpFiles.push(tmp);
    }

    await logStep(`Uploading ${tmpFiles.length} file(s)`);
    const fileInput = await page.$('input[type="file"]');
    if (fileInput && tmpFiles.length) await fileInput.uploadFile(...tmpFiles);

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

    await logStep('Submitting');
    try { await clickByText(page, 'Create'); } catch { await clickByText(page, 'Save'); }

    await page.waitForTimeout(1500);
    const anchors = await page.$$eval('a', as => as.map(a => a.href).filter(Boolean));
    const previewUrls = anchors.filter(u => /preview|share/i.test(u));

    await logStep(`Done. Found ${previewUrls.length} preview URL(s).`);
    tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch(_){} });

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
    await page.close().catch(() => {});
    await browser.disconnect();
  }
}


async function connectWithRetry(wsEndpoint, attempts = 5) {
  let delay = 2000;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
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

module.exports = { uploadToAdpilerUI };
