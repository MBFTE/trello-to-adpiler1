import fetch from 'node-fetch';
import { FormData } from 'formdata-node';
import csv from 'csvtojson';
import https from 'https';

export const config = { runtime: 'edge' };

const GOOGLE_SHEET_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';

const READY_FOR_ADPILER_LIST_ID = '6202db0c0f425434fbc9864b';
const ADPILER_API_KEY = '11|8u3W1oxoMT0xYCGa91Q7HjznUYfEqODrhVShcXCj';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false, // only for dev; DO NOT use in production
});

export default async function handler(req) {
  console.info('📩 Webhook received from Trello');

  const body = await req.json();
  console.info('📨 Request Body:', body);

  const { action } = body;
  const listAfterId = action?.data?.listAfter?.id;
  const cardId = action?.data?.card?.id;
  const cardTitle = action?.data?.card?.name;

  console.info('📌 List moved to:', action?.data?.listAfter?.name);
  console.info('🪪 Card ID:', cardId);
  console.info('📝 Card title:', cardTitle);

  // Only continue if card moved to the Ready for AdPiler list
  if (listAfterId !== READY_FOR_ADPILER_LIST_ID) {
    return new Response('✅ Ignored – not moved to Ready for AdPiler', { status: 200 });
  }

  // Extract client name from Trello card title (before the colon)
  const clientName = cardTitle.split(':')[0].trim();
  console.info('👤 Client from card title:', clientName);

  // Load the Google Sheet to map client name to AdPiler ID
  let clientMap = {};
  try {
    const csvRes = await fetch(GOOGLE_SHEET_CSV_URL);
    const rawCSV = await csvRes.text();
    console.info('📄 Raw CSV:', rawCSV);

    const records = await csv().fromString(rawCSV);
    clientMap = records.reduce((acc, row) => {
      acc[row['Trello Client Name']] = row['Adpiler Client ID'];
      return acc;
    }, {});
    console.info('🧾 Client Map:', clientMap);
  } catch (err) {
    console.error('🚨 Failed to load client map:', err);
    return new Response('Failed to load client mapping CSV', { status: 500 });
  }

  const clientId = clientMap[clientName];
  console.info('✅ Matched client ID:', clientId);

  if (!clientId) {
    console.error('❌ No matching client ID found.');
    return new Response('Client ID not found', { status: 404 });
  }

  // Example payload to AdPiler (you’ll need to adjust based on their actual API docs)
  const formData = new FormData();
  formData.set('api_key', ADPILER_API_KEY);
  formData.set('client_id', clientId);
  formData.set('title', cardTitle);

  try {
    const adpilerRes = await fetch('https://api.adpiler.com/v1/add-creative', {
      method: 'POST',
      body: formData,
      agent: httpsAgent,
    });

    const result = await adpilerRes.text();

    if (!adpilerRes.ok) {
      throw new Error(result);
    }

    console.info('🎉 AdPiler upload successful:', result);
    return new Response('Uploaded to AdPiler successfully', { status: 200 });
  } catch (err) {
    console.error('🔥 Fatal error:', err);
    return new Response('AdPiler upload failed', { status: 500 });
  }
}
