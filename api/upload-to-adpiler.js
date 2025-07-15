export const config = {
  runtime: 'nodejs18.x',
};

import fetch from 'node-fetch';
import csv from 'csvtojson';
import { FormData } from 'formdata-node';

const CLIENT_ID_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const ADPILER_API_KEY = '11|8u3W1oxoMT0xYCGa91Q7HjznUYfEqODrhVShcXCj';

export default async function handler(req, res) {
  try {
    console.info('📩 Webhook received from Trello');
    const body = req.body || {};

    const listName = body?.action?.data?.listAfter?.name;
    if (listName !== 'Ready for AdPiler') {
      console.info(`⏭️ Ignoring card move to list: ${listName}`);
      return res.status(200).json({ ignored: true });
    }

    const cardTitle = body?.action?.data?.card?.name || '';
    const cardId = body?.action?.data?.card?.id;
    console.info(`📝 Card title: ${cardTitle}`);
    console.info(`🪪 Card ID: ${cardId}`);

    // Extract client name from title (before the colon)
    const clientName = cardTitle.split(':')[0].trim();
    console.info(`👤 Client from card title: ${clientName}`);

    // Fetch and parse the CSV
    const csvResponse = await fetch(CLIENT_ID_CSV_URL);
    const csvText = await csvResponse.text();
    console.info(`📄 Raw CSV: ${csvText}`);

    const records = await csv().fromString(csvText);
    const clientMap = {};
    for (const row of records) {
      if (row['Trello Client Name'] && row['Adpiler Client ID']) {
        clientMap[row['Trello Client Name'].trim()] = row['Adpiler Client ID'].trim();
      }
    }
    console.info('🧾 Client Map:', clientMap);

    const matchedClientId = clientMap[clientName];
    if (!matchedClientId) {
      console.error('❌ No matching client ID found.');
      return res.status(400).json({ error: 'Client ID not found in map.' });
    }
    console.info(`✅ Matched client ID: ${matchedClientId}`);

    // Build and send request to AdPiler
    const form = new FormData();
    form.set('client_id', matchedClientId);
    form.set('name', cardTitle);
    form.set('url', `https://trello.com/c/${body?.action?.data?.card?.shortLink}`);
    form.set('platform', 'social'); // Update if needed
    form.set('status', 'active');  // Update if needed

    const adpilerRes = await fetch('https://api.adpiler.com/v1/add-creative', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ADPILER_API_KEY}`,
      },
      body: form,
    });

    const adpilerJson = await adpilerRes.json();

    if (!adpilerRes.ok) {
      console.error('🔥 AdPiler error:', adpilerJson);
      return res.status(500).json({ error: 'AdPiler upload failed.', details: adpilerJson });
    }

    console.info('✅ Creative uploaded to AdPiler:', adpilerJson);
    res.status(200).json({ success: true, result: adpilerJson });
  } catch (err) {
    console.error('🔥 Fatal error:', err);
    res.status(500).json({ error: 'internal error' });
  }
}

