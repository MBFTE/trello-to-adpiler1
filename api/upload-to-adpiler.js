import fetch from 'node-fetch';
import csv from 'csvtojson';

export default async function handler(req, res) {
  if (req.method === 'HEAD') {
    // Trello webhook verification ping
    console.log('👋 Trello webhook verification (HEAD request)');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('📩 Webhook received from Trello');
  const body = req.body;
  console.log('Request Body:', JSON.stringify(body, null, 2));

  try {
    const action = body.action;
    const listName = action.data.listAfter?.name;

    console.log('📌 List moved to:', listName);
    if (listName !== 'Ready for AdPiler') return res.status(200).end();

    const cardId = action.data.card.id;
    console.log('🪪 Card ID:', cardId);

    // Get full card info
    const cardRes = await fetch(`https://api.trello.com/1/cards/${cardId}?attachments=true&customFieldItems=true&key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`);
    const card = await cardRes.json();
    console.log('📎 Full card response from Trello:', card);

    // Extract client name from title
    const cardTitle = card.name.toLowerCase();
    const clientName = cardTitle.split(':')[0].trim();
    console.log('👤 Client from card title:', clientName);

    // Load client ID mapping
    const csvUrl = process.env.CLIENT_SHEET_CSV;
    const csvData = await csv().fromStream((await fetch(csvUrl)).body);

    const clientMatch = csvData.find(
      row => row['Client'].toLowerCase().includes(clientName)
    );
    if (!clientMatch) {
      throw new Error(`Client not found for name: ${clientName}`);
    }

    const clientId = clientMatch['Client ID'];
    console.log('✅ Matched client ID:', clientId);

    // Upload all attachments to AdPiler
    for (const attachment of card.attachments) {
      const formData = new FormData();
      formData.append('name', attachment.name);
      formData.append('width', '1080');
      formData.append('height', '1080');
      formData.append('responsive_width', 'true');
      formData.append('responsive_height', 'true');
      formData.append('client_id', clientId);
      formData.append('file', await fetch(attachment.url).then(r => r.blob()), attachment.name);

      const response = await fetch('https://platform.adpiler.com/api/ads', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.ADPILER_API_KEY}`
        },
        body: formData
      });

      const result = await response.json();
      console.log('📤 AdPiler upload result:', result);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Upload handler error:', error);
    return res.status(500).json({ error: error.message });
  }
}
