const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { getClientIdFromCard } = require('./client-mapping');

const ADPILER_API_KEY = process.env.ADPILER_API_KEY;
const ADPILER_BASE_URL = process.env.ADPILER_BASE_URL;
const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;

async function uploadToAdpiler(card, attachments) {
  try {
    const clientName = card.name;
    const clientId = await getClientIdFromCard(clientName);

    if (!clientId) throw new Error(`No AdPiler client ID found for card: ${clientName}`);

    console.log(`🎯 AdPiler Client ID: ${clientId}`);

    for (let i = 0; i < attachments.length; i++) {
      const attachment = attachments[i];

      console.log(`📥 Fetching image data for: ${attachment.name}`);
      const response = await fetch(`${attachment.url}?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`);
      if (!response.ok) throw new Error(`Failed to fetch attachment: ${attachment.url}`);

      const buffer = await response.buffer();

      const form = new FormData();
      form.append('client_id', clientId);
      form.append('name', attachment.name);
      form.append('image', buffer, attachment.name);

      console.log(`📤 Uploading to AdPiler...`);
      const uploadResponse = await fetch(`${ADPILER_BASE_URL}/social-ads-slides`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ADPILER_API_KEY}`,
          ...form.getHeaders(),
        },
        body: form,
      });

      const result = await uploadResponse.json();

      if (!uploadResponse.ok) {
        console.error(`❌ Upload failed:`, result);
      } else {
        console.log(`✅ Uploaded slide: ${attachment.name}`);
      }
    }
  } catch (err) {
    console.error(`❌ Upload failed: ${err.message}`);
  }
}

module.exports = uploadToAdpiler;

