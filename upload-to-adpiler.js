const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');

const VALID_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'video/mp4'];

module.exports = async function uploadToAdpiler(cardId, env) {
  const {
    TRELLO_KEY,
    TRELLO_TOKEN,
    ADPILER_API_KEY,
    CLIENT_LOOKUP_CSV_URL
  } = env;

  const trelloCardUrl = `https://api.trello.com/1/cards/${cardId}?fields=name,desc&attachments=true&attachment_fields=bytes,date,mimeType,name,url&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
  const trelloResp = await fetch(trelloCardUrl);
  const cardData = await trelloResp.json();

  const cardName = cardData.name || '';
  const [clientRaw] = cardName.split(':');
  const matchKey = clientRaw.trim().toLowerCase();

  console.log(`🧾 Client detected: "${cardName}"\n→ Match Key: "${matchKey}"`);

  const csvResp = await fetch(CLIENT_LOOKUP_CSV_URL);
  const clients = await csv().fromString(await csvResp.text());

  const matchedClient = clients.find(c =>
    c['Trello Client Name']?.trim().toLowerCase() === matchKey
  );

  if (!matchedClient) {
    throw new Error(`Client "${matchKey}" not found in sheet.`);
  }

  const adpilerClientId = matchedClient['AdPiler Client ID'];
  if (!adpilerClientId) {
    throw new Error(`No AdPiler ID found for "${matchKey}".`);
  }

  const attachments = (cardData.attachments || []).filter(att => {
    const ext = (att.name || '').toLowerCase();
    const type = att.mimeType || '';
    return (
      att.url &&
      att.url.startsWith('http') &&
      VALID_MIME_TYPES.includes(type) &&
      (ext.endsWith('.png') || ext.endsWith('.jpg') || ext.endsWith('.jpeg') || ext.endsWith('.gif') || ext.endsWith('.mp4'))
    );
  });

  console.log(`📎 Found ${attachments.length} attachments`);

  const uploadQueue = attachments.map(att => ({
    name: att.name,
    url: `${att.url}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
  }));

  for (const file of uploadQueue) {
    try {
      const fileResp = await fetch(file.url);
      if (!fileResp.ok) throw new Error(`Failed to fetch ${file.name}`);

      const buffer = await fileResp.buffer();
      const form = new FormData();
      form.append('client_id', adpilerClientId);
      form.append('title', file.name);
      form.append('file', buffer, { filename: file.name });

      const uploadResp = await fetch('https://app.adpiler.com/api/upload-file', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ADPILER_API_KEY}`
        },
        body: form
      });

      const uploadJson = await uploadResp.json();
      if (uploadResp.ok) {
        console.log(`✅ Uploaded: ${file.name}`);
      } else {
        console.error(`❌ Upload error: ${file.name}`, uploadJson);
      }
    } catch (err) {
      console.error(`❌ Fatal error uploading ${file.name}:`, err.message || err);
    }
  }
};
