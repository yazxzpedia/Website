import { MongoClient } from "mongodb";
import { KEYS } from "./_keys.js";

// MongoDB connection helper for Vercel Functions (caches across invocations)

function getUri() {
  const uri = (KEYS?.mongodb?.uri || "").trim();
  if (!uri) {
    throw new Error(
      "MongoDB URI belum diisi. Isi di api/_keys.js -> KEYS.mongodb.uri (backend only)."
    );
  }
  return uri;
}

if (!globalThis.__ndraacloudMongoClientPromise) {
  const client = new MongoClient(getUri(), {
    // Vercel functions are short-lived; keep defaults.
  });
  globalThis.__ndraacloudMongoClientPromise = client.connect();
}

export async function getDb() {
  const client = await globalThis.__ndraacloudMongoClientPromise;
  const dbName = (KEYS?.mongodb?.dbName || "shop").trim();
  return client.db(dbName);
}

export function getOrdersCollectionName() {
  return (KEYS?.mongodb?.ordersCollection || "orders").trim();
}
