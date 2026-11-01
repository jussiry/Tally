/*
A pool of signaling-client connections to multiple relay servers.

Each underlying `createSignalingClient` is a single-relay transport. The pool
holds N of them in parallel and presents the same callback surface to
`peer/client.js`. Per TIP-003, the server protocol is idempotent on
`(userId, deviceId, envelopeId)` triples, so:

- Outbound calls (setSession, requestPeerConnection, sendPeerSignal,
  queuePeerEnvelopeOnServer) fan out to every connected relay. Duplicate
  WebRTC signals are absorbed by perfect-negotiation; duplicate envelopes
  are absorbed by `processed_peer_message_ids` at the recipient.

- Inbound peer_disconnect is folded into a single "this (userId, deviceId)
  went offline everywhere" event by tracking a per-peer set of relays that
  currently report them online; it fires only when the last relay drops them.
  Every peer_connect is passed through, though: a relay re-sends one when we
  ask it to re-pair after a dropped WebRTC connection, and swallowing it just
  because the peer is still present would leave the pair unconnected forever.
  `ensurePeer` above is idempotent, so duplicates across relays are harmless.

- Other inbound events (peer_signal, peer_envelope) just pass through; the
  layer above is already designed to swallow duplicates.

- `onSessionReady` fires per relay (each registers independently). The
  client uses this to reset per-relay state; firing once per relay is fine
  because the reset operations themselves are idempotent.

- `onQueueDrained` is more subtle: each relay sends `queue_drained` when
  its own queue for this user is empty. The pool only forwards "drained"
  once *all* connected relays have drained, because sync_hello may otherwise
  re-request entries another relay is about to deliver.

The pool also writes per-relay status into `relay-status-registry` so the
settings UI can render live state. Status transitions: pending → connected
on WebSocket open; connected → disconnected on close; back to pending on
the next reconnect attempt.
@category network
*/

import { createSignalingClient } from "./socket-client.js";
import { normalizeRelayUrl } from "../utils/relay-url.js";
import {
  RelayStatus,
  clearRelayStatus,
  setRelayStatus,
} from "./relay-status-registry.js";

const peerKey = (userId, deviceId) => {
  const u = userId?.trim() || "";
  const d = deviceId?.trim() || "";
  if (!u) return "";
  return `${u}|${d}`;
};

