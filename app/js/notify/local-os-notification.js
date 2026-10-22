/*
OS notification for an event that arrives while the app is open but not in
view (another tab in front, window minimised, desktop PWA in the background).

The relay pushes only when no device of the user is online, so an open-but-
hidden app gets the event over its live connection and nobody else raises an
OS notification for it. This module fills that gap from the page itself, under
the same rules as a push: only for event types the user routes to the OS, and
only on a device that opted in (permission granted and subscribed). The message
id is the notification tag — the same tag a push for this message would use —
so the two replace each other rather than stack.
@category ui
*/

import { getOsNotifyTypes } from "./notification-policy.js";

export const showLocalOsNotification = async (state, entry, notification) => {
  if (!notification?.text || !entry?.type || !state?.user?.id) return;
  if (typeof document === "undefined" || document.visibilityState === "visible") return;
  if (!("serviceWorker" in navigator) || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (!getOsNotifyTypes(state.ledger, state.user.id).includes(entry.type)) return;

  try {
    const registration = await navigator.serviceWorker.ready;
    if (!(await registration.pushManager?.getSubscription())) return;
    await registration.showNotification("Tally", {
      body: notification.text,
      tag: entry.id,
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      data: { url: notification.hash ? `./#${notification.hash}` : "./" },
    });
  } catch (error) {
    console.warn("Local OS notification failed:", error);
  }
};
