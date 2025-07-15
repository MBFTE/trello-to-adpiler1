export const config = {
  runtime: 'edge',
};

const ADPILER_API_KEY = '11|8u3W1oxoMT0xYCGa91Q7HjznUYfEqODrhVShcXCj';
const CLIENT_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';

let clientIdMap = {};

async function fetchClientIds() {
  const res = await fetch(CLIENT_CSV_URL);
  const csv = await res.text();
  console.log('📄 Raw CSV:', csv);

  const lines = csv.split('\n').slice(1); // skip header row

  for (const line of lines) {
    const [clientRaw, idRaw] = line.split(',');
    const client = clientRaw?.trim(); // no lowercasing!
    const id = idRaw?.trim();
    if (client && id) {
      clientIdMap[client] = id;
    }
  }

  console.log('🧾 Client Map:', clientIdMap);
}

export default async function handler(req) {
  console.log('📩 Webhook received from Trello');
  const body = await req.json();
  console.log('📨 Request Body:', body);

  const listName = body?.action?.data?.listAfter?.name || '';
  console.log('📌 List moved to:', listName);

  if (listName !== 'Ready for AdPiler') {
    return new Response('Not Ready for AdPiler list. Ignored.', { status: 200 });
  }

  const card = body?.action?.data?.card;
  const cardTitle = card?.name || '';
  const cardId = card?.id || '';
  const clientFromTitle = cardTitle.split(':')[0].trim();
  console.log('🪪 Card ID:', cardId);
  console.log('📝 Card title:', cardTitle);
  console.log('👤 Client from card title:', clientFromTitle);

  await fetchClientIds();

  const clientId = clientIdMap[clientFromTitle];
  console.log('✅ Matched client ID:', clientId);

  if (!clientId) {
    console.error('❌ No matching client ID found.');
    return new Response('Client ID not found', { status: 400 });
  }

  // 🔥 Upload placeholder creative to AdPiler
  const uploadResponse = await fetch('https://app.adpiler.com/api/creatives', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ADPILER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      client_id: clientId,
      name: cardTitle,
      type: 'other',
      platform: 'facebook',
      tags: ['auto-uploaded'],
      notes: `Uploaded from Trello card: ${cardTitle}`,
      url: `https://trello.com/c/${card.shortLink}`
    })
  });

  const uploadResult = await uploadResponse.json();

  if (uploadResponse.ok) {
    console.log('🚀 Upload to AdPiler successful!', uploadResult);
    return new Response('Upload successful', { status: 200 });
  } else {
    console.error('💥 Upload failed', uploadResult);
    return new Response('Upload failed', { status: 500 });
  }
}

