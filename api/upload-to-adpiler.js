export default async function handler(req, res) {
  if (req.method === 'HEAD') {
    // Trello sends HEAD to verify the webhook
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    // Optional: sometimes Trello also sends a GET
    return res.status(200).send('Webhook verified');
  }

  if (req.method === 'POST') {
    console.log('📩 Webhook received from Trello');
    console.log('Request Body:', JSON.stringify(req.body, null, 2));

    // You can put your real webhook logic here later

    return res.status(200).send('Webhook processed');
  }

  // Any other method gets blocked
  res.status(405).send('Method Not Allowed');
}
