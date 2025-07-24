const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');

const ADPILER_API_KEY = process.env.ADPILER_API_KEY;
const ADPILER_BASE_URL = process.env.ADPILER_BASE_URL;
const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;

const CLIENT_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv";

async function getClientMapping(cardName) {
  const response = await fetch(CLIENT_CSV_URL);
  const csvText = await response.text();
  const clients = await csv().fromString(csvText);

  const match = clients.find(c => c["Trello Client Name"]?.trim() === cardName.trim());
  if (!match) return null;

  return {
    clientId: match["Adpiler Client ID"],
    folderId: match["Adpiler Folder ID"]
  };
}

async function uploadToAdpiler(card, attachments) {
  try {
    const mapping = await getClientMapping(card.name);
    if (!mapping) throw new Error(`No matching entry found for card: ${card.name}`);

    console.log(`🎯 AdPiler Client ID: ${mapping.clientId}`);
    console.log(`📁 AdPiler Folder ID: ${mapping.folderId}`);

    for (let attachment of attachments) {
      console.log(`📥 Fetching image: ${attachment.name}`);
      const response = await fetch(`${attachment.url}?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`);
      if (!response.ok) throw new Error(`Failed to fetch attachment: ${attachment.url}`);

      const buffer = await response.buffer();

      const form = new FormData();
      form.append('client_id', mapping.clientId);
      form.append('folder_id', mapping.folderId);
      form.append('name', attachment.name);
      form.append('image', buffer, attachment.name);

      console.log(`📤 Uploading to AdPiler...`);
      const uploadResponse = await fetch(`${ADPILER_BASE_URL}/social-ads-slides`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ADPILER_API_KEY}`,
          ...form.getHeaders()
        },
        body: form
      });

      const result = await uploadResponse.json();
      if (!uploadResponse.ok) {
        console.error(`❌ Upload failed:`, result);
      } else {
        console.log(`✅ Uploaded slide: ${attachment.name}`);
      }
    }
  } catch (err) {
    console.error(`❌ Upload error: ${err.message}`);
  }
}

module.exports = { uploadToAdpiler };

