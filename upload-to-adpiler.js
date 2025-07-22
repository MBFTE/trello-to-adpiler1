const axios = require('axios');
const FormData = require('form-data');
const { parse } = require('csv-parse/sync');

async function uploadToAdpiler(cardId, config) {
  const { TRELLO_KEY, TRELLO_TOKEN, ADPILER_API_KEY, CLIENT_LOOKUP_CSV_URL } = config;

  console.log(`🚀 Uploading card ID: ${cardId}`);
  console.log(`🔐 Using API key: ${ADPILER_API_KEY}`);

  // 1. Fetch Trello card
  const cardUrl = `https://api.trello.com/1/cards/${cardId}?fields=name,desc&attachments=true&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
  const cardResp = await axios.get(cardUrl);
  const card = cardResp.data;

  const cardName = card.name || '';
  const matchKey = cardName.split(':')[0].trim().toLowerCase();
  console.log(`🧾 Client detected: "${cardName}" → Match Key: "${matchKey}"`);

  // 2. Load CSV and find matching AdPiler Client ID
  const csvResp = await axios.get(CLIENT_LOOKUP_CSV_URL);
  const records = parse(csvResp.data, { columns: true, skip_empty_lines: true });
  const match = records.find(row => (row['Trello Client Name'] || '').toLowerCase() === matchKey);
  if (!match) throw new Error(`Client "${matchKey}" not found in sheet.`);

  const clientId = match['AdPiler Client ID'];
  console.log(`✅ Matched AdPiler Client ID: ${clientId}`);

  // 3. Prepare files
  const attachments = card.attachments || [];
  const validTypes = ['image/png', 'image/jpeg', 'image/gif', 'video/mp4'];
  const filesToUpload = attachments.filter(att => validTypes.includes(att.mimeType));
  console.log(`📎 Found ${filesToUpload.length} attachments`);

  // 4. Loop over attachments
  for (const file of filesToUpload) {
    try {
      const fileStreamResp = await axios.get(`${file.url}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`, {
        responseType: 'stream'
      });

      const form = new FormData();
      form.append('client_id', clientId);
      form.append('title', file.name);
      form.append('file', fileStreamResp.data, {
        filename: file.name,
        contentType: file.mimeType
      });

      const uploadResp = await axios.post('https://platform.adpiler.com/api/creatives', form, {
        headers: {
          ...form.getHeaders(),
          'x-api-key': ADPILER_API_KEY
        }
      });

      console.log(`✅ Uploaded: ${file.name}`);
    } catch (err) {
      console.error(`❌ Upload error for ${file.name}:`, err.message);
    }
  }
}

module.exports = uploadToAdpiler;
