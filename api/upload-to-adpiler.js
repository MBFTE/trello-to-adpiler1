import fetch from 'node-fetch';

export const config = {
  api: {
    bodyParser: true,
  },
};

const CLIENT_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSlL2KhvYcVnG2AUkT1DtFu9hGRfbYvT1B5wePkmglr1cVeK8EjUySRIgqE3FEsGw/pub?gid=0&single=true&output=csv';

let clientIdMap = {};

async function fetchClientIds() {
  const res = await fetch(CLIENT_CSV_URL);
  const csv = await res.text();
  const lines = csv.split('\n').slice(1); // skip header
  for (const line of lines) {
    const [client, id] = line.split(',').map(s => s.trim().toLowerCase());
    if (client && id) clientIdMap[client] = id;
  }
}


export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const body = req.body;
  console.log('📩 Webhook received from Trello');
  console.log('📨 Request Body:', JSON.stringify(body, null, 2));

  const action = body?.action;
  const listName = action?.data?.listAfter?.name;
  const cardId = action?.data?.card?.id;
  const cardTitle = action?.data?.card?.name || '';

  if (listName !== 'Ready for AdPiler') {
    return res.status(200).send('Not the right list. Ignoring.');
  }

  console.log('📌 List moved to:', listName);
  console.log('🪪 Card ID:', cardId);
  console.log('📝 Card title:', cardTitle);

  const clientName = cardTitle.split(':')[0]?.trim().toLowerCase();
  console.log('👤 Client from card title:', clientName);

  if (Object.keys(clientIdMap).length === 0) {
    await fetchClientIds();
  }

  const clientId = clientIdMap[clientName];
  console.log('✅ Matched client ID:', clientId);

  if (!clientId) {
    console.error('❌ No matching client ID found.');
    return res.status(400).send('Client ID not found.');
  }

  const trelloCardResp = await fetch(`https://api.trello.com/1/cards/${cardId}?attachments=true&fields=desc,url,name&key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`);
  const card = await trelloCardResp.json();
  console.log('📎 Full card response from Trello:', card);

  const folderMatch = card.desc.match(/\*\*Folder:\s*(.+?)\*\*/);
  const folder = folderMatch ? folderMatch[1].trim() : 'Uncategorized';
  const notes = card.desc || '';

  const files = (card.attachments || []).map(file => ({
    fileUrl: file.url,
    fileName: file.name
  }));

  const payload = {
    client_id: clientId,
    folder,
    files,
    notes,
    build_link: '---',
    card_url: card.shortUrl
  };

  console.log('⬆️ Uploading to AdPiler:', payload);

  const adpilerUpload = await fetch('https://api.adpiler.com/v1/upload-files', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': process.env.ADPILER_API_KEY
    },
    body: JSON.stringify(payload)
  });

  const uploadResult = await adpilerUpload.json();
  console.log('✅ AdPiler Upload Result:', uploadResult);

  if (!adpilerUpload.ok) {
    console.error('❌ Upload to AdPiler failed:', uploadResult);
    return res.status(500).send('AdPiler upload failed.');
  }

  res.status(200).send('Upload successful.');
}
