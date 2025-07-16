import fetch from 'node-fetch';
import csv from 'csvtojson';

const GOOGLE_SHEET_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';

const ADPILER_API_KEY = '11|8u3W1oxoMT0xYCGa91Q7HjznUYfEqODrhVShcXCj';

const handler = async (req, res) => {
  try {
    const body = req.body;
    console.log('📩 Webhook received from Trello');
    console.log('📨 Request Body:', body);

    const card = body?.action?.data?.card;
    const cardTitle = card?.name || '';
    const clientName = cardTitle.split(':')[0].trim();

    console.log('📝 Card title:', cardTitle);
    console.log('👤 Client from card title:', clientName);

    // Fetch and parse Google Sheet
    const response = await fetch(GOOGLE_SHEET_CSV_URL);
    const rawCSV = await response.text();
    console.log('📄 Raw CSV:', rawCSV);

    const csvRows = await csv().fromString(rawCSV);

    const clientMap = {};
    csvRows.forEach((row) => {
      const trelloName = row['Trello Client Name']?.trim();
      const adpilerId = row['Adpiler Client ID']?.trim();
      if (trelloName && adpilerId) {
        clientMap[trelloName] = adpilerId;
      }
    });

    console.log('🧾 Client Map:', clientMap);

    const clientId = clientMap[clientName];
    console.log('✅ Matched client ID:', clientId);

    if (!clientId) {
      console.error('❌ No matching client ID found.');
      return res.status(400).json({ error: 'No matching client ID found' });
    }

    // Send creative to AdPiler (you can uncomment and customize this later)
    /*
    const adpilerResponse = await fetch('https://api.adpiler.com/v1/add-creative', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ADPILER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: clientId,
        title: cardTitle,
        // Add more fields here as needed
      })
    });

    if (!adpilerResponse.ok) {
      const errorText = await adpilerResponse.text();
      console.error('❌ Failed to upload creative to AdPiler:', errorText);
      return res.status(500).json({ error: 'Upload to AdPiler failed' });
    }

    const result = await adpilerResponse.json();
    */

    // Mock response until integration is finalized
    return res.status(200).json({
      success: true,
      message: 'Client ID matched and upload would be triggered',
      clientId
    });
  } catch (error) {
    console.error('🔥 Fatal error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export default handler;
