require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const uploadToAdpiler = require('./upload-to-adpiler');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  const action = req.body?.action;
  const listName = process.env.TARGET_LIST_NAME || 'Ready for AdPiler';

  // Debug logs
  if (!action || !action.type || !action.data?.card) {
    console.log('⚠️ Webhook ignored: missing or malformed action');
    return res.status(200).send('Ignored');
  }

  const cardId = action.data.card.id;
  const destination = action.data?.listAfter?.name || '';
  const type = action.type;

  console.log(`📩 Webhook received: type=${type}, to="${destination}"`);

  if (
    type === 'updateCard' &&
    destination.toLowerCase() === listName.toLowerCase()
  ) {
    try {
      await uploadToAdpiler(cardId, {
        TRELLO_KEY: process.env.TRELLO_API_KEY,
        TRELLO_TOKEN: process.env.TRELLO_TOKEN,
        ADPILER_API_KEY: process.env.ADPILER_API_KEY,
        CLIENT_LOOKUP_CSV_URL: process.env.CLIENT_SHEET_CSV
      });
      res.status(200).send('Upload triggered');
    } catch (err) {
      console.error('❌ Upload failed:', err.message || err);
      res.status(500).send('Upload failed');
    }
  } else {
    res.status(200).send('No relevant action');
  }
});

app.get('/', (req, res) => {
  res.send('✅ Trello → AdPiler webhook is running');
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  console.log('==> Your service is live 🎉');
  console.log('==> ');
  console.log('==> ///////////////////////////////////////////////////////////');
  console.log(`==> Available at your primary URL https://trello-to-adpiler.onrender.com`);
  console.log('==> ///////////////////////////////////////////////////////////');
});


app.head('/webhook', (req, res) => {
  console.log('✅ Trello HEAD verification request received');
  res.status(200).end();
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
