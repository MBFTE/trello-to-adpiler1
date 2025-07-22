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

    // Step 1: Get card metadata
    const cardResp = await fetch(
      `https://api.trello.com/1/cards/${cardId}?fields=name&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
    );
    const card = await cardResp.json();

    const cardName = card.name || '';
    const matchKey = cardName.split(':')[0]?.trim().toLowerCase();
    console.log(`🧾 Client detected: "${cardName}" → Match Key: "${matchKey}"`);

    // Step 2: Get full attachment data
    const attachmentsResp = await fetch(
      `https://api.trello.com/1/cards/${cardId}/attachments?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
    );
    const attachments = await attachmentsResp.json();

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

    console.log(`📎 Found ${validAttachments.length} valid attachments`);

    for (const attachment of validAttachments) {
      const filename = attachment.name;
      const url = attachment.url;

      if (!url || !url.startsWith('https://')) {
        console.error(`❌ Invalid attachment URL for "${filename}"`);
        continue;
      }

      const fileResp = await fetch(url);
      if (!fileResp.ok) {
        console.error(`❌ Failed to fetch attachment: ${filename}`);
        continue;
      }

      const fileBuffer = await fileResp.arrayBuffer();

      const form = new FormData();
      form.append('client_id', clientId);
      form.append('campaign_id', campaignId);
      form.append('name', filename);
      form.append('file', Buffer.from(fileBuffer), { filename });

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

