/*
This module orchestrates websocket signaling, WebRTC peer sessions, and queued
peer-message delivery for the IOU client.

It subscribes to persisted app-state changes so presence, friendship
eligibility, and unsent messages stay in sync with the transport layer
without requiring page-specific code to know about networking internals.

Two parallel WebRTC overlays:

  * **Friend mesh** — one peer per (friend user id, friend device id) pair,
    keyed by `${peerUserId}|${peerDeviceId}` so a friend on multiple
    devices keeps a separate slot per device. Ledger state is exchanged
    bilaterally (`getLedgerEntriesForPeer`).

  * **Self-mesh** — one peer per *other device of the same user* (keyed by
    the `peerDeviceId`). Both devices sync the entire
    ledger between them (`getAllLedgerEntries`) so each device stays in
    lock-step. Whenever a new entry is appended locally (by applying an
    inbound peer message or by the local user acting) we push it to every
    connected self-device via `sync_data`, so the other device doesn't
    have to wait for the next sync_hello round-trip to see it.

Both overlays use the same `createPeerMesh` factory and the same sync
wire format (`sync_hello` / `sync_data`); only the sender-side slice and
the mesh key differ.

**Self-sync relay fallback.** Without a TURN server some networks (carrier
NAT, routers without hairpinning) never let two devices open a direct
channel. So whenever another own device is present on a relay but has no
open self-mesh channel, the same sync messages also go out as self-addressed
envelopes through the relay, which delivers them to the user's other online
devices. The pseudo peer key `SELF_RELAY_PEER_KEY` stands for that path in
the sync code, so hello/data handling is shared with the direct channel.

Application-level peer messages travel inside encrypted envelopes wrapped
here so the WebRTC channel and the signaling server's fallback queue see
only ciphertext. Transport-only messages (ping/pong/receipts) keep flowing
as plaintext over the data channel — they are local to a live WebRTC
session and never need to be forwarded by the server.
@category network
*/

import {
  addLedgerEntries,
  addOutboundLedgerEntries,
  applyInboundPeerMessage,
  applyOwnNameFromLedger,
  getRealtimeSnapshot,
  markPeerMessageReceived,
  runLedgerMigrationIfNeeded,
  updateLastSyncedAt,
} from "./bridge.js";
import { subscribeToDataChanges } from "../app-state.js";
import {
  createPeerReceiptMessage,
  PEER_MESSAGE_TYPE_PING,
  PEER_MESSAGE_TYPE_PONG,
  PEER_MESSAGE_TYPE_RECEIVED,
  PEER_MESSAGE_TYPE_SYNC_HELLO,
  PEER_MESSAGE_TYPE_SYNC_DATA,
} from "./messages.js";
import {
  isPeerEnvelope,
  unwrapPeerEnvelope,
  wrapPeerMessage,
} from "./envelope.js";
import { buildOsNotificationHint } from "../notify/notification-policy.js";
import {
  getAllLedgerEntries,
  getLedgerEntriesForPeer,
  verifyLedgerEntryAuthorship,
} from "../ledger.js";
import { createRelayPool } from "../signaling/relay-pool.js";
import { createPeerMesh } from "./mesh.js";
import {
  replaceConnectedPeerIds,
  replaceConnectedSelfDeviceIds,
  addServerPresentPeer,
  removeServerPresentPeer,
  clearServerPresentPeers,
} from "./status.js";

const SCOPE_FRIEND = "friend";
const SCOPE_SELF = "self";
// Pseudo peer key for self-sync messages sent through the relay to all other
// own devices at once (see the relay fallback note above).
const SELF_RELAY_PEER_KEY = "relay";
// Relay-delivered sync messages arrive once per relay; remember recent ids so
// each is handled once. Bounded because sync ids are never reused.
const SEEN_RELAY_SYNC_IDS_LIMIT = 500;

const logRealtimeEvent = (message) => {
  console.log(`[Realtime] ${message}`);
};

