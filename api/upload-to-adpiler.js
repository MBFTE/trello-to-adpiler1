import fetch from 'node-fetch';

const CLIENT_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';

const clientIdMap = {};

async function fetchClientIds() {
  const res = await fetch(CLIENT_CSV_URL);
  const csv = await res.text();
  console.info('📄 Raw CSV:', csv);

  const lines = csv.split('\n').slice(1); // skip header
  for (const line of lines) {
    const [clientRaw, idRaw] = line.split(',');
    const client = clientRaw?.trim();
    const id = idRaw?.trim();
    if (client && id) {
      clientIdMap[client] = id;
    }
  }

  console.info('🧾 Client Map:', clientIdMap);
}

export default async function handler(req, res) {
  try {
    console.info('📩 Webhook received from Trello');
    console.info('📨 Request Body:', req.body);

    const cardName = req.body?.action?.data?.card?.name;
    const cardId = req.body?.action?.data?.card?.id;
    const listName = req.body?.action?.data?.listAfter?.name;

    console.info('📌 List moved to:', listName);
    console.info('🪪 Card ID:', cardId);
    console.info('📝 Card title:', cardName);

    const clientName = cardName.split(':')[0]?.trim();
    console.info('👤 Client from card title:', clientName);

    await fetchClientIds();
    const clientId = clientIdMap[clientName];
    console.info('✅ Matched client ID:', clientId);

    if (!clientId) {
      throw new Error('No matching client ID found.');
    }

    // Upload to AdPiler
    const adpilerRes = await fetch('https://api.adpiler.com/v1/add-creative', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': '11|8u3W1oxoMT0xYCGa91Q7HjznUYfEqODrhVShcXCj'
      },
      body: JSON.stringify({
        client_id: clientId,
        name: cardName,
        external_id: cardId
      })
    });

    const adpilerData = await adpilerRes.json();

    console.info('🚀 AdPiler response:', adpilerData);

    if (!adpilerRes.ok) {
      throw new Error(adpilerData?.message || 'Upload to AdPiler failed');
    }

    res.status(200).json({ message: 'Upload successful', data: adpilerData });
  } catch (err) {
    console.error('🔥 Fatal error:', err);
    res.status(500).json({ error: err.message || 'internal error' });
  }
}
