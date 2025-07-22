const FormData = require('form-data');
const csv = require('csvtojson');
const path = require('path');

// Metadata helper
async function fetchAttachmentMetadata(cardId, attachmentId, key, token) {
  if (!cardId?.match(/^[0-9a-fA-F]{24}$/) || !attachmentId?.match(/^[0-9a-fA-F]{24}$/)) {
    console.warn(`⚠️ Invalid ID format: card="${cardId}", attachment="${attachmentId}"`);
    return null;
  }

  const url = `https://api.trello.com/1/cards/${cardId}/attachments/${attachmentId}?key=${key}&token=${token}`;
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) {
      console.error(`⚠️ Metadata request failed for "${attachmentId}" → ${resp.status}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.error(`⚠️ Metadata fetch error for "${attachmentId}": ${err.message}`);
    return null;
  }
}

// Main function
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

    // Step 1: Card metadata
    const cardResp = await fetch(`https://api.trello.com/1/cards/${cardId}?fields=name&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
    const card = await cardResp.json();
    const cardName = card.name || '';
    const matchKey = cardName.split(':')[0]?.trim().toLowerCase();
    console.log(`🧾 Client detected: "${cardName}" → Match Key: "${matchKey}"`);

    // Step 2: Raw attachments
    const attResp = await fetch(`https://api.trello.com/1/cards/${cardId}/attachments?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
    const rawAttachments = await attResp.json();

    if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) {
      console.log('📎 No attachments found.');
      return;
    }

    console.log(`📦 Retrieved ${rawAttachments.length} attachments`);
    const validExt = ['.png', '.jpg', '.jpeg', '.gif', '.mp4'];
    const uploadQueue = [];

    for (const att of rawAttachments) {
      const ext = path.extname(att?.name || '').toLowerCase();
      if (!att || !att.name || !validExt.includes(ext)) {
        console.log(`⚠️ Skipping unsupported file: ${att.name}`);
        continue;
      }

      let url = null;

      if (!att.isUpload) {
        url = att.url;
      } else {
        const metadata = await fetchAttachmentMetadata(cardId, att.id, TRELLO_KEY, TRELLO_TOKEN);
        if (!metadata || !metadata.id) {
          console.log(`⚠️ Skipping: Failed to confirm metadata for "${att.name}"`);
          continue;
        }
        console.log(`📑 Metadata: "${metadata.name}" | mimeType="${metadata.mimeType}" | bytes="${metadata.bytes}"`);
        url = `https://api.trello.com/1/cards/${cardId}/attachments/${att.id}/download?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
      }

      if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        console.log(`⚠️ Skipping attachment with bad URL: ${att.name}`);
        continue;
      }

      uploadQueue.push({ name: att.name, url });
    }

    console.log(`✅ Prepared ${uploadQueue.length} attachments for upload`);

    // Step 3: Client lookup
    const csvResp = await fetch(CLIENT_LOOKUP_CSV_URL);
    const csvText = await csvResp.text();
    const clients = await csv().fromString(csvText);
    const clientMatch = clients.find(c => (c['Trello Client Name'] || '').toLowerCase().trim() === matchKey);
    if (!clientMatch) {
      console.error(`❌ Upload failed: Client "${matchKey}" not found`);
      return;
    }

    const clientId = clientMatch['Adpiler Client ID'];
    const campaignId = clientMatch['Adpiler Campaign ID'];
    console.log(`🎯 Client matched: ID=${clientId}, Campaign=${campaignId}`);

    // Step 4: Upload loop
    for (const [index, item] of uploadQueue.entries()) {
      if (!item?.url || typeof item.url !== 'string') {
        console.error(`❌ Skipping invalid upload item at index ${index}:`, item);
        continue;
      }

      console.log(`📤 Uploading [${index + 1}/${uploadQueue.length}]: "${item.name}"`);
      console.log(`🔗 URL: "${item.url}"`);

      try {
        const fileResp = await fetch(item.url);
        if (!fileResp.ok) {
          console.error(`❌ Failed to fetch "${item.name}" — status: ${fileResp.status}`);
          continue;
        }

        const contentType = fileResp.headers.get('content-type') || '';
        if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
          console.error(`❌ Unexpected content type for "${item.name}": ${contentType}`);
          continue;
        }

        const fileBuffer = await fileResp.arrayBuffer();

        const form = new FormData();
        form.append('client_id', clientId);
        form.append('campaign_id', campaignId);
        form.append('name', item.name);
        form.append('file', Buffer.from(fileBuffer), { filename: item.name });

        const uploadResp = await fetch('https://app.adpiler.com/api/creatives', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${ADPILER_API_KEY}` },
          body: form
        });

        const result = await uploadResp.json();

        if (uploadResp.ok) {
          console.log(`✅ Uploaded "${item.name}" to AdPiler`);
        } else {
          console.error(`❌ Upload error for "${item.name}": ${result.message || JSON.stringify(result)}`);
        }
      } catch (err) {
        console.error(`❌ Exception during upload of "${item.name}": ${err.message || err}`);
      }
    }
  } catch (err) {
    console.error(`❌ Fatal error: ${err.message || err}`);
  }
}

module.exports = uploadToAdpiler;
