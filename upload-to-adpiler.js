const axios = require('axios');
const csv = require('csvtojson');
const FormData = require('form-data');
const path = require('path');

const VALID_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.mp4'];

async function downloadAttachment(url, trelloKey, trelloToken) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: {
      Authorization: `OAuth oauth_consumer_key="${trelloKey}", oauth_token="${trelloToken}"`
    }
  });
  return response.data;
}

async function uploadToAdpiler(cardId, env) {
  const {
    TRELLO_KEY,
    TRELLO_TOKEN,
    ADPILER_API_KEY,
    CLIENT_LOOKUP_CSV_URL
  } = env;

  // 1. Get card info
  const cardUrl = `https://api.trello.com/1/cards/${cardId}?fields=name,desc,idList&attachments=true&customFieldItems=true&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
  const card = (await axios.get(cardUrl)).data;

  console.log(`🚀 Uploading card ID: ${cardId}`);
  console.log(`🔐 Using API key: ${ADPILER_API_KEY}`);

  const matchKey = card.name.split(':')[0].trim().toLowerCase();
  console.log(`🧾 Client detected: "${card.name}" → Match Key: "${matchKey}"`);

  // 2. Lookup AdPiler client ID from CSV
  const csvData = await axios.get(CLIENT_LOOKUP_CSV_URL);
  const clientList = await csv().fromString(csvData.data);
  const clientRow = clientList.find(row => row['Trello Client Name']?.trim().toLowerCase() === matchKey);

  if (!clientRow) {
    throw new Error(`Client "${matchKey}" not found in sheet.`);
  }

  const adpilerClientId = clientRow['AdPiler Client ID'];
  if (!adpilerClientId) throw new Error(`Missing AdPiler Client ID for "${matchKey}"`);

  // 3. Extract fields
  const getCustom = (fieldName) => {
    const field = card.customFieldItems?.find(item => item.name?.toLowerCase() === fieldName.toLowerCase());
    return field?.value?.text || '';
  };

  const headline = getCustom('Headline');
  const description = getCustom('Description');
  const caption = getCustom('Primary Text') || getCustom('Caption');
  const cta = getCustom('CTA') || '';
  const clickUrl = getCustom('Click Through URL') || '';

  // 4. Get valid attachments
  const attachments = card.attachments || [];
  const validAttachments = attachments.filter(att => {
    const ext = path.extname(att.name || '').toLowerCase();
    return VALID_EXTENSIONS.includes(ext);
  });

  console.log(`📎 Found ${validAttachments.length} attachments`);

  if (validAttachments.length === 0) throw new Error('No valid creative attachments found');

  // 5. Upload to AdPiler
  for (const attachment of validAttachments) {
    const form = new FormData();
    const fileBuffer = await downloadAttachment(attachment.url, TRELLO_KEY, TRELLO_TOKEN);

    form.append('client_id', adpilerClientId);
    form.append('headline', headline);
    form.append('description', description);
    form.append('caption', caption);
    form.append('cta', cta);
    form.append('click_url', clickUrl);
    form.append('file', fileBuffer, attachment.name);

    try {
      const response = await axios.post('https://app.adpiler.com/api/upload/', form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${ADPILER_API_KEY}`
        }
      });
      console.log(`✅ Uploaded: ${attachment.name} → AdPiler ID: ${response.data?.id || '[unknown]'}`);
    } catch (err) {
      console.error(`❌ Upload error: ${attachment.name}`, err.response?.data || err.message);
    }
  }
}

module.exports = uploadToAdpiler;
