import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import csv from 'csvtojson';

const app = express();
app.use(express.json());

const PORT             = process.env.PORT || 3000;
const CLIENT_CSV_URL   = process.env.CLIENT_CSV_URL || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const TARGET_LIST_NAME = process.env.TARGET_LIST_NAME || 'READY FOR ADPILER';
const TRELLO_API_KEY   = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN     = process.env.TRELLO_TOKEN;
const ADPILER_API_KEY  = process.env.ADPILER_API_KEY;
const ADPILER_BASE_URL = process.env.ADPILER_BASE_URL || 'https://platform.adpiler.com/api';

let clientMap = {};

;(async function refreshClientMap() {
  try {
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
  } catch (err) {
    console.error('❌ refreshClientMap error:', err.message);
  }
  setTimeout(refreshClientMap, 1000 * 60 * 60);
})();

async function getCardAttachments(cardId) {
  const url = `https://api.trello.com/1/cards/${cardId}/attachments?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`getCardAttachments ${res.status}`);
  return res.json();
}

async function downloadTrelloAttachment(cardId, att) {
  let res = await fetch(att.url, { redirect: 'follow', timeout: 15000 });
  if (!res.ok) {
    const dl = `https://api.trello.com/1/cards/${cardId}/attachments/${att.id}/download?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
    res = await fetch(dl, { redirect: 'follow', timeout: 15000 });
    if (!res.ok) throw new Error(`download failed ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

app.head('/upload-to-adpiler', (_req, res) => res.sendStatus(200));
app.get('/', (_req, res) => res.send('OK'));

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

    const cardRes = await fetch(
      `https://api.trello.com/1/cards/${cardId}?fields=name,desc,url,labels&key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
    );
    if (!cardRes.ok) throw new Error(`card fetch ${cardRes.status}`);
    const { name: cardName, desc = '', labels = [] } = await cardRes.json();

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

    const labelNames = labels.map(l => l.name.trim().toLowerCase());
    const format     = labelNames.includes('social') ? 'social' : 'display';

    const clientKey  = cardName.split(':')[0].trim().toLowerCase();
    const campaignId = clientMap[clientKey];
    if (!campaignId) {
      return res.status(400).json({ error: `No campaign for ${clientKey}` });
    }

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

    const url = `${ADPILER_BASE_URL}/campaigns/${campaignId}/${format === 'social' ? 'social-ads' : 'ads'}`;

    if (format === 'social') {
      const imageFile = buffers.find(b => b !== null);
      const logoBase64 = imageFile
        ? `data:image/png;base64,${imageFile.buf.toString('base64')}`
        : '';

      const payload = {
        name: cardName,
        network: fieldMap['network'] || 'facebook',
        type: fieldMap['type'] || 'post',
        page_name: fieldMap['page name'] || '',
        logo: logoBase64
      };

      const apiRes = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ADPILER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        timeout: 20000
      });

      if (!apiRes.ok) {
        const body = await apiRes.text();
        return res.status(apiRes.status).send(body);
      }

      return res.sendStatus(200);
    }

    const file = buffers.find(b => b !== null);
    const form = new FormData();
    form.append('primary_text',      primaryText);
    form.append('headline',          headline);
    form.append('description',       descriptionText);
    form.append('call_to_action',    callToAction);
    form.append('click_through_url', clickUrl);
    form.append('name',              cardName);
    form.append('width',             fieldMap['width']       || '300');
    form.append('height',            fieldMap['height']      || '250');
    form.append('max_width',         fieldMap['max width']   || '300');
    form.append('max_height',        fieldMap['max height']  || '250');
    form.append('responsive_width',  'true');
    form.append('responsive_height', 'true');
    if (file) form.append('file', file.buf, file.name);

    const apiRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADPILER_API_KEY}`,
        ...form.getHeaders()
      },
      body: form,
      timeout: 20000
    });

    if (!apiRes.ok) {
      const body = await apiRes.text();
      return res.status(apiRes.status).send(body);
    }

    return res.sendStatus(200);

  } catch (err) {
    console.error('❌ Handler error:', err.message);
    return res.status(500).send('Internal server error');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});
