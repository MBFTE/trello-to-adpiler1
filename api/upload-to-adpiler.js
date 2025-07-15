export default async function handler(req, res) {
  if (req.method === 'GET') {
    // Trello sends a GET request to verify the webhook
    return res.status(200).send('Webhook verified');
  }

  if (req.method === 'POST') {
    console.log('📩 Webhook received from Trello');
    console.log('Request Body:', JSON.stringify(req.body, null, 2));

    // Optional: respond with a success message
    return res.status(200).send('Webhook processed');
  }

  // If it's neither GET nor POST, reject it
  res.status(405).send('Method Not Allowed');
}
