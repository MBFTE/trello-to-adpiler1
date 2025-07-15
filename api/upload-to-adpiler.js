export default function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).send("Trello webhook verified ✅");
  }

  if (req.method === "POST") {
    console.log("✅ Webhook payload:", req.body);
    return res.status(200).send("Webhook received");
  }

  res.status(405).send("Method Not Allowed");
}
