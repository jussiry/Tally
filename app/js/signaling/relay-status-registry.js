/*
Runtime registry of relay connection statuses.

Relay statuses ("connected", "pending", "disconnected") are ephemeral and must
not be persisted to IndexedDB — they describe transport state, not user data.
But the settings view-model needs to render them, and the view-model itself is
a pure function of state. To keep both invariants, the relay pool writes into
this in-memory registry, and the view-model reads from it via `getRelayStatus`.

When a status changes the pool calls `setRelayStatus(url, status)`, which
notifies app-state to re-emit the current view so the settings page rebuilds.
The registry is the only mutable runtime store consulted by view construction
— if more transport state needs to surface to the UI in the future, follow
the same pattern (or fold all of them into a single transport-state module).
@category network
*/

import { normalizeRelayUrl } from "../utils/relay-url.js";

const RelayStatus = Object.freeze({
  PENDING: "pending",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
});

const statuses = new Map(); // normalisedUrl → status
const listeners = new Set();

const normaliseKey = (url) => normalizeRelayUrl(url) || url?.trim() || "";

export const getRelayStatus = (url) => {
  const key = normaliseKey(url);
  return statuses.get(key) || RelayStatus.PENDING;
};

// True when at least one relay currently has a live, registered session — i.e.
// this device is reachable by its peers.
export const isAnyRelayConnected = () =>
  Array.from(statuses.values()).includes(RelayStatus.CONNECTED);

export const setRelayStatus = (url, status) => {
  const key = normaliseKey(url);
  if (!key) return;
  const previous = statuses.get(key);
  if (previous === status) return;
  statuses.set(key, status);
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // ignore listener errors; status writes must remain reliable
    }
  });
};

export const clearRelayStatus = (url) => {
  const key = normaliseKey(url);
  if (!key) return;
  if (!statuses.has(key)) return;
  statuses.delete(key);
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // ignore
    }
  });
};

// Subscribe to any status change. Returns an unsubscribe function. Used by
// app-state to bridge relay status updates into the data-change notification
// pipeline that drives view rebuilds.
export const subscribeToRelayStatusChanges = (listener) => {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export { RelayStatus };
