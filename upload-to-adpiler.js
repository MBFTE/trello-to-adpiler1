const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');

module.exports = async function uploadToAdpiler(cardId, env) {
  const {
    TRELLO_KEY,
    TRELLO_TOKEN,
    ADPILER_API_KEY,
    CLIENT_LOOKUP_CSV_URL,
  } = env;

  console.log(`🚀 Uploading card ID: ${cardId}`);
  console.log(`🔐 Using API key: ${ADPILER_API_KEY}`);

  // 1. Fetch card details from Trello
  const cardRes = await fetch(
    `https://api.trello.com/1/cards/${cardId}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
  );
  const card = await cardRes.json();

  const cardName = card.name || '';
  const clientMatchKey = cardName.split(':')[0].trim().toLowerCase();
  console.log(`🧾 Client detected: "${cardName}"\n→ Match Key: "${clientMatchKey}"`);

  // 2. Fetch CSV and find matching client ID
  const csvRes = await fetch(CLIENT_LOOKUP_CSV_URL);
  const clients = await csv().fromString(await csvRes.text());

  const match = clients.find(
    (row) =>
      (row['Trello Client Name'] || '').toLowerCase().trim() === clientMatchKey
  );

  if (!match) throw new Error(`Client "${clientMatchKey}" not found in sheet.`);

  const adpilerClientId = match['AdPiler Client ID'];
  if (!adpilerClientId) throw new Error(`No AdPiler Client ID for "${clientMatchKey}"`);

  // 3. Fetch attachments from Trello
  const attachRes = await fetch(
    `https://api.trello.com/1/cards/${cardId}/attachments?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
  );
  const attachments = await attachRes.json();

  console.log(`📎 Found ${attachments.length} attachments`);

  const uploadQueue = [];

  for (const file of attachments) {
    const name = file.name;
    const mimeType = file.mimeType || '';
    const size = file.bytes || 0;
    const url = file.url;

    console.log(`📎 Checking attachment: ${name} | mime=${mimeType} | size=${size}`);

    if (!url || !url.startsWith('http')) {
      console.warn(`⚠️ Skipping file "${name}" — invalid or missing URL`);
      continue;
    }

    const downloadUrl = `${url}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;

    uploadQueue.push({
      name,
      url: downloadUrl,
    });
  }

  if (uploadQueue.length === 0) {
    throw new Error('No valid attachments to upload.');
  }

  console.log('✅ Valid files for upload:', uploadQueue.map((f) => f.name));

  // 4. Upload each file to AdPiler as social ad
  for (const asset of uploadQueue) {
    const form = new FormData();
    form.append('client_id', adpilerClientId);
    form.append('title', cardName); // or customize per file if needed
    form.append('type', 'social');
    form.append('file_url', asset.url);

    const adpilerRes = await fetch('https://platform.adpiler.com/api/mockups', {
      method: 'POST',
      headers: {
        'X-API-KEY': ADPILER_API_KEY,
      },
      body: form,
    });

    const json = await adpilerRes.json();

    if (!adpilerRes.ok) {
      console.error(`❌ Error uploading ${asset.name}:`, json.message || json);
    } else {
      console.log(`🎉 Uploaded ${asset.name} to AdPiler`);
    }
  }
};
