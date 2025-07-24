const fetch = require('node-fetch');
const FormData = require('form-data');
const csv = require('csvtojson');

const ADPILER_API_KEY = process.env.ADPILER_API_KEY;
const ADPILER_BASE_URL = process.env.ADPILER_BASE_URL;
const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;

const CLIENT_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv";

async function getClientMapping(cardName) {
  const response = await fetch(CLIENT_CSV_URL);
  const csvText = await response.text();
  const clients = await csv().fromString(csvText);

  const match = clients.find(c =>
    cardName.toLowerCase().startsWith((c["Trello Client Name"] || "").toLowerCase())
  );

  if (!match) return null;

  return {
    clientId: match["Adpiler Client ID"],
    folderId: match["Adpiler Folder ID"]
  };
}

async function getCardDetails(cardId) {
  const url = `https://api.trello.com/1/cards/${cardId}?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}&fields=name,desc,url`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("Failed to fetch card details");
  return await response.json();
}

async function uploadToAdpiler(card, attachments) {
  try {
    const mapping = await getClientMapping(card.name);
    if (!mapping) throw new Error(`No matching entry found for card: ${card.name}`);

    console.log(`🎯 AdPiler Client ID: ${mapping.clientId}`);
    console.log(`📁 AdPiler Folder ID (Campaign ID): ${mapping.folderId}`);

    const cardDetails = await getCardDetails(card.id);

    const metadata = {
      primaryText: cardDetails.desc || "",             // Treat description as caption
      headline: cardDetails.name || "",
      clickthroughUrl: cardDetails.url || "",
      callToAction: "Learn More",                      // Placeholder CTA
      description: cardDetails.desc || ""
    };

    for (let attachment of attachments) {
      console.log(`📥 Fetching image: ${attachment.name}`);
      const response = await fetch(`${attachment.url}?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`);
      if (!response.ok) throw new Error(`Failed to fetch attachment: ${attachment.url}`);

      const buffer = await response.buffer();

      const form = new FormData();
      form.append('client_id', mapping.clientId);
      form.append('name', attachment.name);
      form.append('image', buffer, attachment.name);

      // AdPiler campaign-specific path
      const uploadUrl = `${ADPILER_BASE_URL}/campaigns/${mapping.folderId}/social-ads`;

      // Attach metadata
      form.append('primary_text', metadata.primaryText);
      form.append('headline', metadata.headline);
      form.append('description', metadata.description);
      form.append('cta', metadata.callToAction);
      form.append('clickthrough_url', metadata.clickthroughUrl);

      console.log(`📤 Uploading to AdPiler...`);
      const uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ADPILER_API_KEY}`,
          ...form.getHeaders()
        },
        body: form
      });

      const contentType = uploadResponse.headers.get("content-type");
      const result = contentType?.includes("application/json")
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

