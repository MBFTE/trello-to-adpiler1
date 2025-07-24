// upload-to-adpiler.js
const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');

async function uploadToAdpiler(cardId, { TRELLO_KEY, TRELLO_TOKEN, ADPILER_API_KEY, CLIENT_LOOKUP_CSV_URL }) {
  console.log(`🚀 Uploading card ID: ${cardId}`);

  // STEP 1: Get Trello card details
  const cardUrl = `https://api.trello.com/1/cards/${cardId}?attachments=true&customFieldItems=true&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
  const cardRes = await fetch(cardUrl);
  const card = await cardRes.json();
  const cardName = card.name;
  console.log(`🧾 Client detected: "${cardName}"`);

  // STEP 2: Match client from CSV
  const csvRes = await fetch(CLIENT_LOOKUP_CSV_URL);
  const csvText = await csvRes.text();
  const clients = await csv().fromString(csvText);
  const matchKey = cardName.split(':')[0].toLowerCase().trim();
  const matched = clients.find(row => row["Trello Client Name"].toLowerCase().trim() === matchKey);

  if (!matched) throw new Error(`Client match not found for key: ${matchKey}`);
  const clientId = matched["AdPiler Client ID"];
  console.log(`→ Match Key: "${matchKey}" → Client ID: ${clientId}`);

  // STEP 3: Filter supported attachments
  const supportedMime = ['image/png', 'image/jpeg', 'image/gif', 'video/mp4'];
  const validAttachments = card.attachments.filter(att => supportedMime.includes(att.mimeType));
  console.log(`📎 Found ${validAttachments.length} supported attachment(s)`);

  if (validAttachments.length === 0) throw new Error('No valid attachments');

  // STEP 4: Upload each attachment
  for (const attachment of validAttachments) {
    const downloadUrl = `https://api.trello.com/1/cards/${cardId}/attachments/${attachment.id}/download?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) throw new Error(`Download failed ${fileRes.status}: ${fileRes.statusText}`);

    const buffer = await fileRes.buffer();
    const form = new FormData();

    form.append('client_id', clientId);
    form.append('type', 'social'); // or display, video
    form.append('title', cardName);
    form.append('file', buffer, {
      filename: attachment.name,
      contentType: attachment.mimeType,
    });

    const uploadRes = await fetch('https://platform.adpiler.com/api/mockups', {
      method: 'POST',
      headers: {
        'X-API-KEY': ADPILER_API_KEY,
        ...form.getHeaders()
      },
      body: form
    });

    const result = await uploadRes.text();
    if (!uploadRes.ok) {
      throw new Error(`AdPiler upload failed: ${result}`);
    }
    console.log(`✅ Uploaded: ${attachment.name}`);
  }
}

module.exports = uploadToAdpiler;

