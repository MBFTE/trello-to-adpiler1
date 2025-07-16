import express from 'express';
import fetch from 'node-fetch';
import csv from 'csvtojson';

const app = express();
app.use(express.json());

app.post('/api/upload-to-adpiler', async (req, res) => {
  console.log('📩 Trello webhook hit!');
  console.log('🧾 Payload:', JSON.stringify(req.body, null, 2));
  res.status(200).send('Webhook received!');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
