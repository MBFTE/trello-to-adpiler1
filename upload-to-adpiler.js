const FormData = require('form-data');
const csv = require('csvtojson');
const path = require('path');

// 🔎 Trello Metadata Helper
async function fetchAttachmentMetadata(cardId, attachmentId, key, token) {
  if (
    !cardId?.match(/^[0-9a-fA-F]{24}$/) ||
    !attachmentId?.match(/^[0-9a-fA-F]{24}$/)
  ) {
    console.warn(`⚠️ Invalid Trello ID format → card="${cardId}", attachment="${attachmentId}"`);
    return null;
  }

  const metadataUrl = `https://api.trello.com/1/cards/${cardId}/attachments/${attachmentId}?key=${key}&token=${token}`;

  try {
    const resp = await fetch(metadataUrl, {
      headers: { Accept: 'application/json' }
    });

    if (!resp.ok) {
      console.error(`⚠️ Metadata fetch failed for attachment ${attachmentId} — status ${resp.status}`);
      return null;
    }

    const metadata = await resp.json();
    return metadata;
  } catch (err) {
    console.error(`⚠️ Metadata fetch error: ${err.message || err}`);
    return null;
  }
}

// 🚀 Main Upload Function
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

    // 1️⃣ Get Card Metadata
    const cardResp = await fetch(`https://api.trello.com/1/cards/${cardId}?fields=name&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
    const card = await cardResp.json();
    const cardName = card.name || '';
    const matchKey = cardName.split(':')[0]?.trim().toLowerCase();
    console.log(`🧾 Client detected: "${cardName}" → Match Key: "${matchKey}"`);

    // 2️⃣ Get Raw Attachments
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

      if (!att?.name || !validExt.includes(ext)) {
        console.log(`⚠️ Skipping unsupported or unnamed attachment: ${att.name}`);
        continue;
      }

      let url = null;

      if (!att.isUpload) {
        url = att.url;
      } else {
        if (!att.id || typeof att.id !== 'string' || att.id.length !== 24) {
          console.warn(`⚠️ Skipping attachment with invalid ID: ${att.name}`);
          continue;
        }

        const metadata = await fetchAttachmentMetadata(cardId, att.id, TRELLO_KEY, TRELLO_TOKEN);
        if (!metadata || !metadata.id || !metadata.name) {
          console.warn(`⚠️ Skipping attachment due to failed metadata for: ${att.name}`);
          continue;
        }

        console.log(`📑 Metadata: "${metadata.name}" | mimeType="${metadata.mimeType}" | bytes="${metadata.bytes}"`);

        url = `https://api.trello.com/1/cards/${cardId}/attachments/${att.id}/download?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
      }

      if (!url || typeof url !== 'string' || url.trim() === '' || url.includes('undefined')) {
        console.warn(`⚠️ Skipping attachment with malformed URL: ${att.name} → "${url}"`);
        continue;
      }

      uploadQueue.push({ name: att.name, url });
    }

    console.log(`✅ Prepared ${uploadQueue.length} attachments for upload`);

    // 3️⃣ Match Client Info
    const clientCSVResp = await fetch(CLIENT_LOOKUP_CSV_URL);
    const clientCSVText = await clientCSVResp.text();
    const clients = await csv().fromString(clientCSVText);

    const clientMatch = clients.find(c =>
      (c['Trello Client Name'] || '').toLowerCase().trim() === matchKey
    );

    if (!clientMatch) {
      console.error(`❌ Upload failed: Client "${matchKey}" not found`);
      return;
    }

    const clientId = clientMatch['Adpiler Client ID'];
    const campaignId = clientMatch['Adpiler Campaign ID'];
    console.log(`🎯 Client matched: ID=${clientId}, Campaign=${campaignId}`);

    // 4️⃣ Upload Loop
    for (const [index, item] of uploadQueue.entries()) {
      if (!item?.url || typeof item.url !== 'string') {
        console.error(`❌ Skipping upload item with bad URL at index ${index}:`, item);
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

