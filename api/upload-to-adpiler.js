export const config = {
  api: {
    bodyParser: false,
  },
};

// ✅ CORRECT published Google Sheet CSV link
const CLIENT_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';

let clientIdMap = {};

async function fetchClientIds() {
  const res = await fetch(CLIENT_CSV_URL);
  const csv = await res.text();
  const lines = csv.split('\n').slice(1); // Skip header

  for (const line of lines) {
    const [clientRaw, idRaw] = line.split(',');
    const client = clientRaw?.trim(); // ✅ Preserve original case
    const id = idRaw?.trim();
    if (client && id) {
      clientIdMap[client] = id;
    }
  }

  console.log('🧾 Client Map:', clientIdMap);
}

function extractClientName(cardTitle) {
  return cardTitle.split(':')[0]?.trim(); // "Zia Clovis" from "Zia Clovis: Carousel Ad"
}

function findClientId(caseInsensitiveName) {
  for (const clientName in clientIdMap) {
    if (clientName.toLowerCase() === caseInsensitiveName.toLowerCase()) {
      return clientIdMap[clientName]; // Return ID using original-cased key
    }
  }
  return undefined;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });

  req.on('end', async () => {
    const payload = JSON.parse(body);

    console.log('📩 Webhook received from Trello');
    console.log('📨 Request Body:', payload);

    const listName = payload.action?.data?.listAfter?.name;
    const cardId = payload.action?.data?.card?.id;
    const cardTitle = payload.action?.data?.card?.name;

    console.log('📌 List moved to:', listName);
    console.log('🪪 Card ID:', cardId);
    console.log('📝 Card title:', cardTitle);

    const clientFromCard = extractClientName(cardTitle);
    console.log('👤 Client from card title:', clientFromCard);

    await fetchClientIds();

    const clientId = findClientId(clientFromCard);
    console.log('✅ Matched client ID:', clientId);

    if (!clientId) {
      console.error('❌ No matching client ID found.');
      return res.status(400).send('Client ID not found');
    }

    // 🔜 Insert AdPiler API logic here if desired

    return res.status(200).send('Webhook processed successfully');
  });
}
