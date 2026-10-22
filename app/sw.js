/*
Tally service worker — gives the app an installable, offline-capable shell.

Strategy: precache + cache-first. At build time scripts/build-client.cjs writes
dist/precache-manifest.js, listing every static asset (templates, styles, built
JS, vendor libs, icons) tagged with a content hash plus a combined version hash.
This worker pulls that list in via importScripts and, on install, fetches every
asset fresh into a versioned cache. Once activated it serves those assets from
the cache, so the app boots instantly and works with no network.

Updates: because precache-manifest.js changes bytes whenever any cached file
changes, the browser's byte-for-byte worker comparison detects an update and
installs the new worker in the "waiting" state. It does NOT auto-activate — the
page keeps running the old version until the user accepts the update (the app
posts a SKIP_WAITING message), so a refresh never happens mid-interaction. This
is the worker's own content-hash versioning, separate from data/version.json
(which gates data-model migrations).
@category entry
*/

importScripts("dist/precache-manifest.js");
// secp256k1 decrypt for Web Push hints (NIP-44, with the legacy AES-GCM path
// kept to drain old hints). Bundled separately because the SW is a classic
// worker and WebCrypto can't do secp256k1.
importScripts("dist/sw-crypto.js");

const VERSION = self.__PRECACHE_VERSION || "dev";
const CACHE_NAME = `tally-precache-${VERSION}`;
const PRECACHE = Array.isArray(self.__PRECACHE) ? self.__PRECACHE : [];

// Absolute URLs (origin + path, no query/hash) of everything we precache, used
// to decide in the fetch handler whether a request can be served from cache.
const toAbsolute = (url) => new URL(url, self.location.href).href;
const PRECACHED_URLS = new Set(PRECACHE.map((entry) => toAbsolute(entry.url)));
const INDEX_URL = toAbsolute("index.html");
const WEB_SITE_URL = toAbsolute("web/");

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Fetch each asset bypassing the HTTP cache so the install always grabs
      // the freshly deployed bytes. Done individually so one bad URL cannot
      // abort the whole precache (cache.addAll is all-or-nothing).
      await Promise.all(
        PRECACHE.map(async (entry) => {
          try {
            const request = new Request(toAbsolute(entry.url), { cache: "reload" });
            const response = await fetch(request);
            if (response.ok) await cache.put(toAbsolute(entry.url), response.clone());
          } catch {
            // A single asset failing to precache should not fail the install;
            // the fetch handler falls back to the network for it at runtime.
          }
        }),
      );
      // Stay in "waiting" — the app decides when to apply the update.
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("tally-precache-") && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

// The app posts this when the user accepts an update; we activate immediately so
// the next controllerchange can reload the page onto the new version.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

const cacheFirst = async (cacheKey, request) => {
  const cached = await caches.match(cacheKey);
  if (cached) return cached;
  return fetch(request);
};

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin go to network

  const normalized = url.origin + url.pathname;

  if (PRECACHED_URLS.has(normalized)) {
    event.respondWith(cacheFirst(normalized, request));
    return;
  }

  // App-shell fallback: any in-scope navigation (e.g. "/") serves index.html —
  // except the landing site and its Design docs. On the public domains those are
  // a separate origin, but locally server/server.js mounts them under /web on the
  // app's own origin, where this fallback would otherwise replace them with the app.
  if (request.mode === "navigate" && !url.href.startsWith(WEB_SITE_URL)) {
    event.respondWith(cacheFirst(INDEX_URL, request));
    return;
  }

  // Everything else (signaling, runtime data) goes straight to the network.
});

// --- Web Push (OS notifications) -------------------------------------------
// A push arrives only when no device of the recipient was online to receive the
// peer envelope over WebSocket (see server/signaling/websocket-server.js). The
// payload carries the sender's id plus an encrypted hint; we decrypt the hint
// locally with the user's private key so the relay never learns the text.

const APP_NAME = "Tally";
const GENERIC_NOTIFICATION = { title: APP_NAME, body: "You have new Tally activity" };

const DB_NAME = "iou_client_db";
const STORE_NAME = "app_state";
const APP_STATE_KEY = "root_state";

// Read the persisted root state straight from IndexedDB. The SW has no access
// to the app's in-memory state, so this is the only way to reach the private
// key needed for ECDH decryption.
const readAppState = () =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const request = indexedDB.open(DB_NAME);
      request.onerror = () => finish(null);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          finish(null);
          return;
        }
        const tx = db.transaction(STORE_NAME, "readonly");
        const getRequest = tx.objectStore(STORE_NAME).get(APP_STATE_KEY);
        getRequest.onsuccess = () => finish(getRequest.result || null);
        getRequest.onerror = () => finish(null);
      };
    } catch {
      finish(null);
    }
  });

// Turn a push payload into the notification to show. Falls back to a generic
// message whenever decryption can't proceed (no key, malformed payload, etc.)
// so the user still learns "something happened" without leaking specifics.
const resolveNotification = async (payload) => {
  const hint = payload?.hint;
  const fromUserId = payload?.from_user_id;
  if (!hint || !fromUserId || !self.__tallyPushCrypto) {
    return GENERIC_NOTIFICATION;
  }
  try {
    const state = await readAppState();
    const privateKeyHex = state?.user?.private_key_hex;
    if (!privateKeyHex) return GENERIC_NOTIFICATION;
    const plaintext = await self.__tallyPushCrypto.decryptHint(hint, privateKeyHex, fromUserId);
    const parsed = JSON.parse(plaintext);
    if (parsed && typeof parsed.body === "string") {
      // `tag` is the peer message id; a local notification for the same
      // message (app open but hidden) uses it too, so they replace each other.
      const tag = typeof parsed.tag === "string" ? parsed.tag : undefined;
      return { title: parsed.title || APP_NAME, body: parsed.body, tag };
    }
  } catch {
    // Any failure → generic notification below.
  }
  return GENERIC_NOTIFICATION;
};

self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }

  event.waitUntil(
    (async () => {
      const { title, body, tag } = await resolveNotification(payload);
      await self.registration.showNotification(title, {
        body,
        ...(tag ? { tag } : {}),
        icon: "icons/icon-192.png",
        badge: "icons/icon-192.png",
        data: { url: "./" },
      });
    })(),
  );
});

// Focus an existing app window (or open one) when a notification is tapped.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "./";
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })(),
  );
});
