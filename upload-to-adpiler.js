const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');
const sharp = require('sharp');

const ADPILER_API_KEY = process.env.ADPILER_API_KEY;
const ADPILER_BASE_URL = process.env.ADPILER_BASE_URL;
const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;

const CLIENT_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';

async function getClientMapping(cardName) {
  const response = await fetch(CLIENT_CSV_URL);
  const csvText = await response.text();
  const clients = await csv().fromString(csvText);
  const match = clients.find(c =>
    cardName.toLowerCase().startsWith((c['Trello Client Name'] || '').toLowerCase())
  );
  return match ? {
    clientId: match['Adpiler Client ID'],
    campaignId: match['Adpiler Campaign ID']
  } : null;
}

function extractLabelMetadata(labels) {
  const labelNames = labels.map(label => label.name?.toLowerCase() || '');
  if (labelNames.includes('social')) {
    return { type: 'post', network: 'facebook' };
  }
  if (labelNames.includes('display')) {
    return {}; // Future expansion
  }
  return null;
}

async function getCardDetails(cardId) {
  const fieldsUrl = `https://api.trello.com/1/cards/${cardId}?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}&fields=name,desc,url`;
  const fieldsRes = await fetch(fieldsUrl);
  if (!fieldsRes.ok) throw new Error('Failed to fetch card fields');
  const card = await fieldsRes.json();

  const labelUrl = `https://api.trello.com/1/cards/${cardId}/labels?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const labelRes = await fetch(labelUrl);
  card.labels = labelRes.ok ? await labelRes.json() : [];

  return card;
}

async function uploadToAdpiler(card, attachments, logoPath = null) {
  try {
    const mapping = await getClientMapping(card.name);
    if (!mapping) throw new Error(`No matching client for card: ${card.name}`);

    const cardDetails = await getCardDetails(card.id);
    const labelMeta = extractLabelMetadata(cardDetails.labels || []);
    if (!labelMeta) throw new Error(`Card "${card.name}" missing required labels.`);

    const metadata = {
      primaryText: cardDetails.desc || '',
      headline: cardDetails.name || '',
      description: cardDetails.desc || '',
      callToAction: 'Learn More',
      clickthroughUrl: cardDetails.url || ''
    };

    const isCarousel = card.name.toLowerCase().includes('carousel');
    const uploadUrl = `${ADPILER_BASE_URL}/campaigns/${mapping.campaignId}/social-ads`;

    const sortedAttachments = attachments.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    );

    const form = new FormData();
    form.append('client_id', mapping.clientId);
    form.append('name', card.name);
    form.append('page_name', 'Adpiler');
    form.append('message', metadata.primaryText);
    if (labelMeta.type) form.append('type', labelMeta.type);
    if (labelMeta.network) form.append('network', labelMeta.network);
    form.append('headline', metadata.headline);
    form.append('description', metadata.description);
    form.append('cta', metadata.callToAction);
    form.append('clickthrough_url', metadata.clickthroughUrl);
    if (logoPath) form.append('logo', fs.createReadStream(path.resolve(logoPath)));

    for (const att of sortedAttachments) {
      console.log(`📥 Fetching image: ${att.name}`);
      const imageRes = await fetch(`${att.url}?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`);
      if (!imageRes.ok) throw new Error(`Failed to fetch attachment: ${att.url}`);
      const buffer = await imageRes.buffer();
      att.buffer = buffer;
    }

    if (isCarousel && sortedAttachments.length > 1) {
      console.log('🎠 Uploading as Carousel Ad');
      sortedAttachments.forEach(att => {
        form.append('slides[]', att.buffer, att.name);
      });
    } else {
      console.log('🖼️ Uploading as Regular Social Ad');
      form.append('image', sortedAttachments[0].buffer, sortedAttachments[0].name);
    }

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADPILER_API_KEY}`,
        ...form.getHeaders()
      },
      body: form
    });

    const contentType = response.headers.get('content-type');
    const result = contentType?.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      console.error(`❌ Upload failed:`, result);
    } else {
      console.log(`✅ Upload successful! Ad created:`, result);
    }

  } catch (err) {
    console.error(`🚨 Upload error: ${err.message}`);
  }
}

module.exports = { uploadToAdpiler };

