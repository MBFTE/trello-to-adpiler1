// api/upload-to-adpiler.js
import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CLIENT_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz1UmGBfYraNSQilE6KWPOKKYhtuTeNqlOhUgtO8PcYLs2w05zzdtb7ovWSB2EMFQ1oLP0eDslFhSq/pub?output=csv';
const ADPILER_API_KEY = '11|8u3W1oxoMT0xYCGa91Q7HjznUYfEqODrhVShcXCj';

let clientIdMap = {};

// Fetch CSV of client names and IDs at server start
async function fetchClientIds() {
  const response = await fetch(CLIENT_CSV_URL);
  const csvText = await response.text();
  const lines = csvText.split('\n').slice(1);
  for (const line of lines) {
    const [client, id] = line.split(',');
    if (client && id) {
      clientIdMap[client.trim()] = id.trim();
    }
  }
}

await fetchClientIds();

app.post('/upload-to-adpiler', async (req, res) => {
  const cardName = req.body?.action?.data?.card?.name;
  if (!cardName) return res.status(400).send('Missing card name');

  const clientName = cardName.split(':')[0].trim();
  const clientId = clientIdMap[clientName];
  if (!clientId) return res.status(404).send(`Client ID not found for ${clientName}`);

  const form = new FormData();
  form.append('client_id', clientId);
  form.append('name', cardName);
  form.append('url', 'https://example.com/fake-ad-url.jpg'); // Replace with actual file URL

  const adpilerRes = await fetch('https://api.adpiler.com/v1/add-creative', {
    method: 'POST',
    headers: {
      'X-API-KEY': ADPILER_API_KEY
    },
    body: form
  });

  const responseText = await adpilerRes.text();
  console.log('AdPiler response:', responseText);
  res.status(200).send('Uploaded to AdPiler');
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
