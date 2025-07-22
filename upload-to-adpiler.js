const axios = require('axios');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function uploadToAdpiler(cardId, keys) {
  const {
    TRELLO_KEY,
    TRELLO_TOKEN,
    ADPILER_API_KEY,
    ADPILER_BASE_URL,
    CLIENT_LOOKUP_CSV_URL
  } = keys;

  console.log(`🚀 Uploading card ID: ${cardId}`);
  console.log(`🔐 Using API key: ${ADPILER_API_KEY}`);

  // Get Trello card data
  const cardURL = `https://api.trello.com/1/cards/${cardId}?attachments=true&customFieldItems=true&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
  const { data: card } = await axios.get(cardURL);

  // Improved client name extraction
  const clientName = card.name.toLowerCase().split(/[-:]/)[0].trim();
  const attachments = card.attachments || [];

  console.log(`🧾 Client detected: "${card.name}"`);
  console.log(`📎 Found ${attachments.length} attachments`);

  // Match client ID from sheet
  const { data: csvText } = await axios.get(CLIENT_LOOKUP_CSV_URL);
  const rows = csvText.split('\n').map(r => r.split(','));
  const clientRow = rows.find(r => r[0].toLowerCase().includes(clientName));
  if (!clientRow) throw new Error(`Client "${clientName}" not found in sheet.`);
  const clientId = clientRow[1];

  // Extract metadata from Trello card description
  const textFallback = (label) =>
    card.desc.split('\n').find(line => line.startsWith(`${label}:`))?.split(':')[1]?.trim();

  const metadata = {
    headline: textFallback('Headline'),
    description: textFallback('Description'),
    caption: textFallback('Primary Text'),
    cta: textFallback('CTA'),
    clickURL: textFallback('Click Through URL'),
  };

  console.log(`📝 Metadata found:`, metadata);

  // Upload each attachment
  for (const attachment of attachments) {
    const ext = attachment.name.toLowerCase().split('.').pop();
    if (!['png', 'jpg', 'jpeg', 'gif', 'mp4'].includes(ext)) {
      console.log(`⏭️ Skipping unsupported file: ${attachment.name}`);
      continue;
    }

    const fileUrl = attachment.url;
    const payload = {
      client_id: clientId,
      name: attachment.name,
      platform: 'social',
      file_url: fileUrl,
      headline: metadata.headline,
      description: metadata.description,
      caption: metadata.caption,
      cta: metadata.cta,
      click_url: metadata.clickURL,
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

    await delay(500); // avoid rate limiting
  }

  // Apply "Uploaded" label to the card
  const labelResp = await axios.get(
    `https://api.trello.com/1/boards/${card.idBoard}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
  );
  const uploadedLabel = labelResp.data.find(l => l.name.toLowerCase() === 'uploaded');
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
}

module.exports = uploadToAdpiler;
