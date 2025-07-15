export const config = {
  runtime: 'edge',
};

const ADPILER_API_KEY = '11|8u3W1oxoMT0xYCGa91Q7HjznUYfEqODrhVShcXCj';
const CLIENT_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';

const clientIdMap = {};

async function fetchClientIds() {
  const res = await fetch(CLIENT_CSV_URL);
  const csv = await res.text();

  console.log('📄 Raw CSV:', csv);

  const lines = csv.split('\n').slice(1); // skip header
  for (const line of lines) {
    const [clientRaw, idRaw] = line.split(',');
    const client = clientRaw?.trim(); // preserve uppercase
    const id = idRaw?.trim();
    if (client && id) {
      clientIdMap[client] = id;
    }
  }

  console.log('🧾 Client Map:', clientIdMap);
}

export default async function handler(req) {
  try {
    console.log('📩 Webhook received from Trello');
    const body = await req.json();
    console.log('📨 Request Body:', body);

    const listName = body.action.data.listAfter.name;
    if (listName !== 'Ready for AdPiler') {
      return new Response('List is not Ready for AdPiler', { status: 200 });
    }

    const card = body.action.data.card;
    const cardTitle = card.name;
    const cardId = card.id;
    const shortLink = card.shortLink;

    console.log('📌 List moved to:', listName);
    console.log('🪪 Card ID:', cardId);
    console.log('📝 Card title:', cardTitle);

    // Extract client name (before the colon)
    const clientName = cardTitle.split(':')[0].trim();
    console.log('👤 Client from card title:', clientName);

    // Fetch & parse CSV into map
    await fetchClientIds();
    const clientId = clientIdMap[clientName];
    console.log('✅ Matched client ID:', clientId);

    if (!clientId) {
      console.error('❌ No matching client ID found.');
      return new Response('Client ID not found', { status: 400 });
    }

    // Send to AdPiler API
    const uploadResponse = await fetch('https://app.adpiler.com/api/creatives', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ADPILER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: clientId,
        name: cardTitle,
        type: 'image', // fallback
        platform: 'facebook',
        url: `https://trello.com/c/${shortLink}`
      })
    });

    let uploadResult;
try {
  uploadResult = await uploadResponse.json();
} catch (e) {
  const errorText = await uploadResponse.text();
  console.error('❗ AdPiler non-JSON response:', errorText);
  throw new Error('AdPiler returned non-JSON response');
}


    if (uploadResponse.ok) {
      console.log('🚀 Upload to AdPiler successful!', uploadResult);
      return new Response('Upload successful', { status: 200 });
    } else {
      console.error('💥 Upload failed', uploadResponse.status, uploadResult);
      return new Response('Upload failed', { status: 500 });
    }
  } catch (err) {
    console.error('🔥 Fatal error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
