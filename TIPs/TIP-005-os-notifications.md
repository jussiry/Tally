# TIP-005: OS Notifications via Encrypted Web Push

| Field   | Value |
|---------|-------|
| Number  | TIP-005 |
| Title   | OS Notifications via Encrypted Web Push |
| Status  | Draft (implemented, pending real-device verification) |
| Author  | Jussi Rytkönen |
| Created | 2026-06-05 |

---

## Summary

Tally can now raise **OS-level notifications** (lock screen / notification tray)
when a peer message arrives while the app is closed. It uses the standard Web
Push stack (VAPID + the browser vendor's push service) but keeps the
notification text **end-to-end encrypted**: the relay that triggers the push
never learns what the notification says.

Every inbound event that shows an in-app toast can also raise an OS
notification; the user picks which in **Settings → Notifications**. Three are on
by default, as they were before per-event choice existed:

- a friend sends you money (`transaction_created`)
- a friend requests money (`payment_request`)
- a friend sends a friend request (`friend_request`)

The rest (payment request answered/cancelled, friend request accepted/rejected,
trust-limit changes, name changes) are off by default. The catalogue and
defaults are `OS_NOTIFIABLE_EVENTS` in `app/js/notify/notification-policy.js`.
Transport traffic (sync, receipts) and `notification_prefs` itself never notify.

---

## Notification layers

The app surfaces "something happened" through four layers. This TIP adds layer 4
and centralizes the layer-4 routing decision in
`app/js/notify/notification-policy.js`:

| # | Layer            | Where                                   | Lifetime / audience                         |
|---|------------------|-----------------------------------------|---------------------------------------------|
| 1 | Logs             | logs page (derived from the ledger)     | every event; OS-notified types highlighted  |
| 2 | In-app toasts    | `js/ui/notifications.js`                 | while app open & focused; transient         |
| 3 | Actionable boxes | friend page (derived from app state)    | persists while the prompting state exists   |
| 4 | OS notifications | Web Push → service worker               | reaches the user when the app is **closed** |

Adding a new OS-notifiable event is an `OS_NOTIFIABLE_EVENTS` entry plus a
`HINT_BUILDERS` function in the policy module.

When the app is open but not in view (another tab in front, minimised), the
device is online, so the relay doesn't push. `notify/local-os-notification.js`
then raises the OS notification from the page, under the same per-event choice
and only on a device that opted in.

---

## Per-event choice

Browsers forbid silent pushes: a subscription promises `userVisibleOnly`, and a
push that shows nothing gets a browser-made notification (Chrome), a smaller
quota (Firefox) or a revoked subscription (Safari). So the recipient's service
worker can't drop unwanted events — the filter has to sit upstream.

The **sender** applies it. The recipient publishes its choice as a
`notification_prefs` ledger message (`{ enabled: [types] }`) to every
peer-eligible friend, plus a self-addressed copy that self-sync carries to its
own devices. A sender reads the latest one by the recipient from its own ledger
(`peerOsNotifyTypes` in the realtime snapshot) and attaches a push hint only for
enabled types; the relay still pushes only envelopes that carry a hint. A new
friend gets the choice when the friendship is accepted; a peer with no entry
(stranger's friend request, older app) is treated as having the defaults.

The relay's view is unchanged: it never learns the event type. Friends do learn
which events their friend gets notified about.

---

## Why encrypted hints

A normal Web Push lets the **application server** put the notification text in
the payload. Here the relay is semi-trusted (it already only sees opaque
envelope ciphertext), so we don't want it composing or reading notification
text. Instead:

1. The **sender** knows the human-readable context (its own name, the amount).
   When it queues an envelope for an offline recipient, it also builds a short
   hint (`{ title, body }`), encrypts it **for the recipient** with the same
   NIP-44 v2 scheme used for envelope bodies
   (`crypto/peer-crypto.js`), and attaches it as `envelope.push_hint`.
2. The **relay** forwards `push_hint` (plus the plaintext `from_user_id` routing
   field) as the Web Push payload — only when no device of the recipient is
   online to receive the envelope over WebSocket.
3. The **recipient's service worker** decrypts the hint locally using the
   private key from IndexedDB and the sender's public key, then calls
   `showNotification`. If anything is missing (no key, malformed payload), it
   falls back to a generic "You have new Tally activity".

The relay therefore learns *that* a notification was sent and *to whom* (it
already knew both), but never the amount, the note, or the event type.

---

## Components

**Server**
- `server/push/push-service.js` — VAPID identity (env → cached file →
  generate), in-memory `userId → Map<endpoint, subscription>` store, and
  `sendToUser()` (prunes 404/410 endpoints).
- `server/signaling/websocket-server.js` — handles `push_subscribe` /
  `push_unsubscribe`; fires `pushService.sendToUser` from
  `handleQueuePeerEnvelope` when `!deliveredToAny`.
- `server/server.js` — `GET /push/vapid-public-key`.

**Client**
- `app/js/notify/notification-policy.js` — layer documentation + the
  message-type → hint mapping.
- `app/js/peer/client.js` — `flushOutbox` attaches the encrypted `push_hint`
  on the offline (server-queue) path; exposes `setPushSubscription` /
  `sendPushUnsubscribe` and a `getRealtimeClient()` singleton accessor.
- `app/js/signaling/socket-client.js` + `relay-pool.js` — carry the
  subscription, re-sent on every (re)register and fanned out to all relays.
- `app/js/push/push-subscribe.js` — permission + `pushManager.subscribe`
  handshake, device-local state, resync on app start.
- `app/sw-crypto-entry.js` → bundled to `dist/sw-crypto.js` (IIFE) — secp256k1
  ECDH decrypt for the SW (WebCrypto can't do secp256k1, and the SW is a classic
  worker that can't import the app's ESM).
- `app/sw.js` — `push` + `notificationclick` listeners.
- Settings → "Notifications" toggle (device-local), and the
  `ui-modules/subpage/notifications.*` subpage: per-event choice, the browser's
  push service (read-only), reset to defaults.
- `app/js/notify/notification-prefs.js` + `commands/notification-prefs.js` —
  publish the per-event choice (see "Per-event choice").
- `app/js/notify/local-os-notification.js` — OS notification while the app is
  open but hidden.

The message id travels as the notification `tag`, so a push and a local
notification for the same message replace each other.

---

## Privacy & security notes

- **Subscriptions are device-local.** Nothing about push is written to the
  synced app state — a subscription is meaningless on a device that didn't
  create it, and OS permission can't be granted remotely. The settings toggle
  reflects the live browser state.
- **VAPID public key is public** by design; it only authenticates pushes as
  originating from this server.
- **Hint plaintext never leaves the two endpoints.** Same trust model as the
  envelope body.
- **Generic fallback** ensures a logged-out / key-less device still shows a
  non-leaking notification rather than failing silently.

---

## Open questions / future work

1. **Per-device choice.** The per-event choice is per user, because senders
   can't tell a user's devices apart; the on/off toggle stays per device.
2. **Subscription persistence across server restarts.** Subscriptions are
   in-memory and self-heal on client reconnect (like the envelope queue). A
   durable store would close the gap where a push is missed in the window
   between a restart and the next reconnect.
3. **Push service is the browser's.** The endpoint (FCM for Chromium, Mozilla
   for Firefox, Apple for Safari) is fixed by the browser; a web app can't use
   another one. Shown read-only in the subpage.
4. **Real-device verification.** The encrypted-hint round trip can't be fully
   exercised in the preview browser; needs a home-screen PWA on a real device
   with a live push service.
