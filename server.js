const express = require('express');
const bodyParser = require('body-parser');
const uploadToAdpiler = require('./upload-to-adpiler');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const ADPILER_API_KEY = process.env.ADPILER_API_KEY;
const CLIENT_LOOKUP_CSV_URL = process.env.CLIENT_LOOKUP_CSV_URL;

app.head('/webhook', (req, res) => {
  console.log('✅ Trello HEAD verification request received');
  res.sendStatus(200);
});

app.post('/webhook', async (req, res) => {
  const action = req.body.action;

  if (
    action &&
    action.type === 'updateCard' &&
    action.data?.listAfter?.name === 'Ready For Adpiler'
  ) {
    const cardId = action.data.card.id;
    try {
      await uploadToAdpiler(cardId, {
        TRELLO_KEY,
        TRELLO_TOKEN,
        ADPILER_API_KEY,
        CLIENT_LOOKUP_CSV_URL
      });
    } catch (err) {
      console.error(`❌ Error uploading to AdPiler:`, err.message);
    }
  }

  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('🚀 Trello to AdPiler webhook is live');
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
