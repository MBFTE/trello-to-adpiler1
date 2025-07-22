const axios = require('axios');
const FormData = require('form-data');
const csv = require('csvtojson');

async function downloadAttachment(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
  });
  return response.data;
}

async function uploadToAdpiler(cardId, { TRELLO_KEY, TRELLO_TOKEN, ADPILER_API_KEY, CLIENT_LOOKUP_CSV_URL }) {
  console.log(`🚀 Uploading card ID: ${cardId}`);
  console.log(`🔐 Using API key: ${ADPILER_API_KEY}`);

  // Get card details
  const card = await axios.get(`https://api.trello.com/1/cards/${cardId}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}&attachments=true&fields=name,desc`, {
    headers: { Accept: 'application/json' },
  }).then(res => res.data);

  const cardName = card.name || '';
  const matchKey = cardName.split(':')[0].trim().toLowerCase();
  console.log(`🧾 Client detected: "${cardName}" → Match Key: "${matchKey}"`);

  // Parse CSV client sheet
  const clientsCSV = await axios.get(CLIENT_LOOKUP_CSV_URL).then(res => res.data);
  const clients = await csv().fromString(clientsCSV);
  const matchedClient = clients.find(c => (c['Trello Client Name'] || '').toLowerCase().trim() === matchKey);

  if (!matchedClient || !matchedClient['Adpiler Client ID']) {
    throw new Error(`Client "${matchKey}" not found in sheet.`);
  }

  const clientId = matchedClient['Adpiler Client ID'];

  const attachments = (card.attachments || []).filter(att => {
    const ext = att.name.split('.').pop().toLowerCase();
    return ['png', 'jpg', 'jpeg', 'gif', 'mp4'].includes(ext);
  });

  console.log(`📎 Found ${attachments.length} attachments`);

  if (attachments.length === 0) {
    throw new Error('No valid attachments to upload.');
  }

  // Upload each attachment to AdPiler
  for (const attachment of attachments) {
    try {
      const downloadUrl = `${attachment.url}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
      const fileBuffer = await downloadAttachment(downloadUrl);

      const form = new FormData();
      form.append('client_id', clientId);
      form.append('creative_file', fileBuffer, attachment.name);
      form.append('headline', card.name);
      form.append('description', card.desc || '');
      form.append('platform', 'social');

      const res = await axios.post('https://platform.adpiler.com/api/creatives', form, {
        headers: {
          ...form.getHeaders(),
          'x-api-key': ADPILER_API_KEY,
        },
      });

      console.log(`✅ Uploaded: ${attachment.name} (ID: ${res.data?.id || 'unknown'})`);
    } catch (err) {
      console.error(`❌ Upload error for ${attachment.name}:`, err.message || err);
    }
  }
}

module.exports = uploadToAdpiler;
