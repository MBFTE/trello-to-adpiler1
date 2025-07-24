const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');

async function uploadToAdpiler(cardId, { TRELLO_KEY, TRELLO_TOKEN, ADPILER_API_KEY, CLIENT_LOOKUP_CSV_URL }) {
  console.log(`🚀 Uploading card ID: ${cardId}`);
  console.log(`🔐 Using API key: ${ADPILER_API_KEY}`);

  // 1. Get card details
  const cardResp = await fetch(`https://api.trello.com/1/cards/${cardId}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
  const card = await cardResp.json();
  const cardName = card.name || 'Unnamed Card';

  // 2. Extract match key from card name (before the colon)
  const matchKey = cardName.split(':')[0].trim().toLowerCase();
  console.log(`🧾 Client detected: "${cardName}"\n→ Match Key: "${matchKey}"`);

  // 3. Load CSV mapping from Google Sheet
  const csvResp = await fetch(CLIENT_LOOKUP_CSV_URL);
  const csvText = await csvResp.text();
  const csvData = await csv().fromString(csvText);

  // 4. Match client name
  const clientRow = csvData.find(row =>
    (row['Trello Client Name'] || '').trim().toLowerCase() === matchKey
  );

  if (!clientRow) throw new Error(`Client "${matchKey}" not found in CSV`);

  const adpilerClientId = clientRow['AdPiler Client ID'];
  if (!adpilerClientId) throw new Error(`Missing AdPiler Client ID for "${matchKey}"`);

  // 5. Get attachments on card
  const attachmentsResp = await fetch(`https://api.trello.com/1/cards/${cardId}/attachments?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
  const attachments = await attachmentsResp.json();
  console.log(`📎 Found ${attachments.length} attachments`);

  // 6. Filter and prepare upload list (only PNG/JPG/GIF/MP4 with valid URL)
  const validTypes = ['image/png', 'image/jpeg', 'image/gif', 'video/mp4'];
  const uploadQueue = attachments
    .filter(att => att.url && validTypes.includes(att.mimeType))
    .map(att => ({
      name: att.name,
      url: `${att.url}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
    }));

  if (uploadQueue.length === 0) throw new Error('No valid attachments to upload');

  console.log(`🧾 Final uploadQueue:\n`, uploadQueue.map(f => f.name));

  // 7. Upload each file to AdPiler
  for (const file of uploadQueue) {
    try {
      if (!file.url || !file.url.startsWith('http')) {
        throw new Error(`Invalid or missing URL: ${file.url}`);
      }

      console.log(`📤 Attempting upload for: ${file.name}`);
      const fileResp = await fetch(file.url);
      if (!fileResp.ok) throw new Error(`Failed to fetch ${file.name} (${fileResp.status})`);

      const buffer = await fileResp.buffer();
      const form = new FormData();
      form.append('client_id', adpilerClientId);
      form.append('title', file.name);
      form.append('file', buffer, { filename: file.name });

      const uploadResp = await fetch('https://app.adpiler.com/api/upload-file', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ADPILER_API_KEY}`
        },
        body: form
      });

      const uploadJson = await uploadResp.json();
      if (uploadResp.ok) {
        console.log(`✅ Uploaded: ${file.name}`);
      } else {
        console.error(`❌ Upload error: ${file.name}`, uploadJson);
      }
    } catch (err) {
      console.error(`❌ Fatal error uploading ${file?.name || '[Unknown File]'}:`, err.message || err);
    }
  }
}

module.exports = uploadToAdpiler;
