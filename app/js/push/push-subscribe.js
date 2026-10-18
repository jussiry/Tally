/*
Client-side Web Push opt-in. Owns the browser handshake that turns "the user
flipped the OS-notifications toggle" into a live push subscription the relay can
deliver to:

  1. Ask the service worker for / create a PushSubscription using the server's
     VAPID public key (fetched from /push/vapid-public-key).
  2. Hand that subscription to the realtime client, which fans it out to every
     relay (see signaling/relay-pool.js). The relay stores it per user and uses
     it only when no device is online to receive a peer envelope.

Permission and subscription are intentionally device-local: nothing here is
written to the synced app state, because a subscription is meaningless on a
device that didn't create it and OS permission can't be granted remotely. The
settings toggle therefore reflects the *current browser's* real state, queried
live via getPushState().
@category network
*/

import { getRealtimeClient } from "../peer/client.js";

// Convert a base64url VAPID key to the Uint8Array applicationServerKey expects.
const urlBase64ToUint8Array = (base64String) => {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
};

export const isPushSupported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

// Snapshot of this device's push state, used to render the settings toggle.
// Returns one of: "unsupported", "denied", "enabled", "disabled".
export const getPushState = async () => {
  if (!isPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return subscription ? "enabled" : "disabled";
  } catch {
    return "disabled";
  }
};

const fetchVapidPublicKey = async () => {
  const response = await fetch("/push/vapid-public-key", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not fetch VAPID public key.");
  const key = (await response.text()).trim();
  if (!key) throw new Error("Server has no VAPID public key configured.");
  return key;
};

// Request permission (if needed), create/reuse a subscription, and register it
// with the relays. Returns the resulting push state string, or "error" when the
// browser couldn't create a subscription — e.g. Chrome's "Registration failed -
// push service error" when it can't reach its push service (Brave with Google
// push disabled, Chromium builds without Google services, a blocking network).
export const enablePush = async () => {
  if (!isPushSupported()) return "unsupported";

  const permission =
    Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
  if (permission !== "granted") {
    return permission === "denied" ? "denied" : "disabled";
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const vapidKey = await fetchVapidPublicKey();
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    }
    getRealtimeClient()?.setPushSubscription(subscription.toJSON());
    return "enabled";
  } catch (error) {
    console.warn("Push subscription failed:", error);
    return "error";
  }
};

// Tear down this device's subscription and tell the relays to forget it.
export const disablePush = async () => {
  if (!isPushSupported()) return "unsupported";
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      getRealtimeClient()?.sendPushUnsubscribe(subscription.endpoint);
      await subscription.unsubscribe();
    }
  } catch {
    // Best-effort — even if unsubscribe fails the toggle reflects reality next
    // time getPushState() runs.
  }
  return "disabled";
};

// Re-publish an existing subscription to the relays on app start, so a device
// that already opted in keeps receiving pushes without re-prompting. No-op when
// the user never enabled push or permission was revoked.
export const resyncPushSubscription = async () => {
  if (!isPushSupported() || Notification.permission !== "granted") return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      getRealtimeClient()?.setPushSubscription(subscription.toJSON());
    }
  } catch {
    // ignore — nothing to resync
  }
};
