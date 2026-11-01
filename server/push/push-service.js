/*
This module is the server's Web Push fan-out. It owns three concerns that the
signaling layer leans on but should not implement itself:

  1. VAPID identity — a stable public/private keypair that authenticates this
     server to the browser push services (FCM / Mozilla / APNs). Keys are read
     from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) when provided, otherwise
     generated once and cached to a gitignored file so restarts keep the same
     identity (a changed public key would invalidate every existing browser
     subscription).

  2. Subscription storage — a userId -> Map<endpoint, subscription> registry.
     A user may be subscribed from several devices; we keep them keyed by the
     push endpoint so re-subscribing the same device replaces rather than
     duplicates. In-memory only, mirroring the envelope store: clients re-send
     their subscription on every reconnect, so a restart self-heals.

  3. Delivery — sendToUser() pushes a small JSON payload to every device of a
     user. The payload carries only routing data plus an *already-encrypted*
     notification hint (ciphertext the sender produced for the recipient); this
     server never sees the plaintext. Stale subscriptions (404/410) are pruned.

The actual notification text is decrypted inside the recipient's service
worker. See app/sw.js and design/tip-5-os-notifications.html.
*/

const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

const VAPID_FILE = path.join(__dirname, ".vapid.json");
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:push@tally.earth";
const PER_USER_SUBSCRIPTION_LIMIT = 20;

// Resolve a VAPID keypair: prefer env vars (production), then a cached file,
// then generate-and-cache. Generating is cheap but must happen at most once so
// the public key the clients subscribed with stays valid across restarts.
const loadVapidKeys = () => {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
  }

  try {
    const cached = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8"));
    if (cached.publicKey && cached.privateKey) {
      return cached;
    }
  } catch {
    // No cached keys yet — fall through to generation.
  }

  const generated = webpush.generateVAPIDKeys();
  try {
    fs.writeFileSync(VAPID_FILE, JSON.stringify(generated, null, 2));
  } catch (error) {
    console.warn("[push] could not persist VAPID keys:", error?.message || error);
  }
  return generated;
};

const createPushService = () => {
  const vapidKeys = loadVapidKeys();
  webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);

  // userId -> Map<endpoint, subscription>
  const subscriptionsByUser = new Map();

  const isValidSubscription = (subscription) =>
    Boolean(subscription) &&
    typeof subscription === "object" &&
    typeof subscription.endpoint === "string" &&
    subscription.endpoint.length > 0 &&
    subscription.keys &&
    typeof subscription.keys.p256dh === "string" &&
    typeof subscription.keys.auth === "string";

  const addSubscription = (userId, subscription) => {
    if (!userId || !isValidSubscription(subscription)) {
      return;
    }
    let byEndpoint = subscriptionsByUser.get(userId);
    if (!byEndpoint) {
      byEndpoint = new Map();
      subscriptionsByUser.set(userId, byEndpoint);
    }
    // Re-subscribing the same device replaces the prior record for its endpoint.
    if (!byEndpoint.has(subscription.endpoint) && byEndpoint.size >= PER_USER_SUBSCRIPTION_LIMIT) {
      const oldestKey = byEndpoint.keys().next().value;
      if (oldestKey) byEndpoint.delete(oldestKey);
    }
    byEndpoint.set(subscription.endpoint, subscription);
  };

  const removeSubscription = (userId, endpoint) => {
    if (!userId || !endpoint) return;
    const byEndpoint = subscriptionsByUser.get(userId);
    if (!byEndpoint) return;
    byEndpoint.delete(endpoint);
    if (byEndpoint.size === 0) {
      subscriptionsByUser.delete(userId);
    }
  };

  // Push a payload to every device of a user. Returns the number of devices
  // the push service accepted the message for. Prunes subscriptions the push
  // service reports as gone (404/410) so dead endpoints don't accumulate.
  const sendToUser = async (userId, payload) => {
    const byEndpoint = subscriptionsByUser.get(userId);
    if (!byEndpoint || byEndpoint.size === 0) {
      return 0;
    }

    const body = JSON.stringify(payload);
    let deliveredCount = 0;

    await Promise.all(
      Array.from(byEndpoint.values()).map(async (subscription) => {
        try {
          await webpush.sendNotification(subscription, body);
          deliveredCount += 1;
        } catch (error) {
          const statusCode = error?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            removeSubscription(userId, subscription.endpoint);
          } else {
            console.warn("[push] send failed:", statusCode || error?.message || error);
          }
        }
      })
    );

    return deliveredCount;
  };

  return {
    publicKey: vapidKeys.publicKey,
    addSubscription,
    removeSubscription,
    sendToUser,
  };
};

module.exports = { createPushService };
