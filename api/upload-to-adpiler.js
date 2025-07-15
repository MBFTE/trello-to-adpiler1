const fetch = require('node-fetch');
const csv = require('csvtojson');

const GOOGLE_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const ADPILER_API_KEY = '11|8u3W1oxoMT0xYCGa91Q7HjznUYfEqODrhVShcXCj';

module.exports = async (req, res) => {
  try {
    const body = req.body;
    console.log('📩 Webhook received from Trello');
    console.log('📨 Request Body:', body);

    const card = body?.action?.data?.card;
    const cardTitle = card?.name || '';
    const clientName = cardTitle.split(':')[0].trim();

    console.log('📝 Card title:', cardTitle);
    console.log('👤 Client from card title:', clientName);

    const response = await fetch(GOOGLE_SHEET_CSV_URL);
    const rawCSV = await response.text();
    console.log('📄 Raw CSV:', rawCSV);

    const csvRows = await csv().fromString(rawCSV);

    const clientMap = {};
    csvRows.forEach(row => {
      if (row['Trello Client Name'] && row['Adpiler Client ID']) {
        clientMap[row['Trello Client Name'].trim()] = row['Adpiler Client ID'].trim();
      }
    });

    console.log('🧾 Client Map:', clientMap);

    const clientId = clientMap[clientName];
    console.log('✅ Matched client ID:', clientId);

    if (!clientId) {
      console.error('❌ No matching client ID found.');
      return res.status(400).json({ error: 'No matching client ID' });
    }

    // Placeholder for AdPiler API
    console.log('🚀 Pretending to send creative to AdPiler...');

    return res.status(200).json({ success: true, clientId });
  } catch (err) {
    console.error('🔥 Fatal error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};
