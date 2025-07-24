// upload-to-adpiler.js
require('dotenv').config();
const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');
const { parse } = require('url');

const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const GOOGLE_SHEET_CSV = process.env.CLIENT_SHEET_CSV_URL;
const ADPILER_API_KEY = process.env.ADPILER_API_KEY;
const ADPILER_API_URL = 'https://platform.adpiler.com/api/social-ads';

const getClientIdFromSheet = async (clientName) => {
  try {
    const jsonArray = await csv().fromStream((await fetch(GOOGLE_SHEET_CSV)).body);
    const match = jsonArray.find(row => row['Trello Client Name']?.toLowerCase().trim() === clientName.toLowerCase().trim());
    return match?.['Adpiler Client ID'] || null;
  } catch (err) {
    console.error('❌ Error reading client sheet:', err);
    return null;
  }
};

const getCardAttachments = async (cardId) => {
  const url = `https://api.trello.com/1/cards/${cardId}/attachments?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to get attachments: ${res.statusText}`);
  return res.json();
};

const getCardDetails = async (cardId) => {
  const url = `https://api.trello.com/1/cards/${cardId}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}&fields=name,desc`;  
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to get card: ${res.statusText}`);
  return res.json();
};

const uploadToAdpiler = async (cardId) => {
  console.log(`🚀 Uploading card ID: ${cardId}`);

  const card = await getCardDetails(cardId);
  const clientName = card.name.split(':')[0]?.trim() || '';
  console.log(`🧾 Client detected: "${card.name}" → Match Key: "${clientName.toLowerCase()}"`);

  const clientId = await getClientIdFromSheet(clientName);
  if (!clientId) throw new Error(`Could not find Adpiler Client ID for "${clientName}"`);

  const attachments = await getCardAttachments(cardId);
  const imageAttachments = attachments.filter(att => att.mimeType?.includes('image'));

  if (!imageAttachments.length) throw new Error('No image attachments found.');

  const form = new FormData();
  form.append('api_key', ADPILER_API_KEY);
  form.append('client_id', clientId);
  form.append('headline', 'Sample Headline');
  form.append('description', card.desc || '');
  form.append('cta', 'Learn More');
  form.append('click_url', 'https://example.com');

  for (const attachment of imageAttachments) {
    const response = await fetch(`${attachment.url}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
    if (!response.ok) throw new Error(`Failed to fetch image: ${attachment.url}`);

    const buffer = await response.buffer();
    form.append('files[]', buffer, {
      filename: attachment.name,
      contentType: attachment.mimeType || 'image/png'
    });
  }

  const uploadRes = await fetch(ADPILER_API_URL, {
    method: 'POST',
    body: form
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`Upload failed: ${errText}`);
  }

  console.log('✅ Upload successful');
};

module.exports = { uploadToAdpiler };
