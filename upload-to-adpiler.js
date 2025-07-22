const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');
const path = require('path');

async function uploadToAdpiler(cardId, env) {
  const {
    TRELLO_KEY,
    TRELLO_TOKEN,
    ADPILER_API_KEY,
    CLIENT_LOOKUP_CSV_URL
  } = env;

  try {
    console.log(`🚀 Uploading card ID: ${cardId}`);
    console.log(`🔐 Using API key: ${ADPILER_API_KEY}`);

    // Get card details
    const cardResp = await fetch(`https://api.trello.com/1/cards/${cardId}?fields=name&attachments=true&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
    const card = await cardResp.json();

    const cardName = card.name || '';
    const matchKey = cardName.split(':')[0]?.trim().toLowerCase();
    console.log(`🧾 Client detected: "${cardName}" → Match Key: "${matchKey}"`);

    const attachments = card.attachments || [];
    if (!attachments.length) {
      console.log('📎 No attachments found.');
      return;
    }

    // Get client lookup table
    const clientCSVResp = await fetch(CLIENT_LOOKUP_CSV_URL);
    const clientCSVText = await clientCSVResp.text();
    const clients = await csv().fromString(clientCSVText);

    const clientMatch = clients.find(c =>
      (c['Trello Client Name'] || '').toLowerCase().trim() === matchKey
    );

    if (!clientMatch) {
      console.error(`❌ Upload failed: Client "${matchKey}" not found in sheet.`);
      return;
    }

    const clientId = clientMatch['Adpiler Client ID'];
    const campaignId = clientMatch['Adpiler Campaign ID'];
    console.log(`✅ Client matched: ID=${clientId}, Campaign=${campaignId}`);

    // Filter valid attachments
    const validExt = ['.png', '.jpg', '.jpeg', '.gif', '.mp4'];
    const validAttachments = attachments.filter(a =>
      validExt.includes(path.extname(a.name || '').toLowerCase())
    );

    console.log(`📎 Found ${validAttachments.length} attachments`);

    for (const attachment of validAttachments) {
      const filename = attachment.name;
      const url = `https://api.trello.com/1/cards/${cardId}/attachments/${attachment.id}/download?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;

      const fileResp = await fetch(url);
      if (!fileResp.ok) {
        console.error(`❌ Failed to fetch attachment: ${filename}`);
        continue;
      }

      const fileBuffer = await fileResp.buffer();

      const form = new FormData();
      form.append('client_id', clientId);
      form.append('campaign_id', campaignId);
      form.append('name', filename);
      form.append('file', fileBuffer, { filename });

      const uploadResp = await fetch('https://app.adpiler.com/api/creatives', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ADPILER_API_KEY}`
        },
        body: form
      });

      const result = await uploadResp.json();

      if (uploadResp.ok) {
        console.log(`✅ Uploaded "${filename}" to AdPiler`);
      } else {
        console.error(`❌ Error uploading "${filename}" to AdPiler: ${result.message || JSON.stringify(result)}`);
      }
    }
  } catch (err) {
    console.error('❌ Upload failed:', err.message || err);
  }
}

module.exports = uploadToAdpiler;

