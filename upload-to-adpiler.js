// upload-to-adpiler.js
const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');

const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'video/mp4'
];

const ALLOWED_DIMENSIONS = [
  { width: 1200, height: 1200 }, // social
  { width: 300, height: 600 }    // display
];

async function uploadToAdpiler(cardId, env) {
  console.log(`🚀 Uploading card ID: ${cardId}`);
  console.log(`🔐 Using API key: ${env.ADPILER_API_KEY}`);

  // Step 1: Fetch card data from Trello
  const cardUrl = `https://api.trello.com/1/cards/${cardId}?fields=name,desc&attachments=true&attachment_fields=bytes,date,mimeType,name,url&key=${env.TRELLO_KEY}&token=${env.TRELLO_TOKEN}`;
  const cardRes = await fetch(cardUrl);
  if (!cardRes.ok) throw new Error('Failed to fetch Trello card');
  const card = await cardRes.json();

  const cardName = card.name;
  const matchKey = cardName.split(':')[0].trim().toLowerCase();
  console.log(`🧾 Client detected: "${cardName}"\n→ Match Key: "${matchKey}"`);

  // Step 2: Fetch client lookup CSV
  const csvRes = await fetch(env.CLIENT_LOOKUP_CSV_URL);
  if (!csvRes.ok) throw new Error('Failed to fetch client CSV');
  const csvText = await csvRes.text();
  const clients = await csv().fromString(csvText);

  const matchedClient = clients.find(row => row['Trello Client Name'].toLowerCase().trim() === matchKey);
  if (!matchedClient) throw new Error(`Client match not found for: "${matchKey}"`);
  const client_id = matchedClient['Adpiler Client ID'];

  // Step 3: Build attachment payloads
  const attachments = (card.attachments || []).filter(att => {
    return ALLOWED_MIME_TYPES.includes(att.mimeType);
  });

  if (attachments.length === 0) throw new Error('No valid attachments to upload');

  const uploadQueue = attachments.map(att => ({
    name: att.name,
    url: `${att.url}?key=${env.TRELLO_KEY}&token=${env.TRELLO_TOKEN}`
  }));

  console.log(`📎 Prepared ${uploadQueue.length} attachments for upload`);

  // Step 4: Prepare metadata (custom fields pulled from description)
  const meta = extractMetadata(card.desc);
  if (!meta.headline || !meta.description) {
    console.warn('⚠️ Missing metadata (headline/description)');
  }

  // Step 5: Upload to Adpiler (loop through attachments)
  for (const creative of uploadQueue) {
    const payload = {
      client_id,
      name: creative.name,
      platform: 'social',
      file_url: creative.url,
      headline: meta.headline || '',
      description: meta.description || '',
      caption: meta.caption || '',
      cta: meta.cta || '',
      click_url: meta.url || ''
    };

    const res = await fetch('https://platform.adpiler.com/api/creatives', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ADPILER_API_KEY
      },
      body: JSON.stringify(payload)
    });

    const resData = await res.json();
    if (!res.ok) {
      console.error(`❌ Upload failed for ${creative.name}:`, resData);
      throw new Error(resData.message || 'Upload failed');
    }

    console.log(`✅ Uploaded ${creative.name} → ID ${resData.id}`);
  }
}

function extractMetadata(desc) {
  const fields = ['headline', 'description', 'caption', 'cta', 'url'];
  const meta = {};

  for (const field of fields) {
    const regex = new RegExp(`${field}:\\s*(.+)`, 'i');
    const match = desc.match(regex);
    if (match) meta[field] = match[1].trim();
  }

  return meta;
}

module.exports = uploadToAdpiler;

