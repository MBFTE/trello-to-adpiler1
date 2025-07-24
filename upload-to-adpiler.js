const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');

module.exports = async function uploadToAdpiler(cardId, {
  TRELLO_KEY,
  TRELLO_TOKEN,
  ADPILER_API_KEY,
  CLIENT_LOOKUP_CSV_URL
}) {
  console.log(`🚀 Uploading card ID: ${cardId}`);
  console.log(`🔐 Using API key: ${ADPILER_API_KEY}`);

  // Get Trello card details
  const cardUrl = `https://api.trello.com/1/cards/${cardId}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}&attachments=true&fields=name,desc`;
  const cardRes = await fetch(cardUrl);
  const card = await cardRes.json();

  const cardName = card.name || '';
  const matchKey = cardName.split(':')[0].trim().toLowerCase();
  console.log(`🧾 Client detected: "${cardName}"\n→ Match Key: "${matchKey}"`);

  // Get client lookup CSV
  const csvRes = await fetch(CLIENT_LOOKUP_CSV_URL);
  const csvText = await csvRes.text();
  const clients = await csv().fromString(csvText);

  const matchedClient = clients.find(row => 
    row['Trello Client Name'] && row['Trello Client Name'].toLowerCase().trim() === matchKey
  );

  if (!matchedClient) {
    throw new Error(`Client "${matchKey}" not found in sheet.`);
  }

  const adpilerClientId = matchedClient['AdPiler Client ID'];

  // Pull attachments
  const attachments = (card.attachments || []).filter(att => {
    const isValidType = ['image/png', 'image/jpeg', 'image/gif', 'video/mp4'].includes(att.mimeType);
    return isValidType;
  });

  console.log(`📎 Found ${attachments.length} attachments`);

  const uploadQueue = [];

  for (const att of attachments) {
    const downloadUrl = `${att.url}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;

    if (!downloadUrl || !downloadUrl.startsWith('http')) {
      console.error('❌ Skipping file with invalid or missing URL:', att.name || att.url);
      continue;
    }

    console.log(`📎 Preparing: ${att.name} (${att.mimeType})`);
    uploadQueue.push({
      name: att.name,
      url: downloadUrl
    });
  }

  if (uploadQueue.length === 0) {
    throw new Error('No valid files with absolute URLs were found.');
  }

  console.log('📦 Final uploadQueue:', uploadQueue);

  for (const file of uploadQueue) {
    const fileRes = await fetch(file.url);
    const buffer = await fileRes.buffer();

    const form = new FormData();
    form.append('client_id', adpilerClientId);
    form.append('name', file.name);
    form.append('file', buffer, file.name);

    const adpilerRes = await fetch('https://app.adpiler.com/api/ads/add', {
      method: 'POST',
      headers: {
        'X-API-KEY': ADPILER_API_KEY,
        ...form.getHeaders()
      },
      body: form
    });

    const result = await adpilerRes.json();

    if (!adpilerRes.ok) {
      console.error('❌ AdPiler error:', result);
      throw new Error(`Upload failed for ${file.name}`);
    } else {
      console.log(`✅ Uploaded ${file.name} to AdPiler`);
    }
  }
};

