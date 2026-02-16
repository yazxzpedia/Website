import { getDb, getOrdersCollectionName } from "./_mongo.js";

function makeOrderId() {
  return `WH-${Date.now()}-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { username, productKey, productTitle, planKey, planLabel, amount, meta } = req.body || {};

    if (!username || !productKey || !planKey || !amount) {
      return res.status(400).json({ error: "username, productKey, planKey, amount required" });
    }

    const orderId = makeOrderId();

    const db = await getDb();
    const orders = db.collection(getOrdersCollectionName());

    await orders.insertOne({
      order_id: orderId,
      username: String(username).trim(),
      productKey,
      productTitle: productTitle || "",
      planKey,
      planLabel: planLabel || "",
      amount: Number(amount),
      meta: meta || {},
      status: "pending",
      notified: false,
      created_at: new Date(),
    });

    return res.status(200).json({ ok: true, orderId });
  } catch (err) {
    return res.status(500).json({ error: "Failed to create order", detail: err?.message || String(err) });
  }
}
