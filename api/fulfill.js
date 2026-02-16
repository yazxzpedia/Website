import axios from "axios";
import { KEYS } from "./_keys.js";

function normalizeStatus(s) {
  return String(s || "").toUpperCase();
}
function looksPaid(status) {
  const s = normalizeStatus(status);
  return ["PAID","SUCCESS","SETTLED","SETTLEMENT","COMPLETED","DONE","BERHASIL","LUNAS"].some(k => s.includes(k));
}

function vpsSizeSlug(planKey) {
  const map = {
    "vps-1c-2g": "s-1vcpu-2gb",
    "vps-2c-2g": "s-2vcpu-2gb",
    "vps-2c-4g": "s-2vcpu-4gb",
    "vps-4c-8g": "s-4vcpu-8gb",
    "vps-2c-8g": "s-2vcpu-8gb",
    "vps-4c-16g": "s-4vcpu-16gb",
    "vps-8c-16g": "s-8vcpu-16gb",
  };
  return map[planKey] || "";
}

function planToLimits(planKey) {
  // Conservative defaults; adjust later if you have exact policy.
  // Memory in MB, disk in MB, cpu as percentage (100 = 1 core).
  const m = {
    "panel-1gb": { memory: 1024, disk: 10240, cpu: 100 },
    "panel-2gb": { memory: 2048, disk: 20480, cpu: 150 },
    "panel-4gb": { memory: 4096, disk: 40960, cpu: 200 },
    "panel-8gb": { memory: 8192, disk: 81920, cpu: 300 },
    "panel-16gb": { memory: 16384, disk: 163840, cpu: 400 },
  };
  return m[planKey] || { memory: 1024, disk: 10240, cpu: 100 };
}

