const fetch = require('node-fetch');
const csv = require('csvtojson');
const FormData = require('form-data');
const path = require('path');

async function uploadToAdpiler(cardId, config) {
  const {
    TRELLO_KEY,
    TRELLO_TOKEN,
    ADPILER_API_KEY,
    CLIENT_LOOKUP_CSV_URL,
  } = config;

  // 1. Fetch Trello card details
  const cardUrl = `https://api.trello.com/1/cards/${cardId}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}&attachments=true`;
  const cardRes = await fetch(cardUrl);
  const card = await cardRes.json();

  const cardName = card.name;
  const attachments = card.attachments || [];

  console.log(`🚀 Uploading card ID: ${cardId}`);
  console.log(`🔐 Using API key: ${ADPILER_API_KEY}`);
  console.log(`🧾 Client detected: "${cardName}"`);

  // 2. Extract match key from card name
  const matchKey = cardName.split(':')[0].trim().toLowerCase();
  console.log(`→ Match Key: "${matchKey}"`);

  // 3. Get client lookup data
  const csvRes = await fetch(CLIENT_LOOKUP_CSV_URL);
  const csvText = await csvRes.text();
  const clients = await csv().fromString(csvText);

  const matchedClient = clients.find(
    (c) => c['Trello Client Name']?.trim().toLowerCase() === matchKey
  );

  if (!matchedClient) {
    throw new Error(`Client "${matchKey}" not found in sheet.`);
  }

  const clientId = matchedClient['Adpiler Client ID'];
  if (!clientId) {
    throw new Error(`Missing AdPiler Client ID for "${matchKey}"`);
  }

  console.log(`✅ Matched AdPiler Client ID: ${clientId}`);

  // 4. Filter valid attachments
  const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'video/mp4'];
  const allowedSizes = ['1080x1080', '1200x1200', '300x600', '300x250'];

  const uploadQueue = [];

  for (const file of attachments) {
    const name = file.name || '';
    const mimeType = file.mimeType || '';
    const size = file.bytes || 0;

    // Try to extract dimensions from name
    const match = name.match(/(\d+x\d+)/);
    const dimensions = match ? match[1] : '';

    if (!allowedTypes.includes(mimeType)) {
      console.log(`⚠️ Skipped "${name}" - invalid type`);
      continue;
    }

    if (!allowedSizes.includes(dimensions)) {
      console.log(`⚠️ Skipped "${name}" - invalid dimensions`);
      continue;
    }

    const secureUrl = `https://api.trello.com/1/cards/${cardId}/attachments/${file.id}/download?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;

    console.log(`📎 Queued "${name}" [${mimeType}, ${dimensions}, ${size} bytes]`);
    uploadQueue.push({ name, url: secureUrl });
  }

  if (uploadQueue.length === 0) {
    throw new Error('No valid attachments to upload');
  }

  console.log(`🧾 Final upload queue (${uploadQueue.length} files)`);

  // 5. Upload to AdPiler
  for (const file of uploadQueue) {
    if (!file.url) {
      throw new Error(`❌ Upload failed: URL missing for "${file.name}"`);
    }

    try {
      const fileData = await fetch(file.url);
      if (!fileData.ok) {
        throw new Error(`Failed to fetch file: ${file.url}`);
      }

      const buffer = await fileData.buffer();
      const form = new FormData();

      form.append('client_id', clientId);
      form.append('api_key', ADPILER_API_KEY);
      form.append('creative[]', buffer, {
        filename: file.name,
        contentType: file.mimeType || 'application/octet-stream',
      });

      const uploadRes = await fetch('https://app.adpiler.com/api/uploadcreatives', {
        method: 'POST',
        body: form,
      });

      const response = await uploadRes.json();

      if (!uploadRes.ok || response.error) {
        console.error(`❌ AdPiler upload failed for "${file.name}":`, response);
        continue;
      }

      console.log(`✅ Uploaded: ${file.name}`);
    } catch (err) {
      console.error(`❌ Upload error for "${file.name}":`, err.message || err);
    }
  }
}

module.exports = uploadToAdpiler;
