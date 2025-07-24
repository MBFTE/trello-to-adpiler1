const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const fetch = require('node-fetch');
const { uploadToAdpiler } = require('./upload-to-adpiler');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

async function getCardAttachments(cardId) {
  const url = `https://api.trello.com/1/cards/${cardId}/attachments?key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("Failed to fetch attachments");
  return await response.json();
}

app.post('/webhook', async (req, res) => {
  const action = req.body.action;
  if (!action) {
    console.log("⚠️ No action in webhook payload.");
    return res.status(400).send("No action found.");
  }

  const type = action.type || '';
  const card = action.data?.card;
  const listAfter = action.data?.listAfter?.name || '';
  const cardId = card?.id;

  console.log("📩 Webhook received: type=" + type + ", to=\"" + listAfter + "\"");

  if (type === "updateCard" && listAfter === "Ready for Adpiler") {
    if (!cardId || !card) {
      console.log("❌ Missing card data.");
      return res.status(400).send("Card info is incomplete.");
    }

    try {
      console.log("🚀 Uploading card ID:", cardId);
      const attachments = await getCardAttachments(cardId);
      await uploadToAdpiler(card, attachments);
      res.status(200).send("Upload attempted.");
    } catch (err) {
      console.error("❌ Upload failed:", err.message || err);
      res.status(500).send("Upload failed: " + (err.message || err));
    }
  } else {
    res.status(200).send("Ignored.");
  }
});

app.get('/', (req, res) => {
  res.send('✅ Trello to AdPiler webhook server is running!');
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