export const createRelayPool = ({
  onPeerConnect = null,
  onPeerDisconnect = null,
  onPeerSignal = null,
  onPeerEnvelopeFromServer = null,
  onSessionReady = null,
  onQueueDrained = null,
} = {}) => {
  // url → { url, client, ready, drained }
  const entries = new Map();
  // composite peerKey → Set<relayUrl> that currently report this peer online
  const presence = new Map();
  // The last session snapshot we were asked to register with. Newly-added
  // relays use this to register immediately.
  let lastSession = null;
  // The last push subscription we were given, so relays added later also learn
  // where to deliver Web Push for this device.
  let lastPushSubscription = null;

  const presenceAdd = (key, url) => {
    let set = presence.get(key);
    if (!set) {
      set = new Set();
      presence.set(key, set);
    }
    set.add(url);
  };

  const presenceRemove = (key, url) => {
    const set = presence.get(key);
    if (!set) return false;
    set.delete(url);
    if (set.size === 0) {
      presence.delete(key);
      return true;
    }
    return false;
  };

  // Drop every presence entry that referenced this relay url and emit
  // peer_disconnect for any peer that becomes orphaned as a result.
  const purgeRelayFromPresence = (url) => {
    const newlyOffline = [];
    presence.forEach((set, key) => {
      if (!set.has(url)) return;
      set.delete(url);
      if (set.size === 0) {
        presence.delete(key);
        newlyOffline.push(key);
      }
    });
    if (typeof onPeerDisconnect === "function") {
      newlyOffline.forEach((key) => {
        const [peerUserId, peerDeviceId = ""] = key.split("|");
        onPeerDisconnect({ peerUserId, peerDeviceId });
      });
    }
  };

  // Recompute the "all relays drained" flag and fire onQueueDrained once
  // when the last connected relay finishes draining.
  let lastEmittedAllDrained = false;
  const reconsiderAllDrained = () => {
    const connected = Array.from(entries.values()).filter((e) => e.ready);
    if (connected.length === 0) {
      lastEmittedAllDrained = false;
      return;
    }
    const allDrained = connected.every((e) => e.drained);
    if (allDrained && !lastEmittedAllDrained) {
      lastEmittedAllDrained = true;
      if (typeof onQueueDrained === "function") onQueueDrained();
    } else if (!allDrained) {
      lastEmittedAllDrained = false;
    }
  };

  const createEntryForUrl = (rawUrl) => {
    const url = normalizeRelayUrl(rawUrl) || rawUrl;
    if (!url || entries.has(url)) return;

    const entry = {
      url,
      client: null,
      ready: false,
      drained: false,
    };
    entries.set(url, entry);
    setRelayStatus(url, RelayStatus.PENDING);

    entry.client = createSignalingClient({
      url, // see socket-client change: optional override
      onPeerConnect: ({ peerUserId, peerDeviceId, initiator }) => {
        const key = peerKey(peerUserId, peerDeviceId);
        if (!key) return;
        presenceAdd(key, url);
        if (typeof onPeerConnect === "function") {
          onPeerConnect({ peerUserId, peerDeviceId, initiator });
        }
      },
      onPeerDisconnect: ({ peerUserId, peerDeviceId }) => {
        const key = peerKey(peerUserId, peerDeviceId);
        if (!key) return;
        const nowEmpty = presenceRemove(key, url);
        if (nowEmpty && typeof onPeerDisconnect === "function") {
          onPeerDisconnect({ peerUserId, peerDeviceId });
        }
      },
      onPeerSignal: (payload) => {
        if (typeof onPeerSignal === "function") onPeerSignal(payload);
      },
      onPeerEnvelopeFromServer: (payload) => {
        if (typeof onPeerEnvelopeFromServer === "function") {
          onPeerEnvelopeFromServer(payload);
        }
      },
      onSessionReady: () => {
        entry.ready = true;
        entry.drained = false;
        setRelayStatus(url, RelayStatus.CONNECTED);
        lastEmittedAllDrained = false;
        if (typeof onSessionReady === "function") onSessionReady();
      },
      onQueueDrained: () => {
        entry.drained = true;
        reconsiderAllDrained();
      },
      onSocketClose: () => {
        entry.ready = false;
        entry.drained = false;
        setRelayStatus(url, RelayStatus.DISCONNECTED);
        purgeRelayFromPresence(url);
        reconsiderAllDrained();
      },
    });
  };

  const destroyEntry = (url) => {
    const entry = entries.get(url);
    if (!entry) return;
    entries.delete(url);
    try {
      entry.client?.destroy();
    } catch {
      // ignore
    }
    purgeRelayFromPresence(url);
    clearRelayStatus(url);
    reconsiderAllDrained();
  };

  // Reconcile the pool against a target relay URL list (order-insensitive).
  // Adds new ones, leaves existing ones alone, drops removed ones.
  const setRelays = (urls) => {
    const targetSet = new Set();
    (Array.isArray(urls) ? urls : []).forEach((raw) => {
      const url = normalizeRelayUrl(raw) || (typeof raw === "string" ? raw.trim() : "");
      if (url) targetSet.add(url);
    });

    // Remove relays no longer in the target set.
    Array.from(entries.keys()).forEach((url) => {
      if (!targetSet.has(url)) destroyEntry(url);
    });

    // Add new ones.
    targetSet.forEach((url) => {
      if (!entries.has(url)) {
        createEntryForUrl(url);
        // If we already know the session, push it to the new entry as soon
        // as its socket opens — handled by onSessionReady → setRegistration
        // path in the underlying client. We also seed lastSession so the
        // client's setSession (called below) reaches the new client.
      }
    });

    // Push the current session to every client (idempotent).
    if (lastSession) {
      entries.forEach((entry) => entry.client?.setSession(lastSession));
    }
    // Seed any newly-added relays with the push subscription too.
    if (lastPushSubscription) {
      entries.forEach((entry) => entry.client?.setPushSubscription(lastPushSubscription));
    }
  };

  const setSession = (session) => {
    lastSession = session || null;
    entries.forEach((entry) => entry.client?.setSession(session));
  };

  const setPushSubscription = (subscription) => {
    lastPushSubscription = subscription || null;
    entries.forEach((entry) => entry.client?.setPushSubscription(subscription));
  };

  const sendPushUnsubscribe = (endpoint) => {
    lastPushSubscription = null;
    entries.forEach((entry) => entry.client?.sendPushUnsubscribe(endpoint));
  };

  const requestPeerConnection = (peerUserId) => {
    entries.forEach((entry) => entry.client?.requestPeerConnection(peerUserId));
  };

  const sendPeerSignal = (peerUserId, peerDeviceId, signal) => {
    entries.forEach((entry) =>
      entry.client?.sendPeerSignal(peerUserId, peerDeviceId, signal)
    );
  };

  // Returns true if *any* relay accepted the envelope — that's enough for the
  // outbox to consider it durably queued, because the recipient only needs
  // one overlapping relay to pick it up.
  const queuePeerEnvelopeOnServer = (envelope) => {
    let queued = false;
    entries.forEach((entry) => {
      const ok = entry.client?.queuePeerEnvelopeOnServer(envelope);
      if (ok) queued = true;
    });
    return queued;
  };

  const getStatuses = () => {
    return Array.from(entries.values()).map((entry) => ({
      url: entry.url,
      ready: entry.ready,
      drained: entry.drained,
    }));
  };

  const destroy = () => {
    Array.from(entries.keys()).forEach((url) => destroyEntry(url));
    presence.clear();
    lastSession = null;
    lastEmittedAllDrained = false;
  };

  return {
    setRelays,
    setSession,
    requestPeerConnection,
    sendPeerSignal,
    queuePeerEnvelopeOnServer,
    setPushSubscription,
    sendPushUnsubscribe,
    getStatuses,
    destroy,
  };
};
