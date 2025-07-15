import csv from 'csvtojson';

const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1c1V-8rdHtn3sWihB0cWRgPG3OhuqjtpymzjdguEsvs4/export?format=csv';

export const config = {
  api: {
    bodyParser: false,
  },
};

// Parse raw body as buffer
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = [];
    req
      .on('data', chunk => data.push(chunk))
      .on('end', () => resolve(Buffer.concat(data).toString()))
      .on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method === 'HEAD') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    console.log('📩 Webhook received from Trello');
    const rawBody = await getRawBody(req);
    const webhookPayload = JSON.parse(rawBody);
    console.log('📨 Request Body:', webhookPayload);

    const action = webhookPayload?.action;
    const listName = action?.data?.listAfter?.name;
    if (listName !== 'Ready for AdPiler') {
      console.log('🚫 Card not moved to Ready for AdPiler — skipping');
      return res.status(200).json({ message: 'Not a Ready for AdPiler event' });
    }

    const cardId = action?.data?.card?.id;
    const cardTitle = action?.data?.card?.name;
    console.log('📌 List moved to:', listName);
    console.log('🪪 Card ID:', cardId);
    console.log('📝 Card title:', cardTitle);

    const clientName = (cardTitle.split(':')[0] || '').trim().toLowerCase();
    console.log('👤 Client from card title:', clientName);

    const response = await fetch(SHEET_CSV_URL);
    const csvText = await response.text();
    const rows = await csv().fromString(csvText);

    const clientMatch = rows.find((row) => {
      const name = row['Trello Client Name'];
      return name && name.toLowerCase().includes(clientName);
    });

    if (!clientMatch) {
      console.error('❌ No match found in CSV for client:', clientName);
      return res.status(200).json({ error: 'Client match not found in CSV' });
    }

    const adpilerClientId = clientMatch['AdPiler Client ID'];
    console.log('✅ Matched client ID:', adpilerClientId);

    const cardResp = await fetch(`https://api.trello.com/1/cards/${cardId}?attachments=true&customFieldItems=true&checklists=all&fields=all&key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`);
    const card = await cardResp.json();
    console.log('📎 Full card response from Trello:', card);

    const attachments = card.attachments?.filter(att => att.isUpload) || [];
    const adAssets = attachments.map(att => ({
      fileUrl: att.url,
      fileName: att.name,
    }));

    const buildBoxLink = (card.desc.match(/\*\*Final Build Box Link:\*\*\s*\n\n(.*)/) || [])[1] || '';
    const folderMatch = (card.desc.match(/\*\*Folder:\s*(.*?)\*\*/) || [])[1] || '';

    const uploadPayload = {
      client_id: adpilerClientId,
      folder: folderMatch || 'Unknown Folder',
      files: adAssets,
      notes: card.desc,
      build_link: buildBoxLink,
      card_url: card.url,
    };

    console.log('⬆️ Uploading to AdPiler:', uploadPayload);

    const response = await fetch('https://api.adpiler.com/v1/upload-files', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-KEY': process.env.ADPILER_API_KEY
  },
  body: JSON.stringify({
    client_id,
    folder,
    files,
    notes,
    build_link,
    card_url
  })
});

    const adpilerResult = await adpilerResp.json();
    console.log('✅ Upload to AdPiler successful!', adpilerResult);

    return res.status(200).json({ success: true, result: adpilerResult });

  } catch (err) {
    console.error('❌ Upload handler error:', err);
    return res.status(500).json({ error: 'Something went wrong', details: err.message });
  }
}
