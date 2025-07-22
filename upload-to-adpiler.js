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

    // Step 2: Get attachments
    const attachmentsResp = await fetch(
      `https://api.trello.com/1/cards/${cardId}/attachments?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
    );
    const rawAttachments = await attachmentsResp.json();

    if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) {
      console.log('📎 No attachments found.');
      return;
    }

    console.log(`📦 Retrieved ${rawAttachments.length} raw attachments`);
    rawAttachments.forEach((att, i) => {
      console.log(`🔍 Attachment ${i + 1}: name="${att.name}", url="${att.url}", isUpload=${att.isUpload}`);
    });

    // Step 3: Filter and prepare uploadable attachments
    const validExt = ['.png', '.jpg', '.jpeg', '.gif', '.mp4'];
    const uploadQueue = [];

    for (const attachment of rawAttachments) {
      const ext = path.extname(attachment?.name || '').toLowerCase();

      if (
        !attachment ||
        typeof attachment !== 'object' ||
        !attachment.name ||
        !validExt.includes(ext)
      ) {
        console.log(`⚠️ Skipping invalid or unsupported file: ${attachment.name}`);
        continue;
      }

      let url = null;

      if (!attachment.isUpload) {
        // Use link-style attachment URL directly
        url = attachment.url;
      } else {
        // Build download URL from attachment ID using Trello's authenticated API
        url = `https://api.trello.com/1/cards/${cardId}/attachments/${attachment.id}/download?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
      }

      if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        console.log(`⚠️ Skipping attachment with bad URL: ${attachment.name}`);
        continue;
      }

      uploadQueue.push({ name: attachment.name, url });
    }

    console.log(`✅ Prepared ${uploadQueue.length} attachments for upload`);

    // Step 4: Get client lookup info
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
    console.log(`🎯 Client matched: ID=${clientId}, Campaign=${campaignId}`);

    // Step 5: Upload each item
    for (const [index, item] of uploadQueue.entries()) {
      const filename = item.name;
      const url = item.url;

      console.log(`📤 Uploading [${index + 1}/${uploadQueue.length}]: "${filename}"`);
      console.log(`🔗 URL: "${url}"`);

      try {
        const fileResp = await fetch(url);
        if (!fileResp.ok) {
          console.error(`❌ Failed to fetch "${filename}" — status: ${fileResp.status}`);
          continue;
        }

        const contentType = fileResp.headers.get('content-type') || '';
        if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
          console.error(`❌ Unexpected content type for "${filename}": ${contentType}`);
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
          console.error(`❌ Error uploading "${filename}": ${result.message || JSON.stringify(result)}`);
        }
      } catch (err) {
        console.error(`❌ Exception during upload of "${filename}": ${err.message || err}`);
      }
    }
  } catch (err) {
    console.error('❌ Upload failed:', err.message || err);
  }
}

module.exports = uploadToAdpiler;

