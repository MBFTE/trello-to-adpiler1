// server.js
const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const { uploadToAdpiler } = require('./upload-to-adpiler');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

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
    if (!cardId) {
      console.log("❌ No card ID provided.");
      return res.status(400).send("Card ID is missing.");
    }

    try {
      console.log("🚀 Uploading card ID:", cardId);
      await uploadToAdpiler(cardId);
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
  console.log("==> Your service is live 🎉");
  console.log("==> ");
  console.log("==> ///////////////////////////////////////////////////////////");
  console.log(`==> Available at your primary URL https://trello-to-adpiler.onrender.com`);
  console.log("==> ///////////////////////////////////////////////////////////");
});