const createRealtimeClient = () => {
  let currentSnapshot = null;
  // Tracks envelope ids already pushed to the server queue this WebSocket session.
  // Reset whenever the WebSocket re-registers so a server restart causes
  // outbox messages to be re-queued instead of stranded.
  const envelopesSentToServer = new Set();

  // Sync protocol state.
  // We defer sync_hello until the server has finished flushing any queued
  // envelopes for us — that way we won't re-request ledger entries we're
  // about to receive anyway via the regular inbound path.
  let serverQueueDrained = false;
  // Envelopes the server delivered that are still being decrypted and applied.
  // `queue_drained` only means the server sent everything; the queue counts as
  // drained for us once these have landed in the ledger too.
  const inflightServerEnvelopes = new Set();
  // Friend-mesh sync tracking — keyed by friend peerKey
  // (`${peerUserId}|${peerDeviceId}`) so each of a friend's devices gets
  // its own sync_hello / sync_data exchange.
  const pendingFriendSync = new Set();
  const syncedFriends = new Set();

  // Composite friend-mesh key. Stable per (friendUserId, friendDeviceId)
  // pair so a friend running on multiple devices keeps a separate slot
  // per device. Returns "" if either component is missing — the caller
  // should treat that as "no peer to address."
  const friendPeerKey = (peerUserId, peerDeviceId) => {
    const userId = typeof peerUserId === "string" ? peerUserId.trim() : "";
    const deviceId = typeof peerDeviceId === "string" ? peerDeviceId.trim() : "";
    if (!userId || !deviceId) return "";
    return `${userId}|${deviceId}`;
  };
  // Self-mesh sync tracking — keyed by peerDeviceId.
  const pendingSelfSync = new Map(); // deviceId -> peerUserId (= my userId)
  const syncedSelfDevices = new Set();
  // Own devices a relay reports online, whether or not WebRTC connects them.
  const selfDevicesOnRelay = new Set();
  const seenRelaySyncIds = new Set();

  // True when some own device is reachable only through the relay.
  const hasSelfDeviceWithoutChannel = () =>
    Array.from(selfDevicesOnRelay).some((deviceId) => !selfMesh.canSend(deviceId));
  const canSendSelf = (peerKey) =>
    peerKey === SELF_RELAY_PEER_KEY ? selfDevicesOnRelay.size > 0 : selfMesh.canSend(peerKey);

  // Tracks ledger entry ids already broadcast to self-devices in this session.
  // Every locally-applied or locally-merged entry is a candidate for re-send,
  // but replaying entries we just received would bounce back-and-forth
  // between devices. Seeding this with incoming entries (after merge) breaks
  // the loop.
  const broadcastedLedgerIds = new Set();

  const sendSyncMessage = async (peerKey, { scope }, type, payload, peerUserId) => {
    if (!currentSnapshot?.keyProvider || !currentSnapshot?.userId) return;
    const mesh = scope === SCOPE_SELF ? selfMesh : peerMesh;
    const viaRelay = scope === SCOPE_SELF && peerKey === SELF_RELAY_PEER_KEY;
    if (!(viaRelay ? canSendSelf(peerKey) : mesh.canSend(peerKey))) return;

    const randomId = (window.crypto?.randomUUID && window.crypto.randomUUID())
      || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const targetUserId = peerUserId || currentSnapshot.userId;
    const message = {
      id: `sync_${randomId}`,
      type,
      from_user_id: currentSnapshot.userId,
      to_user_id: targetUserId,
      created_at: new Date().toISOString(),
      payload,
    };
    try {
      const envelope = await wrapPeerMessage(message, {
        keyProvider: currentSnapshot.keyProvider,
      });
      if (viaRelay) {
        signalingClient.queuePeerEnvelopeOnServer(envelope);
      } else {
        mesh.sendPeerMessage(peerKey, envelope);
      }
    } catch (error) {
      logRealtimeEvent(
        `Failed to wrap sync message (${scope}/${type}): ${String(error?.message || error)}`
      );
    }
  };

  const getScopeEntries = (scope, peerUserId) => {
    if (!currentSnapshot) return [];
    if (scope === SCOPE_SELF) {
      return getAllLedgerEntries(currentSnapshot.ledger);
    }
    return getLedgerEntriesForPeer(
      currentSnapshot.ledger,
      currentSnapshot.userId,
      peerUserId,
    );
  };

  const sendSyncHello = async (peerKey, { scope, peerUserId }) => {
    if (!currentSnapshot) return;
    const entries = getScopeEntries(scope, peerUserId);
    if (scope === SCOPE_SELF) {
      syncedSelfDevices.add(peerKey);
    } else {
      syncedFriends.add(peerKey);
    }
    logRealtimeEvent(
      `Sending sync_hello (${scope}, ${entries.length} known entries)`
    );
    await sendSyncMessage(
      peerKey,
      { scope },
      PEER_MESSAGE_TYPE_SYNC_HELLO,
      { known_ids: entries.map((entry) => entry.id) },
      peerUserId,
    );
  };

  const handleSyncHello = async (peerKey, payload, { scope, peerUserId }) => {
    if (!currentSnapshot) return;
    const knownIds = new Set(
      Array.isArray(payload?.known_ids) ? payload.known_ids : []
    );
    const myEntries = getScopeEntries(scope, peerUserId);
    const missing = myEntries.filter((entry) => !knownIds.has(entry.id));
    logRealtimeEvent(
      `Received sync_hello (${scope}), sending ${missing.length} missing of ${knownIds.size} known`
    );
    // Seed the broadcast cache so we don't immediately re-push these entries
    // again through the subscribeToDataChanges path.
    if (scope === SCOPE_SELF) {
      missing.forEach((entry) => {
        if (entry?.id) broadcastedLedgerIds.add(entry.id);
      });
    }
    await sendSyncMessage(
      peerKey,
      { scope },
      PEER_MESSAGE_TYPE_SYNC_DATA,
      { entries: missing },
      peerUserId,
    );
  };

  const handleSyncData = async (peerKey, payload, { scope, peerUserId }) => {
    if (!currentSnapshot) return;
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    if (entries.length === 0) return;

    const myId = currentSnapshot.userId;
    const inboundLike = [];
    const outboundOnly = [];
    // Self-addressed entries (from_user_id === to_user_id === myId) are
    // authored by the local user on another device — e.g. the initial
    // name_changed entry created at account creation. They go to the ledger
    // but are not routed through the inbound message handler.
    const selfAddressed = [];
    for (const entry of entries) {
      // Every synced entry must carry a valid authorship proof by its claimed
      // `from_user_id`. This check applies to self-sync too — the signing key
      // is the same for both devices (both hold the user's private key), so
      // entries authored on device A verify cleanly on device B. We keep the
      // check so a compromised same-user channel can't inject forged
      // third-party history.
      const authorshipValid = await verifyLedgerEntryAuthorship(entry);
      if (!authorshipValid) {
        logRealtimeEvent(
          `Rejected entry with invalid authorship (${scope}, from ${entry?.from_user_id?.slice(0, 10)}…)`
        );
        continue;
      }
      if (entry.from_user_id === myId && entry.to_user_id === myId) {
        selfAddressed.push(entry);
      } else if (entry.to_user_id === myId) {
        inboundLike.push(entry);
      } else if (entry.from_user_id === myId) {
        outboundOnly.push(entry);
      }
    }

    // Replay chronologically: a later tx_created can only apply after an
    // earlier friend_accept has re-created the connection during recovery.
    const byOrigin = (a, b) => {
      const aTs = a.originated_at || a.timestamp || "";
      const bTs = b.originated_at || b.timestamp || "";
      return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
    };
    inboundLike.sort(byOrigin);
    outboundOnly.sort(byOrigin);

    logRealtimeEvent(
      `Received sync_data (${scope}): ${entries.length} entries — ${inboundLike.length} inbound, ${outboundOnly.length} outbound, ${selfAddressed.length} self`
    );

    for (const entry of inboundLike) {
      // Seed the broadcast cache *before* the handler runs so the resulting
      // subscribeToDataChanges tick doesn't echo this entry back to peers.
      // If processing fails we remove the id so a future sync can retry it.
      if (entry?.id) broadcastedLedgerIds.add(entry.id);
      try {
        await applyInboundPeerMessage({
          id: entry.id,
          type: entry.type,
          from_user_id: entry.from_user_id,
          to_user_id: entry.to_user_id,
          // Preserve the sender's original `created_at` — it's what the
          // authorship proof was computed over, and what `originated_at`
          // should track in the resulting ledger entry.
          created_at: entry.originated_at || entry.timestamp,
          payload: entry.payload,
          signature: entry.signature,
          authorship: entry.authorship,
        });
      } catch (err) {
        if (entry?.id) broadcastedLedgerIds.delete(entry.id);
        throw err;
      }
    }
    if (outboundOnly.length > 0) {
      outboundOnly.forEach((entry) => {
        if (entry?.id) broadcastedLedgerIds.add(entry.id);
      });
      await addOutboundLedgerEntries(outboundOnly);
    }
    if (selfAddressed.length > 0) {
      selfAddressed.forEach((entry) => {
        if (entry?.id) broadcastedLedgerIds.add(entry.id);
      });
      await addLedgerEntries(selfAddressed);
    }

    // After the ledger has been updated, scan it for the most recent
    // name_changed entry this user authored on any device and apply it as
    // the local display name. Scanning the persisted ledger (rather than the
    // in-flight classification arrays) is robust to signature failures and
    // handles the case where the key entry arrived in an earlier sync batch.
    if (scope === SCOPE_SELF) {
      await applyOwnNameFromLedger();
    }

    await syncRealtimeState();
  };

  const trySyncPendingPeers = () => {
    if (!serverQueueDrained) return;
    // Friend-mesh pending hellos — pendingFriendSync entries are composite
    // peer keys (userId|deviceId). We send one sync_hello per device of
    // each friend, mirroring how the self-mesh works.
    Array.from(pendingFriendSync).forEach((peerKey) => {
      if (!peerMesh.canSend(peerKey)) return;
      if (syncedFriends.has(peerKey)) {
        pendingFriendSync.delete(peerKey);
        return;
      }
      pendingFriendSync.delete(peerKey);
      const peerUserId = peerKey.split("|")[0] || "";
      void sendSyncHello(peerKey, {
        scope: SCOPE_FRIEND,
        peerUserId,
      });
    });
    // Self-mesh pending hellos.
    Array.from(pendingSelfSync.entries()).forEach(([deviceId, peerUserId]) => {
      if (!canSendSelf(deviceId)) return;
      if (syncedSelfDevices.has(deviceId)) {
        pendingSelfSync.delete(deviceId);
        return;
      }
      pendingSelfSync.delete(deviceId);
      void sendSyncHello(deviceId, {
        scope: SCOPE_SELF,
        peerUserId,
      });
    });
  };

  // When a peer drops unexpectedly, ask the relay to re-pair us. We only
  // retry if the connection had previously reached "connected" — otherwise
  // the network likely blocks WebRTC outright and retrying in a tight loop is
  // pointless. Intentional closes (server_disconnect, stale_replaced) are
  // skipped. `forgetSync` drops the per-peer sync state so a reconnect re-runs
  // sync_hello on the fresh data channel.
  const createPeerClosedHandler = (forgetSync) =>
    ({ peerUserId, peerKey, reason, wasConnected }) => {
      forgetSync(peerKey);
      if (!wasConnected) return;
      if (reason === "server_disconnect" || reason === "stale_replaced") return;
      requestPeerConnectionIfNeeded(
        peerUserId,
        "Retrying peer connection after unexpected close"
      );
    };

  // --- Friend mesh --------------------------------------------------------

  const peerMesh = createPeerMesh({
    // Composite friend keys include `${myUserId}|${myDeviceId}` for our own
    // identity — `getLocalKey` is only consulted to guard against creating
    // a peer for ourselves, and the server never emits peer_connect for
    // our own (userId, deviceId), so leaving this empty is safe. We keep
    // the function so future per-device guards can be added cheaply.
    getLocalKey: () => "",
    getStunServers: () => currentSnapshot?.stunServers || [],
    sendSignal: (peerKey, signal, ctx) => {
      // Friend mesh: peerKey is composite (userId|deviceId). Routing only
      // needs the userId+deviceId pair, which we read from ctx.
      signalingClient.sendPeerSignal(
        ctx?.peerUserId || "",
        ctx?.peerDeviceId || "",
        signal,
      );
    },
    onPeerReady: ({ peerKey, peerUserId }) => {
      if (peerUserId) void updateLastSyncedAt(peerUserId);
      pendingFriendSync.add(peerKey);
      trySyncPendingPeers();
      // Flush any queued outbox messages to the newly connected peer.
      void flushOutbox();
    },
    // Friend mesh status is exposed to the UI as a set of *user ids* (the
    // UI doesn't know about devices). Multiple connected devices for the
    // same friend collapse to one entry.
    onPeerStatusChange: () => {
      replaceConnectedPeerIds(peerMesh.getConnectedPeerUserIds());
    },
    onPeerMessage: ({ peerKey, peerUserId, message }) => {
      void handlePeerMessage(peerKey, peerUserId, message, SCOPE_FRIEND);
    },
    onPeerClosed: createPeerClosedHandler((peerKey) => {
      pendingFriendSync.delete(peerKey);
      syncedFriends.delete(peerKey);
    }),
  });

  // --- Self-mesh ----------------------------------------------------------

  const selfMesh = createPeerMesh({
    // Self-check is a no-op for the self-mesh: the server never emits
    // peer_connect for our own device id, so we leave the local key empty.
    getLocalKey: () => "",
    getStunServers: () => currentSnapshot?.stunServers || [],
    alwaysAllow: true,
    sendSignal: (peerKey, signal, ctx) => {
      // Self-mesh: peerKey is the peer's device id; peerUserId is our own
      // user id (same on both sides), which the server also requires for
      // eligibility checks.
      signalingClient.sendPeerSignal(
        ctx?.peerUserId || currentSnapshot?.userId || "",
        peerKey,
        signal
      );
    },
    onPeerReady: ({ peerKey, peerUserId }) => {
      pendingSelfSync.set(peerKey, peerUserId || currentSnapshot?.userId || "");
      trySyncPendingPeers();
    },
    onPeerStatusChange: (connectedDeviceIds) => {
      replaceConnectedSelfDeviceIds(connectedDeviceIds);
    },
    onPeerMessage: ({ peerKey, peerUserId, message }) => {
      void handlePeerMessage(peerKey, peerUserId || currentSnapshot?.userId || "", message, SCOPE_SELF);
    },
    onPeerClosed: createPeerClosedHandler((peerKey) => {
      pendingSelfSync.delete(peerKey);
      syncedSelfDevices.delete(peerKey);
    }),
  });

  // --- Signaling ----------------------------------------------------------

  const signalingClient = createRelayPool({
    onPeerConnect: ({ peerUserId, peerDeviceId, initiator }) => {
      const myUserId = currentSnapshot?.userId || "";
      if (myUserId && peerUserId === myUserId) {
        // Same user, different device → self-mesh keyed by peerDeviceId.
        if (!peerDeviceId) return;
        selfMesh.ensurePeer(peerDeviceId, {
          initiator,
          peerUserId,
          peerDeviceId,
        });
        // When the device newly appears on a relay, sync through the relay
        // right away instead of waiting to see whether WebRTC connects — it
        // may never, and the exchange is idempotent if the direct channel
        // opens later. Relays repeat peer_connect on every candidate update,
        // so only the first one per presence triggers a sync.
        if (selfDevicesOnRelay.has(peerDeviceId)) return;
        selfDevicesOnRelay.add(peerDeviceId);
        syncedSelfDevices.delete(SELF_RELAY_PEER_KEY);
        pendingSelfSync.set(SELF_RELAY_PEER_KEY, myUserId);
        trySyncPendingPeers();
        return;
      }
      // Different user → friend mesh keyed by `${userId}|${deviceId}` so
      // a friend's multiple devices each get their own WebRTC slot.
      // Track server presence so the UI can show a "partly online" state
      // when the relay sees the friend but WebRTC hasn't established yet.
      addServerPresentPeer(peerUserId, peerDeviceId);
      const peerKey = friendPeerKey(peerUserId, peerDeviceId);
      if (!peerKey) return;
      peerMesh.ensurePeer(peerKey, {
        initiator,
        peerUserId,
        peerDeviceId,
      });
    },
    onPeerDisconnect: ({ peerUserId, peerDeviceId }) => {
      const myUserId = currentSnapshot?.userId || "";
      if (myUserId && peerUserId === myUserId && peerDeviceId) {
        logRealtimeEvent(`Self-device disconnected from server (${peerDeviceId?.slice(0, 8)}…)`);
        selfMesh.closePeer(peerDeviceId);
        syncedSelfDevices.delete(peerDeviceId);
        pendingSelfSync.delete(peerDeviceId);
        selfDevicesOnRelay.delete(peerDeviceId);
        return;
      }
      logRealtimeEvent(`Peer disconnected from server (${peerUserId?.slice(0, 10)}…)`);
      removeServerPresentPeer(peerUserId, peerDeviceId);
      // Close exactly this device's peer record; other devices of the
      // same friend (if any) keep their slots.
      const peerKey = friendPeerKey(peerUserId, peerDeviceId);
      if (peerKey) peerMesh.closePeer(peerKey);
    },
    onPeerSignal: ({ peerUserId, peerDeviceId, signal }) => {
      const myUserId = currentSnapshot?.userId || "";
      if (myUserId && peerUserId === myUserId && peerDeviceId) {
        void selfMesh.handleSignal(peerDeviceId, signal, {
          peerUserId,
          peerDeviceId,
        });
        return;
      }
      const peerKey = friendPeerKey(peerUserId, peerDeviceId);
      if (!peerKey) return;
      void peerMesh.handleSignal(peerKey, signal, {
        peerUserId,
        peerDeviceId,
      });
    },
    onPeerEnvelopeFromServer: ({ envelope }) => {
      const processing = handleServerDeliveredEnvelope(envelope)
        .catch(() => {})
        .finally(() => inflightServerEnvelopes.delete(processing));
      inflightServerEnvelopes.add(processing);
    },
    onSessionReady: () => {
      // The WebSocket just (re-)registered, so any envelopes the server held
      // for us are about to arrive. Forget what we previously asked the server
      // to queue so a server restart doesn't strand undelivered messages.
      envelopesSentToServer.clear();
      // Wait for `queue_drained` before initiating sync_hello so we don't
      // re-request ledger entries the server is about to redeliver.
      serverQueueDrained = false;
      syncedFriends.clear();
      syncedSelfDevices.clear();
      void syncRealtimeState();
    },
    onQueueDrained: async () => {
      await Promise.all(Array.from(inflightServerEnvelopes));
      logRealtimeEvent("Server queue drained");
      serverQueueDrained = true;
      trySyncPendingPeers();
      // Held-back offline sends go out now, with a snapshot that includes what
      // the queue delivered (see the drain check in flushOutbox).
      void syncRealtimeState();
    },
  });

  const requestPeerConnectionIfNeeded = (peerUserId, logTitle = "Requesting peer connection") => {
    if (!peerUserId) return;
    // Skip if any device of this user is already connected or mid-handshake
    // — the server will fan out new peer_connects for additional devices on
    // its own. Our own user id (used by the self-mesh retry) means "pair me
    // with my other devices"; the server answers with a peer_connect per
    // other device, or nothing if none are online.
    const mesh = peerUserId === currentSnapshot?.userId ? selfMesh : peerMesh;
    if (mesh.findAnyPeerKeyByUserId(peerUserId)) {
      return;
    }

    logRealtimeEvent(`${logTitle} (${peerUserId?.slice(0, 10)}…)`);
    signalingClient.requestPeerConnection(peerUserId);
  };

  const flushOutbox = async () => {
    if (!currentSnapshot) {
      return;
    }

    const keyProvider = currentSnapshot.keyProvider;
    if (!keyProvider) {
      return;
    }

    for (const message of currentSnapshot.outbox) {
      // Resolve to the composite peerKey of *any* connected device of the
      // recipient. If the recipient runs on multiple devices, sending to one
      // is enough — their self-mesh replicates within their devices.
      const directPeerKey = peerMesh.findOpenPeerKeyByUserId(message.to_user_id);
      const directlyConnected = Boolean(directPeerKey);
      if (directlyConnected && peerMesh.hasInflightMessage(directPeerKey, message.id)) {
        continue;
      }
      if (!directlyConnected && envelopesSentToServer.has(message.id)) {
        continue;
      }
      // Offline sends wait until the server's held envelopes are applied: one
      // of them may be the recipient's newer notification_prefs, which decides
      // whether this message gets a push hint (notification-policy.js).
      if (!directlyConnected && !serverQueueDrained) {
        continue;
      }

      let envelope;
      try {
        envelope = await wrapPeerMessage(message, { keyProvider });
      } catch (error) {
        logRealtimeEvent(
          `Failed to wrap outgoing message ${message.id?.slice(0, 10)}…: ${String(error?.message || error)}`
        );
        continue;
      }

      if (directlyConnected) {
        peerMesh.sendPeerMessage(directPeerKey, envelope);
        continue;
      }

      // Offline path: attach an encrypted OS-notification hint so the relay can
      // wake the recipient via Web Push without ever seeing the plaintext. Only
      // types the recipient enabled get one (see notification-policy.js).
      const hint = buildOsNotificationHint(message, {
        senderName: currentSnapshot.userName,
        recipientTypes: currentSnapshot.peerOsNotifyTypes?.[message.to_user_id],
      });
      if (hint) {
        try {
          envelope.push_hint = await keyProvider.nip44Encrypt(
            message.to_user_id,
            JSON.stringify(hint)
          );
        } catch (error) {
          logRealtimeEvent(
            `Failed to encrypt push hint for ${message.to_user_id?.slice(0, 10)}…: ${String(error?.message || error)}`
          );
        }
      }

      const queued = signalingClient.queuePeerEnvelopeOnServer(envelope);
      if (queued) {
        envelopesSentToServer.add(message.id);
        logRealtimeEvent(
          `Queued peer envelope on server → ${message.to_user_id?.slice(0, 10)}…`
        );
      }
    }
  };

  // Broadcasts locally-added ledger entries to every connected self-device.
  // Called from syncRealtimeState after the snapshot refreshes, so the
  // ledger we iterate is the one that was just persisted.
  const broadcastNewLedgerEntriesToSelfDevices = async () => {
    if (!currentSnapshot) return;
    const freshEntries = currentSnapshot.ledger.filter(
      (entry) => entry?.id && !broadcastedLedgerIds.has(entry.id)
    );
    if (freshEntries.length === 0) return;
    // Marked even when nobody is listening, so future sends don't re-push
    // the entire ledger the moment a self-device connects (sync_hello
    // covers catching up).
    freshEntries.forEach((entry) => broadcastedLedgerIds.add(entry.id));

    const targets = [];
    selfMesh.forEachConnectedPeer(({ peerKey }) => targets.push(peerKey));
    if (hasSelfDeviceWithoutChannel()) targets.push(SELF_RELAY_PEER_KEY);
    if (targets.length === 0) return;

    for (const peerKey of targets) {
      await sendSyncMessage(
        peerKey,
        { scope: SCOPE_SELF },
        PEER_MESSAGE_TYPE_SYNC_DATA,
        { entries: freshEntries },
        currentSnapshot.userId,
      );
    }
    logRealtimeEvent(`Broadcast ${freshEntries.length} ledger entries to self-devices (${targets.length} path(s))`);
  };

  const syncRealtimeState = async () => {
    currentSnapshot = await getRealtimeSnapshot();
    if (!currentSnapshot) {
      signalingClient.setRelays([]);
      signalingClient.setSession({ userId: "", deviceId: "", peerIds: [] });
      peerMesh.closePeersNotMatching(() => false);
      selfMesh.closePeersNotInSet([]);
      selfDevicesOnRelay.clear();
      replaceConnectedPeerIds([]);
      replaceConnectedSelfDeviceIds([]);
      clearServerPresentPeers();
      return;
    }

    // Reconcile the relay pool first: any newly-added relays open their
    // sockets here and any removed ones close cleanly. setSession then runs
    // against the current set.
    signalingClient.setRelays(currentSnapshot.relays);
    signalingClient.setSession({
      userId: currentSnapshot.userId,
      deviceId: currentSnapshot.deviceId,
      peerIds: currentSnapshot.peerIds,
    });
    // Friend-mesh keys are composite (userId|deviceId) but the snapshot
    // eligibility set is user-id based — keep every device-peer whose
    // user id is still in the friend snapshot.
    const allowedFriendUserIds = new Set(currentSnapshot.peerIds);
    peerMesh.closePeersNotMatching(({ peerUserId }) => allowedFriendUserIds.has(peerUserId));
    // Self-mesh never closes on snapshot (alwaysAllow=true) — passing an
    // empty set just updates internal bookkeeping harmlessly.
    selfMesh.closePeersNotInSet([]);

    currentSnapshot.peerIds.forEach((peerUserId) => {
      requestPeerConnectionIfNeeded(peerUserId);
    });
    await flushOutbox();
    await broadcastNewLedgerEntriesToSelfDevices();
  };

  const pendingPings = new Map();

  const handleReceiptMessage = async (receiptMessage) => {
    const receivedMessageId =
      typeof receiptMessage.payload?.message_id === "string"
        ? receiptMessage.payload.message_id.trim()
        : "";
    if (!receivedMessageId) {
      return;
    }

    logRealtimeEvent(`Receipt received for msg ${receivedMessageId?.slice(0, 10)}…`);
    peerMesh.clearInflightMessage(receivedMessageId);
    envelopesSentToServer.delete(receivedMessageId);
    await markPeerMessageReceived(receivedMessageId);
    await syncRealtimeState();
  };

  const sendReceiptForInnerMessage = async (innerMessage, acknowledgeResult, preferredPeerKey) => {
    if (!acknowledgeResult || !currentSnapshot?.userId) {
      return;
    }

    const receipt = createPeerReceiptMessage({
      fromUserId: currentSnapshot.userId,
      toUserId: innerMessage.from_user_id,
      messageId: innerMessage.id,
      result: acknowledgeResult,
    });

    // Prefer replying on the same WebRTC channel we received on (composite
    // peer key for the friend mesh), then fall back to any open device-peer
    // of the sender's user. Self-mesh receipts are a no-op: the sender sees
    // its own broadcast land on its own ledger, no ack needed.
    if (preferredPeerKey && peerMesh.canSend(preferredPeerKey)) {
      peerMesh.sendControlMessage(preferredPeerKey, receipt);
      logRealtimeEvent(`Sent receipt via WebRTC (preferred channel)`);
      return;
    }
    const fallbackKey = peerMesh.findOpenPeerKeyByUserId(innerMessage.from_user_id);
    if (fallbackKey) {
      peerMesh.sendControlMessage(fallbackKey, receipt);
      logRealtimeEvent(`Sent receipt via WebRTC (fallback channel)`);
      return;
    }

    // No live data channel — wrap the receipt as an envelope and let the
    // signaling server hold it until the original sender comes back online.
    if (!currentSnapshot.keyProvider) {
      return;
    }

    try {
      const envelope = await wrapPeerMessage(receipt, {
        keyProvider: currentSnapshot.keyProvider,
      });
      const queued = signalingClient.queuePeerEnvelopeOnServer(envelope);
      logRealtimeEvent(queued ? "Queued peer receipt on server" : "Peer receipt queue rejected by server");
    } catch (error) {
      logRealtimeEvent(`Failed to wrap receipt for server: ${String(error?.message || error)}`);
    }
  };

  const processInnerPeerMessage = async (
    innerMessage,
    { receiptChannelPeerKey, scope = SCOPE_FRIEND, peerKey, peerUserId } = {}
  ) => {
    switch (innerMessage.type) {
      case PEER_MESSAGE_TYPE_RECEIVED:
        await handleReceiptMessage(innerMessage);
        return;
      case PEER_MESSAGE_TYPE_SYNC_HELLO:
        await handleSyncHello(peerKey, innerMessage.payload, {
          scope,
          peerUserId: peerUserId || innerMessage.from_user_id,
        });
        return;
      case PEER_MESSAGE_TYPE_SYNC_DATA:
        await handleSyncData(peerKey, innerMessage.payload, {
          scope,
          peerUserId: peerUserId || innerMessage.from_user_id,
        });
        return;
    }

    const processingResult = await applyInboundPeerMessage(innerMessage);
    // Receipts are only meaningful on the friend mesh — a self-device
    // doesn't need one because both sides share the same processed-id set
    // after the sync completes.
    if (scope === SCOPE_FRIEND) {
      await sendReceiptForInnerMessage(
        innerMessage,
        processingResult?.acknowledgeResult,
        receiptChannelPeerKey,
      );
    }
    await syncRealtimeState();
  };

  const handlePeerMessage = async (peerKey, peerUserId, message, scope = SCOPE_FRIEND) => {
    if (!message || typeof message !== "object") {
      return;
    }

    switch (message.type) {
      case PEER_MESSAGE_TYPE_PING: {
        logRealtimeEvent(`Ping received (${scope})`);
        const mesh = scope === SCOPE_SELF ? selfMesh : peerMesh;
        mesh.sendControlMessage(peerKey, {
          type: PEER_MESSAGE_TYPE_PONG,
          timestamp: message.timestamp,
        });
        return;
      }
      case PEER_MESSAGE_TYPE_PONG: {
        const sentAt = message.timestamp;
        const roundTripMs = sentAt ? Date.now() - sentAt : null;
        logRealtimeEvent(`Pong received (${scope}, ${roundTripMs}ms RTT)`);
        const resolve = pendingPings.get(peerKey);
        if (resolve) {
          pendingPings.delete(peerKey);
          resolve(roundTripMs);
        }
        return;
      }
      case PEER_MESSAGE_TYPE_RECEIVED:
        // Plaintext receipt over WebRTC — used as the fast path when both peers
        // have a live data channel. Same handling as a server-delivered receipt.
        await handleReceiptMessage(message);
        return;
    }

    if (!isPeerEnvelope(message)) {
      logRealtimeEvent(`Dropping non-envelope message (${scope}, type: ${message.type})`);
      return;
    }

    const innerMessage = await unwrapEnvelopeOrLog(message, peerKey);
    if (!innerMessage) {
      return;
    }

    await processInnerPeerMessage(innerMessage, {
      receiptChannelPeerKey: scope === SCOPE_FRIEND ? peerKey : "",
      scope,
      peerKey,
      peerUserId,
    });
  };

  const unwrapEnvelopeOrLog = async (envelope, sourcePeerKey) => {
    const keyProvider = currentSnapshot?.keyProvider;
    if (!keyProvider || !currentSnapshot?.userId) {
      return null;
    }

    try {
      return await unwrapPeerEnvelope(envelope, {
        keyProvider,
        expectedRecipientId: currentSnapshot.userId,
      });
    } catch (error) {
      logRealtimeEvent(
        `Failed to unwrap envelope from ${sourcePeerKey?.slice(0, 10)}…: ${String(error?.message || error)}`
      );
      return null;
    }
  };

  const handleServerDeliveredEnvelope = async (envelope) => {
    if (!isPeerEnvelope(envelope)) {
      return;
    }

    logRealtimeEvent(
      `Peer envelope received from server (from ${envelope.from_user_id?.slice(0, 10)}…)`
    );

    const innerMessage = await unwrapEnvelopeOrLog(envelope, envelope.from_user_id);
    if (!innerMessage) {
      return;
    }

    // Self-addressed envelopes are the own-device sync fallback. Only sync
    // messages are expected there; each relay delivers its own copy.
    if (innerMessage.from_user_id === currentSnapshot?.userId) {
      const isSync = [PEER_MESSAGE_TYPE_SYNC_HELLO, PEER_MESSAGE_TYPE_SYNC_DATA]
        .includes(innerMessage.type);
      if (!isSync || seenRelaySyncIds.has(innerMessage.id)) return;
      if (seenRelaySyncIds.size >= SEEN_RELAY_SYNC_IDS_LIMIT) seenRelaySyncIds.clear();
      seenRelaySyncIds.add(innerMessage.id);
      await processInnerPeerMessage(innerMessage, {
        scope: SCOPE_SELF,
        peerKey: SELF_RELAY_PEER_KEY,
        peerUserId: innerMessage.from_user_id,
      });
      return;
    }

    await processInnerPeerMessage(innerMessage, {
      receiptChannelPeerKey: innerMessage.from_user_id,
      scope: SCOPE_FRIEND,
      peerKey: innerMessage.from_user_id,
      peerUserId: innerMessage.from_user_id,
    });
  };

  const unsubscribe = subscribeToDataChanges(() => {
    void syncRealtimeState();
  });

  // Run the one-time ledger migration (no-op after the first deployment).
  // Must complete before the initial snapshot so repaired connections are
  // visible to the signaling layer immediately.
  void runLedgerMigrationIfNeeded().then(() => syncRealtimeState());

  const ping = (nameOrKey) => {
    if (!nameOrKey || !currentSnapshot) {
      console.log("[Ping] No target specified or not connected");
      return Promise.resolve(null);
    }

    const target = String(nameOrKey).trim().toLowerCase();
    // Connected friend user ids — collapses across multiple devices of the
    // same friend so debug pings target the friend (any device).
    const connectedIds = peerMesh.getConnectedPeerUserIds();
    const peerNames = currentSnapshot.peerNames || {};

    // Match by exact public key, key prefix, or friend name
    let peerId = connectedIds.find((id) => id === nameOrKey.trim());

    if (!peerId) {
      peerId = connectedIds.find((id) => {
        const name = (peerNames[id] || "").toLowerCase();
        return name === target || name.startsWith(target) || id.includes(target);
      });
    }

    if (!peerId) {
      console.log(`[Ping] No connected peer matching "${target}". Connected peers:`, connectedIds);
      return Promise.resolve(null);
    }

    const targetPeerKey = peerMesh.findOpenPeerKeyByUserId(peerId);
    if (!targetPeerKey) {
      console.log(`[Ping] Lost peer to ${peerId} between lookup and send`);
      return Promise.resolve(null);
    }

    peerMesh.sendControlMessage(targetPeerKey, {
      type: PEER_MESSAGE_TYPE_PING,
      timestamp: Date.now(),
    });

    return new Promise((resolve) => {
      pendingPings.set(targetPeerKey, resolve);
      setTimeout(() => {
        if (pendingPings.has(targetPeerKey)) {
          pendingPings.delete(targetPeerKey);
          console.log(`[Ping] Timeout — no pong from ${peerId}`);
          resolve(null);
        }
      }, 5000);
    }).then((ms) => {
      if (ms !== null) {
        console.log(`[Ping] ${peerId} responded in ${ms}ms`);
      }
      return ms;
    });
  };

  window.ping = ping;

  const instance = {
    ping,
    // Register/replace this device's Web Push subscription with every relay so
    // offline peer messages can wake it. Called by the settings opt-in flow.
    setPushSubscription: (subscription) => {
      signalingClient.setPushSubscription(subscription);
    },
    sendPushUnsubscribe: (endpoint) => {
      signalingClient.sendPushUnsubscribe(endpoint);
    },
    destroy: () => {
      replaceConnectedPeerIds([]);
      replaceConnectedSelfDeviceIds([]);
      clearServerPresentPeers();
      unsubscribe();
      peerMesh.destroy();
      selfMesh.destroy();
      signalingClient.destroy();
      delete window.ping;
      if (activeRealtimeClient === instance) activeRealtimeClient = null;
    },
  };
  activeRealtimeClient = instance;
  return instance;
};

// Singleton accessor so UI code (e.g. the settings push opt-in) can reach the
// live realtime client without threading the instance through every layer.
let activeRealtimeClient = null;
export const getRealtimeClient = () => activeRealtimeClient;

export {
  createRealtimeClient,
};
