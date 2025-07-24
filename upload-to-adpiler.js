const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');

async function uploadToAdpiler(cardId, env) {
  const {
    TRELLO_KEY,
    TRELLO_TOKEN,
    ADPILER_API_KEY,
    CLIENT_LOOKUP_CSV_URL
  } = env;

  const trelloHeaders = {
    Authorization: `OAuth oauth_consumer_key="${TRELLO_KEY}", oauth_token="${TRELLO_TOKEN}"`
  };

  const trelloBaseUrl = `https://api.trello.com/1/cards/${cardId}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}&attachments=true&fields=name,desc`;
  const cardRes = await fetch(trelloBaseUrl);
  const card = await cardRes.json();

  const cardName = card.name || 'Unnamed Card';
  console.log(`🚀 Uploading card ID: ${cardId}`);
  console.log(`🧾 Client detected: "${cardName}"`);

  // Download and parse Google Sheet CSV
  const csvRes = await fetch(CLIENT_LOOKUP_CSV_URL);
  const csvText = await csvRes.text();
  const clients = await csv().fromString(csvText);

  const matchKey = cardName.toLowerCase().split(':')[0].trim();
  const clientMatch = clients.find(c =>
    c['Trello Client Name'] &&
    c['Trello Client Name'].toLowerCase().includes(matchKey)
  );

  if (!clientMatch) throw new Error(`No matching AdPiler client for: "${matchKey}"`);

  const adpilerClientId = clientMatch['Adpiler Client ID'];
  console.log(`→ Match Key: "${matchKey}"`);

  const validAttachments = (card.attachments || []).filter(att => {
    const { name, bytes, mimeType } = att;
    const ext = name?.split('.').pop()?.toLowerCase();
    return ['png', 'jpg', 'jpeg', 'gif', 'mp4'].includes(ext) &&
           bytes > 0 &&
           mimeType &&
           mimeType.startsWith('image/');
  });

  if (!validAttachments.length) throw new Error('No valid attachments found');

  for (const asset of validAttachments) {
    const downloadUrl = `https://api.trello.com/1/cards/${cardId}/attachments/${asset.id}/download?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) throw new Error(`Download failed: ${fileRes.statusText}`);

    const fileBuffer = await fileRes.buffer();
    const form = new FormData();

    form.append('client_id', adpilerClientId);
    form.append('title', cardName);
    form.append('type', 'social');
    form.append('file', fileBuffer, {
      filename: asset.name,
      contentType: asset.mimeType || 'image/png',
    });

    const res = await fetch('https://platform.adpiler.com/api/mockups', {
      method: 'POST',
      headers: {
        'X-API-KEY': ADPILER_API_KEY,
        ...form.getHeaders()
      },
      body: form,
    });

    const body = await res.json();
    if (!res.ok) {
      console.error('❌ Upload failed:', body);
      throw new Error(body.message || 'AdPiler upload failed');
    }

    console.log(`✅ Uploaded to AdPiler: ${asset.name}`);
  }
}

module.exports = uploadToAdpiler;

