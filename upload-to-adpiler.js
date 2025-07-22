const FormData = require('form-data');
const csv = require('csvtojson');
const path = require('path');

// Validate Trello ID format
function isValidTrelloId(id) {
  return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id);
}

// 📑 Fetch metadata for one attachment
async function fetchAttachmentMetadata(cardId, attachmentId, key, token) {
  if (!isValidTrelloId(cardId) || !isValidTrelloId(attachmentId)) {
    console.warn(`⚠️ Invalid Trello ID → card="${cardId}" attachment="${attachmentId}"`);
    return null;
  }

  const fields = 'name,mimeType,bytes,isUpload,url';
  const url = `https://api.trello.com/1/cards/${cardId}/attachments/${attachmentId}?fields=${fields}&key=${key}&token=${token}`;

  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status !== 200) {
      console.error(`❌ Metadata fetch failed — ${res.status} ${res.statusText}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`❌ Metadata fetch error for "${attachmentId}": ${err.message}`);
    return null;
  }
}

// 🚀 Upload function
async function uploadToAdpiler(cardId, env) {
  const { TRELLO_KEY, TRELLO_TOKEN, ADPILER_API_KEY, CLIENT_LOOKUP_CSV_URL } = env;

  try {
    console.log(`🚀 Uploading card ID: ${cardId}`);

    // Card name and match key
    const cardRes = await fetch(`https://api.trello.com/1/cards/${cardId}?fields=name&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
    const card = await cardRes.json();
    const cardName = card?.name || '';
    const matchKey = cardName.split(':')[0]?.trim().toLowerCase();
    console.log(`🧾 Client detected: "${cardName}" → Match Key: "${matchKey}"`);

    // Get attachments
    const attRes = await fetch(`https://api.trello.com/1/cards/${cardId}/attachments?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
    const rawAttachments = await attRes.json();

    if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) {
      console.log('📎 No attachments found.');
      return;
    }

    console.log(`📦 Retrieved ${rawAttachments.length} attachments`);
    const validExt = ['.png', '.jpg', '.jpeg', '.gif', '.mp4'];
    const uploadQueue = [];

    for (const att of rawAttachments) {
      const ext = path.extname(att?.name || '').toLowerCase();
      if (!att?.name || !validExt.includes(ext)) {
        console.log(`⚠️ Skipping unsupported or unnamed attachment: ${att.name}`);
        continue;
      }

      let url;

      if (!att.isUpload) {
        url = att.url;
      } else {
        if (!isValidTrelloId(att.id)) {
          console.warn(`⚠️ Skipping invalid attachment ID: ${att.name}`);
          continue;
        }

        const metadata = await fetchAttachmentMetadata(cardId, att.id, TRELLO_KEY, TRELLO_TOKEN);
        if (!metadata || !metadata.name || !metadata.mimeType) {
          console.warn(`⚠️ Skipping due to bad metadata for "${att.name}"`);
          continue;
        }

        console.log(`📑 Metadata: "${metadata.name}" | mimeType="${metadata.mimeType}" | bytes="${metadata.bytes}"`);
        url = `https://api.trello.com/1/cards/${cardId}/attachments/${att.id}/download?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
      }

      if (!url || typeof url !== 'string' || url.trim() === '' || url.includes('undefined')) {
        console.warn(`⚠️ Skipping malformed URL for "${att.name}" → "${url}"`);
        continue;
      }

      uploadQueue.push({ name: att.name, url });
    }

    console.log(`✅ Prepared ${uploadQueue.length} attachments for upload`);
    console.log(`🧾 Final uploadQueue:`, JSON.stringify(uploadQueue, null, 2));

    // Client match
    const csvRes = await fetch(CLIENT_LOOKUP_CSV_URL);
    const csvText = await csvRes.text();
    const clients = await csv().fromString(csvText);
    const clientMatch = clients.find(c => (c['Trello Client Name'] || '').toLowerCase().trim() === matchKey);
    if (!clientMatch) {
      console.error(`❌ Upload failed: Client "${matchKey}" not found`);
      return;
    }

    const clientId = clientMatch['Adpiler Client ID'];
    const campaignId = clientMatch['Adpiler Campaign ID'];
    console.log(`🎯 Client matched: ID=${clientId}, Campaign=${campaignId}`);

    // Upload loop
    for (const [index, item] of uploadQueue.entries()) {
      const { name, url } = item;

      if (!name || typeof name !== 'string' || !url || typeof url !== 'string' || url.trim() === '' || url.includes('undefined')) {
        console.error(`❌ Skipping bad upload item: name="${name}", url="${url}"`);
        continue;
      }

      console.log(`📤 Uploading [${index + 1}/${uploadQueue.length}]: "${name}"`);
      console.log(`🔗 URL: "${url}"`);

      try {
        const fileRes = await fetch(url);
        if (!fileRes.ok) {
          console.error(`❌ Failed to fetch "${name}" — status ${fileRes.status}`);
          continue;
        }

        const contentType = fileRes.headers.get('content-type') || '';
        if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
          console.error(`❌ Invalid content-type for "${name}": ${contentType}`);
          continue;
        }

        const fileBuffer = await fileRes.arrayBuffer();
        if (!fileBuffer || fileBuffer.byteLength === 0) {
          console.error(`❌ Empty or invalid buffer for "${name}"`);
          continue;
        }

        console.log(`📦 Form content for "${name}":`, {
          name,
          client_id: clientId,
          campaign_id: campaignId,
          file_bytes: fileBuffer.byteLength
        });

        const form = new FormData();
        form.append('client_id', clientId);
        form.append('campaign_id', campaignId);
        form.append('name', name);
        form.append('file', Buffer.from(fileBuffer), { filename: name });

        const headers = form.getHeaders();
        headers['Authorization'] = `Bearer ${ADPILER_API_KEY}`;

        let uploadRes;
        try {
          uploadRes = await fetch('https://app.adpiler.com/api/creatives', {
            method: 'POST',
            headers,
            body: form
          });
        } catch (uploadErr) {
          console.error(`❌ Fetch error to AdPiler for "${name}": ${uploadErr.message}`);
          continue;
        }

        let result;
        try {
          result = await uploadRes.json();
        } catch (jsonErr) {
          console.error(`❌ Response parse error for "${name}": ${jsonErr.message}`);
          continue;
        }

        if (uploadRes.ok) {
          console.log(`✅ Uploaded "${name}" successfully`);
        } else {
          console.error(`❌ AdPiler error for "${name}": ${result.message || JSON.stringify(result)}`);
        }
      } catch (err) {
        console.error(`❌ Exception during upload of "${name}": ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`❌ Fatal error: ${err.message}`);
  }
}

module.exports = uploadToAdpiler;
