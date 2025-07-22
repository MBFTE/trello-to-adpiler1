const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());

// Health check route
app.get('/', (req, res) => {
  res.send('🚀 Trello to AdPiler webhook is live');
});

// Trello webhook verification (HEAD)
app.head('/webhook', (req, res) => {
  console.log('✅ Trello HEAD verification request received');
  res.sendStatus(200);
});

// Trello webhook listener (POST)
app.post('/webhook', (req, res) => {
  const action = req.body.action;
  console.log('📬 Webhook triggered from Trello');
  console.log(JSON.stringify(action, null, 2));

  // Basic example: detect movement into "Ready For Adpiler"
  if (
    action &&
    action.type === 'updateCard' &&
    action.data &&
    action.data.listAfter &&
    action.data.listAfter.name === 'Ready For Adpiler'
  ) {
    const cardId = action.data.card.id;
    const cardName = action.data.card.name;
    console.log(`🎯 Card "${cardName}" moved to Ready For Adpiler (ID: ${cardId})`);

    // 🔁 Insert your AdPiler API call here
    // uploadToAdpiler(cardId, cardName); // You'll define this later
  }

  res.sendStatus(200);
});

// Start the server
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
