import fetch from 'node-fetch';
import { FormData } from 'formdata-node';
import csv from 'csvtojson';

// Force Vercel to use Node.js Serverless function runtime
export const config = {
  runtime: 'nodejs18.x',
};

const CLIENT_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const ADPILER_API = 'https://api.adpiler.com/v1/add-creative';
const ADPILER_API_KEY = '11|8u3W1oxoMT0xYCGa91Q7HjznUYfEqODrhVShcXCj';

const clientIdMap = {};

async function fetchClientIds() {
  const res = await fetch(CLIENT_CSV_URL);
  const csvText = await res.text();
  const rows = await csv().fromString(csvText);
  for (const row of rows) {
    const name = row['Trello Client Name']?.trim();
    const id = row['Adpiler Client ID']?.trim();
    if (name && id) clientIdMap[name] = id;
  }
  console.log('📄 Raw CSV:', csvText);
  console.log('🧾 Client Map:', clientIdMap);
}

export default async function handler(req, res) {
  try {
    console.log('📩 Webhook received from Trello');
    const body = req.body;
    console.log('📨 Request Body:', body);

    const card = body?.action?.data?.card;
    const cardTitle = card?.name || '';
    const listAfter = body?.action?.data?.listAfter?.name;

    console.log('📌 List moved to:', listAfter);
    console.log('🪪 Card ID:', card?.id);
    console.log('📝 Card title:', cardTitle);

    if (listAfter !== 'Ready for AdPiler') {
      return res.status(200).json({ message: 'List is not Ready for AdPiler. Skipping.' });
    }

    const clientName = cardTitle.split(':')[0]?.trim();
    console.log('👤 Client from card title:', clientName);

    await fetchClientIds();
    const clientId = clientIdMap[clientName];
    console.log('✅ Matched client ID:', clientId);

    if (!clientId) {
      console.error('❌ No matching client ID found.');
      return res.status(400).json({ error: 'No matching client ID found.' });
    }

    // Fake form submission to AdPiler for now
    const form = new FormData();
    form.set('api_key', ADPILER_API_KEY);
    form.set('client_id', clientId);
    form.set('title', cardTitle);

    const adpilerRes = await fetch(ADPILER_API, {
      method: 'POST',
      body: form
    });

    const responseText = await adpilerRes.text();
    console.log('📬 AdPiler response:', responseText);

    if (!adpilerRes.ok) {
      throw new Error(`AdPiler error: ${responseText}`);
    }

    return res.status(200).json({ success: true, response: responseText });

  } catch (error) {
    console.error('🔥 Fatal error:', error);
    return res.status(500).json({ error: 'internal error' });
  }
}
