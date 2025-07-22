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

    if (!Array.isArray(rawAttachments) || !rawAttachments.length) {
      console.log('📎 No attachments found.');
      return;
    }

    console.log(`📦 Retrieved ${rawAttachments.length} raw attachments`);
    rawAttachments.forEach((att, i) => {
      console.log(`🔍 Attachment ${i + 1}: name="${att?.name}", url="${att?.url}"`);
    });

    // Step 3: Filter attachments
    const validExt = ['.png', '.jpg', '.jpeg', '.gif', '.mp4'];
    const validAttachments = rawAttachments.filter(a => {
      const ext = path.extname(a?.name || '').toLowerCase();
      return (
        a &&
        typeof a === 'object' &&
        typeof a.url === 'string' &&
        a.url.trim().startsWith('https://') &&
        typeof a.name === 'string' &&
        ext &&
        validExt.includes(ext)
      );
    });

    console.log(`✅ Found ${validAttachments.length} valid attachments`);

    // Step 4: Get client mapping
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

    // Step 5: Upload each valid attachment
    for (const [index, attachment] of validAttachments.entries()) {
      if (!attachment || typeof attachment !== 'object') {
        console.error(`❌ Skipping: Attachment is not a valid object at index ${index}`);
        continue;
      }

      const filename = attachment.name;
      const url = attachment.url;

      console.log(`📤 Uploading [${index + 1}/${validAttachments.length}]: "${filename}"`);
      console.log(`🔗 URL: "${url || '[undefined]'}"`);

      if (
        !url ||
        typeof url !== 'string' ||
        url.trim() === '' ||
        url === 'undefined' ||
        !url.startsWith('http')
      ) {
        console.error(`❌ Skipping upload: Bad URL for "${filename}" → "${url}"`);
        continue;
      }

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
      } catch (uploadError) {
        console.error(`❌ Exception during upload of "${filename}": ${uploadError.message || uploadError}`);
      }
    }
  } catch (err) {
    console.error('❌ Upload failed:', err.message || err);
  }
}

module.exports = uploadToAdpiler;
