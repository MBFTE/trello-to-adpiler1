import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

// ✅ Trello webhook verification (GET request)
app.get('/api/upload-to-adpiler', (req, res) => {
  res.status(200).send('OK');
});

// ✅ Main webhook handler (POST request)
app.post('/api/upload-to-adpiler', async (req, res) => {
  console.log('📩 Webhook received from Trello:', JSON.stringify(req.body));

  // Optional: Only act if a card was moved to a specific list
  try {
    const action = req.body.action;
    const card = action.data.card;
    const list = action.data.listAfter?.name || 'Unknown list';

    if (list === 'Ready For AdPiler') {
      // 👉 Replace with your AdPiler upload logic here
      const adpilerResponse = await fetch('https://api.adpiler.com/upload', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer YOUR_ADPILER_TOKEN',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: card.name,
          description: card.desc,
          // Add any fields you want to pass
        }),
      });

      const result = await adpilerResponse.json();
      console.log('✅ AdPiler response:', result);
    }

    res.status(200).send('Trello webhook processed');
  } catch (err) {
    console.error('❌ Error handling webhook:', err);
    res.status(500).send('Error');
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
