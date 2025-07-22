const express = require('express');
const bodyParser = require('body-parser');
const uploadToAdpiler = require('./upload-to-adpiler');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  const action = req.body.action;
  if (!action || action.type !== 'updateCard' || !action.data?.listAfter?.name) {
    return res.status(200).send('No relevant action');
  }

  const newListName = action.data.listAfter.name;
  if (newListName !== process.env.TARGET_LIST_NAME) {
    return res.status(200).send('Not the target list');
  }

  const cardId = action.data.card.id;
  try {
    await uploadToAdpiler(cardId, {
      TRELLO_KEY: process.env.TRELLO_API_KEY,
      TRELLO_TOKEN: process.env.TRELLO_TOKEN,
      ADPILER_API_KEY: process.env.ADPILER_API_KEY,
      CLIENT_LOOKUP_CSV_URL: process.env.CLIENT_SHEET_CSV,
    });
    res.status(200).send('Card processed');
  } catch (err) {
    console.error(`❌ Error uploading to AdPiler:`, err.message);
    res.status(500).send('Upload failed');
  }
});

app.head('/webhook', (req, res) => {
  console.log('✅ Trello HEAD verification request received');
  res.status(200).end();
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