function pteroHeaders() {
  return {
    Authorization: `Bearer ${KEYS.pterodactyl.apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function pteroGet(path, params = {}) {
  const url = `${KEYS.pterodactyl.domain}${path}`;
  const r = await axios.get(url, { headers: pteroHeaders(), params, timeout: 20000 });
  return r.data;
}

async function pteroPost(path, body) {
  const url = `${KEYS.pterodactyl.domain}${path}`;
  const r = await axios.post(url, body, { headers: pteroHeaders(), timeout: 30000 });
  return r.data;
}

async function pteroPatch(path, body) {
  const url = `${KEYS.pterodactyl.domain}${path}`;
  const r = await axios.patch(url, body, { headers: pteroHeaders(), timeout: 30000 });
  return r.data;
}

function makeEmailFromUsername(username) {
  const u = String(username || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "");
  // Pterodactyl requires an email; we generate a deterministic-but-local one.
  return `${u || "user"}@chandra.cloud`;
}

function randomPassword(len = 14) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function findUserByUsername(username) {
  // Pterodactyl uses "username" field.
  const data = await pteroGet("/api/application/users", { "filter[username]": username, per_page: 50 });
  const items = data?.data || [];
  return items.length ? items[0] : null;
}

async function createUserIfMissing(username, { isAdmin = false } = {}) {
  const existing = await findUserByUsername(username);
  if (existing) return { user: existing, created: false };

  const password = randomPassword();
  const email = makeEmailFromUsername(username);

  // Pterodactyl requires first_name/last_name. We'll split from username.
  const first = String(username).slice(0, 16) || "User";
  const last = "Hirr";

  const createdUser = await pteroPost("/api/application/users", {
    email,
    username,
    first_name: first,
    last_name: last,
    language: "en",
    password,
    root_admin: !!isAdmin,
  });

  return { user: createdUser, created: true, password, email };
}

async function ensureAdminUser(username) {
  const { user, created, password, email } = await createUserIfMissing(username, { isAdmin: true });

  // If user exists but isn't admin, promote.
  const isRoot = !!(user?.attributes?.root_admin ?? user?.root_admin);
  const userId = user?.attributes?.id ?? user?.id;
  if (!isRoot && userId) {
    const updated = await pteroPatch(`/api/application/users/${userId}`, { root_admin: true });
    return { user: updated, created, promoted: true, password, email };
  }

  return { user, created, promoted: false, password, email };
}

async function getEggWithVariables() {
  // include=variables returns variables list. Some installations require nest path.
  const nestId = KEYS.pterodactyl.nestId;
  const eggId = KEYS.pterodactyl.egg;
  const data = await pteroGet(`/api/application/nests/${nestId}/eggs/${eggId}`, { include: "variables" });
  return data;
}

function buildEnvironmentFromEgg(eggData) {
  const env = {};
  const variables = eggData?.attributes?.relationships?.variables?.data || eggData?.relationships?.variables?.data || [];
  for (const v of variables) {
    const a = v?.attributes || v;
    const key = a?.env_variable;
    if (!key) continue;
    // Prefer default_value; if required & missing, set empty string and let API validate.
    env[key] = a?.default_value ?? "";
  }
  return env;
}

async function pickAllocationId() {
  const locationId = KEYS.pterodactyl.locationId;

  // 1) pick a node in that location
  const nodes = await pteroGet("/api/application/nodes", { "filter[location_id]": locationId, per_page: 50 });
  const nodeItems = nodes?.data || [];
  if (!nodeItems.length) throw new Error(`No nodes found for locationId=${locationId}`);

  const nodeId = nodeItems[0]?.attributes?.id;
  if (!nodeId) throw new Error("Failed to resolve nodeId");

  // 2) find an available allocation on the node
  const allocs = await pteroGet(`/api/application/nodes/${nodeId}/allocations`, { "filter[available]": 1, per_page: 50 });
  const allocItems = allocs?.data || [];
  if (!allocItems.length) throw new Error(`No available allocations on nodeId=${nodeId}`);

  const allocationId = allocItems[0]?.attributes?.id;
  if (!allocationId) throw new Error("Failed to resolve allocationId");

  return allocationId;
}

async function findExistingServerByOrder(orderId) {
  const data = await pteroGet("/api/application/servers", { "filter[query]": orderId, per_page: 50 });
  const items = data?.data || [];
  return items.length ? items[0] : null;
}

async function createPanelServer({ orderId, username, planKey }) {
  // Idempotency-ish: if already exists, return it.
  const existing = await findExistingServerByOrder(orderId);
  if (existing) return { server: existing, alreadyExisted: true };

  const { user, created, password, email } = await createUserIfMissing(username, { isAdmin: false });
  const userId = user?.attributes?.id ?? user?.id;
  if (!userId) throw new Error("Failed to resolve pterodactyl userId");

  const egg = await getEggWithVariables();
  const eggAttrs = egg?.attributes || {};
  const dockerImage = eggAttrs?.docker_image || "ghcr.io/pterodactyl/yolks:java_17";
  const startup = eggAttrs?.startup || "java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar server.jar";
  const environment = buildEnvironmentFromEgg(egg);

  const allocationId = await pickAllocationId();
  const limits = planToLimits(planKey);

  const serverName = `panel-${planKey}-${orderId}`.slice(0, 60);

  const payload = {
    name: serverName,
    user: userId,
    egg: KEYS.pterodactyl.egg,
    docker_image: dockerImage,
    startup,
    environment,
    limits: {
      memory: limits.memory,
      swap: 0,
      disk: limits.disk,
      io: 500,
      cpu: limits.cpu,
    },
    feature_limits: {
      databases: 0,
      allocations: 1,
      backups: 0,
    },
    allocation: {
      default: allocationId,
    },
    deploy: {
      locations: [KEYS.pterodactyl.locationId],
      dedicated_ip: false,
      port_range: [],
    },
    start_on_completion: true,
  };

  const createdServer = await pteroPost("/api/application/servers", payload);
  return {
    server: createdServer,
    alreadyExisted: false,
    userCreated: created,
    userEmail: email,
    userPassword: password, // only present if user created now
  };
}

/**
 * POST /api/fulfill
 * body: { orderId, amount, productKey, planKey, inputs?: { name?: string, hostname?: string } }
 *
 * - Verifies payment status via Pakasir transactiondetail
 * - If paid: fulfills the product
 *   - vps: creates a DigitalOcean droplet
 *   - panel: creates (or finds) user+server in Pterodactyl
 *   - admin: creates or promotes a Pterodactyl user to root_admin
 */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { orderId, amount, productKey, planKey, inputs } = req.body || {};
    if (!orderId || !amount || !productKey || !planKey) {
      return res.status(400).json({ error: "orderId, amount, productKey, planKey required" });
    }

    // 1) Verify payment with Pakasir
    const txr = await axios.get(`${KEYS.pakasir.baseUrl}/transactiondetail`, {
      params: {
        project: KEYS.pakasir.project,
        amount,
        order_id: orderId,
        api_key: KEYS.pakasir.apiKey,
      },
      timeout: 15000,
    });

    const tx = txr.data?.transaction || txr.data?.data || txr.data;
    const status = tx?.status || tx?.transaction_status || tx?.state || "UNKNOWN";
    if (!looksPaid(status)) {
      return res.status(402).json({ error: "Payment not confirmed", status, tx });
    }

    // 2) Fulfill based on product
    if (productKey === "vps") {
      const hostname = String(inputs?.hostname || "").trim();
      if (!hostname) return res.status(400).json({ error: "hostname required for VPS" });

      const size = vpsSizeSlug(planKey);
      if (!size) return res.status(400).json({ error: "Unknown VPS planKey", planKey });

      const dor = await axios.post(
        "https://api.digitalocean.com/v2/droplets",
        {
          name: hostname.toLowerCase(),
          region: KEYS.digitalocean.region,
          size,
          image: KEYS.digitalocean.image,
          tags: ["web-chandracloud", `order-${orderId}`],
        },
        {
          headers: {
            Authorization: `Bearer ${KEYS.digitalocean.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `order-${orderId}`,
          },
          timeout: 30000,
        }
      );

      const droplet = dor.data?.droplet || {};
      return res.status(200).json({
        ok: true,
        fulfillment: {
          type: "vps",
          dropletId: droplet?.id,
          name: droplet?.name,
          status: droplet?.status,
          createdAt: droplet?.created_at,
        },
        tx,
      });
    }

    if (productKey === "panel") {
      const username = String(inputs?.name || "").trim();
      if (!username) return res.status(400).json({ error: "username (name) required for panel" });

      const result = await createPanelServer({ orderId, username, planKey });
      const server = result?.server;
      const attrs = server?.attributes || server || {};
      return res.status(200).json({
        ok: true,
        fulfillment: {
          type: "panel",
          serverId: attrs?.id,
          uuid: attrs?.uuid,
          identifier: attrs?.identifier,
          name: attrs?.name,
          userCreated: !!result.userCreated,
          userEmail: result.userEmail,
          userPassword: result.userPassword, // only present if created now
          alreadyExisted: !!result.alreadyExisted,
        },
        tx,
      });
    }

    if (productKey === "admin") {
      const username = String(inputs?.name || "").trim();
      if (!username) return res.status(400).json({ error: "username (name) required for admin" });

      const result = await ensureAdminUser(username);
      const user = result?.user;
      const attrs = user?.attributes || user || {};
      return res.status(200).json({
        ok: true,
        fulfillment: {
          type: "admin",
          userId: attrs?.id,
          username: attrs?.username,
          email: attrs?.email,
          created: !!result.created,
          promoted: !!result.promoted,
          userPassword: result.password, // only returned if created now
        },
        tx,
      });
    }

    // reseller or unknown: keep manual
    const msgMap = {
      reseller: "Pembayaran terkonfirmasi. Silakan ambil link reseller (jika disediakan) atau tunggu admin mengirim link.",
    };

    return res.status(200).json({
      ok: true,
      fulfillment: {
        type: "manual",
        productKey,
        message: msgMap[productKey] || "Pembayaran terkonfirmasi. Silakan lanjutkan proses fulfillment.",
      },
      tx,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Fulfillment failed",
      detail: err?.response?.data || String(err),
    });
  }
}
