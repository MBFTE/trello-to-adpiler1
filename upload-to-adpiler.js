// upload-to-adpiler.js
const axios = require('axios');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function uploadToAdpiler(cardId, keys) {
  const {
    TRELLO_KEY,
    TRELLO_TOKEN,
    ADPILER_API_KEY,
    CLIENT_LOOKUP_CSV_URL,
    ADPILER_BASE_URL = 'https://platform.adpiler.com/api'
  } = keys;

  console.log(`\n🚀 Uploading card ID: ${cardId}`);
  console.log(`🔐 Using API key: ${ADPILER_API_KEY}`);

  // Get card info from Trello
  const cardURL = `https://api.trello.com/1/cards/${cardId}?attachments=true&customFieldItems=true&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
  const { data: card } = await axios.get(cardURL);

  const clientName = card.name.split(':')[0].trim().toLowerCase();
  const attachments = card.attachments || [];

  console.log(`🧾 Client detected: "${card.name}" → Match Key: "${clientName}"`);
  console.log(`📎 Found ${attachments.length} attachments`);

  // Get client lookup CSV and match
  const { data: csvText } = await axios.get(CLIENT_LOOKUP_CSV_URL);
  const rows = csvText.trim().split('\n').map((r) => r.split(','));
  const header = rows[0];
  const nameIdx = header.findIndex((h) => h.toLowerCase().includes('trello client name'));
  const idIdx = header.findIndex((h) => h.toLowerCase().includes('adpiler client id'));

  if (nameIdx === -1 || idIdx === -1) throw new Error('🛑 Could not find expected columns in CSV.');

  const clientRow = rows.slice(1).find((row) => row[nameIdx].trim().toLowerCase() === clientName);
  if (!clientRow) throw new Error(`❌ Client "${clientName}" not found in sheet.`);

  const clientId = clientRow[idIdx];
  console.log(`✅ Client matched. AdPiler ID: ${clientId}`);

  // Parse description for metadata
  const textFallback = (label) =>
    card.desc.split('\n').find((line) => line.toLowerCase().startsWith(label.toLowerCase() + ':'))?.split(':')[1]?.trim();

  const metadata = {
    headline: textFallback('Headline'),
    description: textFallback('Description'),
    caption: textFallback('Primary Text'),
    cta: textFallback('CTA'),
    click_url: textFallback('Click Through URL')
  };

  console.log(`📝 Metadata parsed:`, metadata);

  for (const attachment of attachments) {
    const ext = attachment.name.toLowerCase().split('.').pop();
    if (!['png', 'jpg', 'jpeg', 'gif', 'mp4'].includes(ext)) {
      console.log(`⏭️ Skipping unsupported file: ${attachment.name}`);
      continue;
    }

    const payload = {
      client_id: clientId,
      name: attachment.name,
      platform: 'social',
      file_url: attachment.url,
      ...metadata
    };

    try {
      const response = await axios.post(
        `${ADPILER_BASE_URL}/creatives`,
        payload,
        { headers: { 'x-api-key': ADPILER_API_KEY } }
      );
      console.log(`✅ Uploaded: ${attachment.name} → ID: ${response.data.id}`);
    } catch (err) {
      console.error(`❌ Failed to upload ${attachment.name}:`, err.response?.data || err.message);
    }

    await delay(500);
  }

  // Add 'Uploaded' label
  try {
    const labelResp = await axios.get(
      `https://api.trello.com/1/boards/${card.idBoard}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
    );
    const uploadedLabel = labelResp.data.find((l) => l.name.toLowerCase() === 'uploaded');

    if (uploadedLabel) {
      await axios.post(
        `https://api.trello.com/1/cards/${cardId}/idLabels`,
        { value: uploadedLabel.id },
        { params: { key: TRELLO_KEY, token: TRELLO_TOKEN } }
      );
      console.log(`🏷️ 'Uploaded' label added to card.`);
    } else {
      console.warn('⚠️ No "Uploaded" label found on board.');
    }
  } catch (err) {
    console.warn('⚠️ Error applying label:', err.response?.data || err.message);
  }
}

module.exports = uploadToAdpiler;

