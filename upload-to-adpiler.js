const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');

const ADPILER_API_KEY = process.env.ADPILER_API_KEY;
const ADPILER_BASE_URL = process.env.ADPILER_BASE_URL;
const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;

const CLIENT_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';

async function getClientMapping(cardName) {
  const response = await fetch(CLIENT_CSV_URL);
  const csvText = await response.text();
  const clients = await csv().fromString(csvText);

  const match = clients.find(c =>
    cardName.toLowerCase().startsWith((c['Trello Client Name'] || '').toLowerCase())
  );

  if (!match) return null;

  return {
    clientId: match['Adpiler Client ID'],
    campaignId: match['Adpiler Campaign ID']
  };
}

function extractLabelMetadata(labels) {
  const labelNames = labels.map(label => label.name?.toLowerCase() || '');
  console.log('🧪 Labels received:', labelNames);

  if (labelNames.includes('social')) {
    return { type: 'post', network: 'facebook' };
  }

  if (labelNames.includes('display')) {
    return {}; // Display doesn't need type/network
  }

  return null;
}

async function getCardDetails(cardId) {
  const baseUrl = `https://api.trello.com/1/cards/${cardId}?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}&fields=name,desc,url`;
  const baseResponse = await fetch(baseUrl);
  if (!baseResponse.ok) throw new Error('Failed to fetch card fields');
  const card = await baseResponse.json();

  const labelUrl = `https://api.trello.com/1/cards/${cardId}/labels?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const labelRes = await fetch(labelUrl);
  card.labels = labelRes.ok ? await labelRes.json() : [];

  return card;
}

async function uploadToAdpiler(card, attachments) {
  try {
    const mapping = await getClientMapping(card.name);
    if (!mapping) throw new Error(`No matching entry found for card: ${card.name}`);

    console.log(`🎯 AdPiler Client ID: ${mapping.clientId}`);
    console.log(`🚀 AdPiler Campaign ID: ${mapping.campaignId}`);

    const cardDetails = await getCardDetails(card.id);
    const labelMeta = extractLabelMetadata(cardDetails.labels || []);
    if (!labelMeta) throw new Error(`Card "${card.name}" missing 'Social' or 'Display' label.`);

    const metadata = {
      primaryText: cardDetails.desc || '',
      headline: cardDetails.name || '',
      description: cardDetails.desc || '',
      callToAction: 'Learn More',
      clickthroughUrl: cardDetails.url || ''
    };

    for (const attachment of attachments) {
      console.log(`📥 Fetching image: ${attachment.name}`);
      const imageResponse = await fetch(
        `${attachment.url}?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
      );
      if (!imageResponse.ok) throw new Error(`Failed to fetch attachment: ${attachment.url}`);

      const buffer = await imageResponse.buffer();
      console.log(`🧪 Image buffer size: ${buffer.length}`);

      const form = new FormData();
      form.append('client_id', mapping.clientId);
      form.append('name', attachment.name);
      form.append('image', buffer, attachment.name);

      if (labelMeta.type) form.append('type', labelMeta.type);
      if (labelMeta.network) form.append('network', labelMeta.network);

      form.append('primary_text', metadata.primaryText);
      form.append('headline', metadata.headline);
      form.append('description', metadata.description);
      form.append('cta', metadata.callToAction);
      form.append('clickthrough_url', metadata.clickthroughUrl);

      const uploadUrl = `${ADPILER_BASE_URL}/campaigns/${mapping.campaignId}/social-ads`;
      console.log(`📤 Uploading to AdPiler (campaign ${mapping.campaignId})...`);

      const uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ADPILER_API_KEY}`,
          ...form.getHeaders()
        },
        body: form
      });

      const contentType = uploadResponse.headers.get('content-type');
      const result = contentType?.includes('application/json')
        ? await uploadResponse.json()
        : await uploadResponse.text();

      if (!uploadResponse.ok) {
        console.error(`❌ Upload failed:`, result);
      } else {
        console.log(`✅ Uploaded slide: ${attachment.name}`);
      }
    }
  } catch (err) {
    console.error(`❌ Upload error: ${err.message}`);
  }
}

module.exports = { uploadToAdpiler };
