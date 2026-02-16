import { getDb, getOrdersCollectionName } from "./_mongo.js";
import { KEYS } from "./_keys.js";

function normalizeStatus(s) {
  return String(s || "").toUpperCase();
}

function looksPaid(status) {
  const s = normalizeStatus(status);
  return ["PAID", "SUCCESS", "SETTLED", "SETTLEMENT", "COMPLETED", "DONE", "BERHASIL", "LUNAS"].some(
    (k) => s.includes(k)
  );
}

function escapeHtml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function sendTelegram(chatId, text) {
  const token = (KEYS?.telegram?.botToken || "").trim();
  if (!token) throw new Error("Telegram botToken belum diisi di api/_keys.js");
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!r.ok) throw new Error(await r.text());
}

function makeReceiptHtml({ username, userId, productTitle, planLabel, amount, paidAt, orderId }) {
  const websiteUrl = (KEYS?.telegram?.websiteUrl || "").trim();
  const websiteLabel = websiteUrl ? websiteUrl.replace(/^https?:\/\//, "") : "Website pembelian kami";

  const u = escapeHtml(username);
  const p = escapeHtml(productTitle || "Produk");
  const pl = escapeHtml(planLabel || "");
  const a = escapeHtml(String(amount));
  const t = escapeHtml(paidAt);
  const oid = escapeHtml(orderId);

  return `
<b>📜 STRUK PEMBELIAN PRODUK</b>
<pre>━━━━━━━━━━━━━━━━━━━━━⨳</pre>

<b>🪪 IDENTITAS PEMBELI</b>
<pre>├ 👤 Nama   : ${u}
╰ 🆔 ID     : ${escapeHtml(userId)}</pre>

<b>🎀 DATA PRODUK</b>
<pre>├ 🛒 Produk : ${p}${pl ? "\n├ 📦 Paket  : " + pl : ""}
├ 💰 Harga  : Rp ${a}
╰ ⏰ Waktu  : ${t}</pre>

<pre>━━━━━━━━━━━━━━━━━━━━━⨳</pre>
<b>🔖 Order ID:</b> <code>${oid}</code>

<b>📨 Terimakasih Sudah Belanja Di:</b>
• Website pembelian kami
${websiteUrl ? `• Url: <a href="${escapeHtml(websiteUrl)}">${escapeHtml(websiteLabel)}</a>` : ""}
`;
}

function randomUserId() {
  return "USR-" + Math.random().toString(36).substring(2, 8).toUpperCase();
}

export default async function handler(req, res) {
  // Pakasir will POST here
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const payload = req.body || {};

    // Flexible parsing (Pakasir may nest data)
    const tx = payload.transaction || payload.data || payload;
    const orderId = tx.order_id || tx.orderId || payload.order_id || payload.orderId;
    const status = tx.status || tx.transaction_status || tx.state || payload.status;
    const amount = tx.amount || payload.amount;
    const completedAt = tx.completed_at || tx.paid_at || payload.completed_at || new Date().toISOString();

    if (!orderId) return res.status(200).send("NO_ORDER_ID");

    if (!looksPaid(status)) {
      return res.status(200).send("IGNORED");
    }

    const db = await getDb();
    const orders = db.collection(getOrdersCollectionName());

    const order = await orders.findOne({ order_id: String(orderId) });
    if (!order) {
      return res.status(200).send("ORDER_NOT_FOUND");
    }

    if (order.notified) {
      return res.status(200).send("ALREADY_NOTIFIED");
    }

    // Mark paid + lock notification
    await orders.updateOne(
      { order_id: String(orderId) },
      {
        $set: {
          status: "paid",
          paid_at: new Date(completedAt),
          notified: true,
          paid_amount: amount ? Number(amount) : undefined,
          paid_status: String(status),
        },
      }
    );

    const ownerChatId = (KEYS?.telegram?.ownerChatId || "").trim();
    const channelChatId = (KEYS?.telegram?.channelChatId || "").trim();
    if (!ownerChatId && !channelChatId) {
      return res.status(200).send("NO_TELEGRAM_TARGET");
    }

    const paidAtStr = new Date(completedAt).toLocaleString("id-ID");
    const receipt = makeReceiptHtml({
      username: order.username,
      userId: randomUserId(),
      productTitle: order.productTitle || order.productKey,
      planLabel: order.planLabel || order.planKey,
      amount: order.amount,
      paidAt: paidAtStr,
      orderId: String(orderId),
    });

    // Send to owner + channel
    if (ownerChatId) await sendTelegram(ownerChatId, receipt);
    if (channelChatId) await sendTelegram(channelChatId, receipt);

    return res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Webhook error", detail: err?.message || String(err) });
  }
}
