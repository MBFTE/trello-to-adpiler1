import fetch from 'node-fetch';
import csv from 'csv-parser';
import { Readable } from 'stream';

const ADPILER_API_URL = 'https://api.adpiler.com/v1/creatives';
const ADPILER_API_KEY = '11|8u3W1oxoMT0xYCGa91Q7HjznUYfEqODrhVShcXCj';
const CLIENT_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const TARGET_LIST_NAME = 'Ready for AdPiler';

export default async function handler(req, res) {
  console.info('📩 Webhook received from Trello');
  const body = req.body;
  console.info('📨 Request Body:', body);

  const listName = body?.action?.data?.listAfter?.name;
  if (listName !== TARGET_LIST_NAME) {
    console.info(`📌 List moved to: ${listName}`);
    return res.status(200).json({ message: 'Not the target list. Ignoring.' });
  }

  const cardId = body?.action?.data?.card?.id;
  const cardTitle = body?.action?.data?.card?.name;
  console.info('🪪 Card ID:', cardId);
  console.info('📝 Card title:', cardTitle);

  const clientNameMatch = cardTitle.match(/^([^:]+)/);
  const clientName = clientNameMatch ? clientNameMatch[1].trim() : null;
  console.info('👤 Client from card title:', clientName);

  // ⬇️ Fetch and parse CSV
  const csvRes = await fetch(CLIENT_CSV_URL);
  const csvText = await csvRes.text();
  console.info('📄 Raw CSV:', csvText);

  const clientMap = {};
  await new Promise((resolve, reject) => {
    const stream = Readable.from(csvText);
    stream
      .pipe(csv())
      .on('data', (row) => {
        if (row['Trello Client Name'] && row['Adpiler Client ID']) {
          clientMap[row['Trello Client Name'].trim()] = row['Adpiler Client ID'].trim();
        }
      })
      .on('end', resolve)
      .on('error', reject);
  });

  console.info('🧾 Client Map:', clientMap);

  const clientId = clientMap[clientName];
  console.info('✅ Matched client ID:', clientId);
  if (!clientId) {
    console.error('❌ No matching client ID found.');
    return res.status(400).json({ error: 'Client ID not found.' });
  }

  const payload = {
    client_id: clientId,
    name: cardTitle,
    type: 'banner', // You can adjust this dynamically if needed
    platform: 'facebook',
    creatives: []
  };

  console.log('📤 Sending to AdPiler:', {
    url: ADPILER_API_URL,
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': ADPILER_API_KEY
    },
    body: payload
  });

  let uploadResult;
  try {
    const response = await fetch(ADPILER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': ADPILER_API_KEY
      },
      body: JSON.stringify(payload)
    });

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      uploadResult = await response.json();
      console.log('✅ AdPiler response:', uploadResult);
    } else {
      const text = await response.text();
      console.error('❗ AdPiler non-JSON response:', text);
      throw new Error('AdPiler returned unexpected content type');
    }

    return res.status(200).json({ success: true, data: uploadResult });
  } catch (err) {
    console.error('🔥 Fatal error sending to AdPiler:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
