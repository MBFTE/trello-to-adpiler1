const FormData = require('form-data');
const csv = require('csvtojson');
const path = require('path');

// 📑 Attachment metadata lookup
async function fetchAttachmentMetadata(cardId, attachmentId, key, token) {
  const idPattern = /^[0-9a-fA-F]{24}$/;
  if (!idPattern.test(cardId) || !idPattern.test(attachmentId)) {
    console.warn(`⚠️ Invalid ID format → card="${cardId}", attachment="${attachmentId}"`);
    return null;
  }

  const metadataURL = `https://api.trello.com/1/cards/${cardId}/attachments/${attachmentId}?key=${key}&token=${token}`;

  try {
    const res = await fetch(metadataURL, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.warn(`⚠️ Metadata request failed for attachment ${attachmentId} — status: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`⚠️ Metadata fetch error: ${err.message}`);
    return null;
  }
}

async function uploadToAdpiler(cardId, env) {
  const { TRELLO_KEY, TRELLO_TOKEN, ADPILER_API_KEY, CLIENT_LOOKUP_CSV_URL } = env;

  try {
    console.log(`🚀 Uploading card ID: ${cardId}`);

    // Step 1: Get card metadata
    const cardRes = await fetch(`https://api.trello.com/1/cards/${cardId}?fields=name&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
    const card = await cardRes.json();
    const cardName = card?.name || '';
    const matchKey = cardName.split(':')[0]?.trim().toLowerCase();
    console.log(`🧾 Client detected: "${cardName}" → Match Key: "${matchKey}"`);

    // Step 2: Get attachments
    const attRes = await fetch(`https://api.trello.com/1/cards/${cardId}/attachments?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
    const attachments = await attRes.json();

    if (!Array.isArray(attachments) || attachments.length === 0) {
      console.log('📎 No attachments found.');
      return;
    }

    console.log(`📦 Retrieved ${attachments.length} attachments`);
    const validExt = ['.png', '.jpg', '.jpeg', '.gif', '.mp4'];
    const uploadQueue = [];

    for (const att of attachments) {
      const ext = path.extname(att?.name || '').toLowerCase();
      if (!att?.name || !validExt.includes(ext)) {
        console.log(`⚠️ Skipping unsupported attachment: ${att.name}`);
        continue;
      }

      let url = null;

      if (!att.isUpload) {
        url = att.url;
      } else {
        if (!att.id || att.id.length !== 24) {
          console.warn(`⚠️ Skipping invalid attachment ID: ${att.name}`);
          continue;
        }

        const metadata = await fetchAttachmentMetadata(cardId, att.id, TRELLO_KEY, TRELLO_TOKEN);
        if (!metadata || !metadata.id || !metadata.name) {
          console.warn(`⚠️ Skipping: Invalid metadata for ${att.name}`);
          continue;
        }

        console.log(`📑 Metadata: "${metadata.name}" | mimeType="${metadata.mimeType}" | bytes="${metadata.bytes}"`);
        url = `https://api.trello.com/1/cards/${cardId}/attachments/${att.id}/download?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
      }

      if (!url || typeof url !== 'string' || url.trim() === '' || url.includes('undefined')) {
        console.warn(`⚠️ Skipping malformed URL for "${att.name}": ${url}`);
        continue;
      }

      console.log(`📥 Queuing for upload: name="${att.name}", url="${url}"`);
      uploadQueue.push({ name: att.name, url });
    }

    console.log(`✅ Prepared ${uploadQueue.length} attachments for upload`);

    // Step 3: Match client
    const csvRes = await fetch(CLIENT_LOOKUP_CSV_URL);
    const csvText = await csvRes.text();
    const clients = await csv().fromString(csvText);
    const clientMatch = clients.find(c =>
      (c['Trello Client Name'] || '').toLowerCase().trim() === matchKey
    );

    if (!clientMatch) {
      console.error(`❌ Client "${matchKey}" not found`);
      return;
    }

    const clientId = clientMatch['Adpiler Client ID'];
    const campaignId = clientMatch['Adpiler Campaign ID'];
    console.log(`🎯 Client matched: ID=${clientId}, Campaign=${campaignId}`);

    // Step 4: Upload loop
    for (const [index, item] of uploadQueue.entries()) {
      if (!item || typeof item !== 'object') {
        console.error(`❌ Invalid item at index ${index}:`, item);
        continue;
      }

      const { name, url } = item;

      if (!name || typeof name !== 'string') {
        console.error(`❌ Missing name at index ${index}`);
        continue;
      }

      if (!url || typeof url !== 'string' || url.trim() === '' || url === 'undefined') {
        console.error(`❌ Bad URL for "${name}" → "${url}"`);
        continue;
      }

      console.log(`📤 Uploading [${index + 1}/${uploadQueue.length}]: "${name}"`);
      console.log(`🔗 URL: "${url}"`);

      try {
        const fileRes = await fetch(url);
        if (!fileRes.ok) {
          console.error(`❌ Failed to fetch "${name}" — status: ${fileRes.status}`);
          continue;
        }

        const contentType = fileRes.headers.get('content-type') || '';
        if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
          console.error(`❌ Invalid content-type for "${name}": ${contentType}`);
          continue;
        }

        const fileBuffer = await fileRes.arrayBuffer();
        const form = new FormData();
        form.append('client_id', clientId);
        form.append('campaign_id', campaignId);
        form.append('name', name);
        form.append('file', Buffer.from(fileBuffer), { filename: name });

        const uploadRes = await fetch('https://app.adpiler.com/api/creatives', {
          method: 'POST',
          headers: { Authorization: `Bearer ${ADPILER_API_KEY}` },
          body: form
        });

        const result = await uploadRes.json();

        if (uploadRes.ok) {
          console.log(`✅ Uploaded "${name}"`);
        } else {
          console.error(`❌ AdPiler error for "${name}": ${result.message || JSON.stringify(result)}`);
        }
      } catch (err) {
        console.error(`❌ Exception for "${name}": ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`❌ Fatal error: ${err.message || err}`);
  }
}

module.exports = uploadToAdpiler;
