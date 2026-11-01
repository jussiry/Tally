/*
This module manages WebRTC peer connections and JSON data channels between
eligible IOU clients. It's used for two parallel overlays:

  1. Friend mesh — one peer per (friend user id, friend device id) pair.
     The key is `${peerUserId}|${peerDeviceId}` so a friend running on
     multiple devices keeps a separate slot per device.
  2. Self-mesh — one peer per *other device* of the same user (the key is
     the peer device id; peerUserId is always my own npub).

Both overlays are instances of `createPeerMesh` with different `peerKey`
conventions. The mesh is agnostic to the key's meaning — it just maps a
key to an RTCPeerConnection + data channel, and every signalling message
carries both `peerUserId` and `peerDeviceId` so the server can route to
the exact remote device even when a user has several connected.

For call sites that think in user ids (e.g. "deliver this message to
friend X"), `findOpenPeerKeyByUserId` / `findAnyPeerKeyByUserId` resolve
a user id to a current peer key.

Offer/answer negotiation follows the "perfect negotiation" pattern: the
non-initiator side is treated as polite and yields during simultaneous
offer collisions (e.g. during an ICE restart). Because the signaling
server assigns exactly one initiator per connection — deterministically
picked from peer device ids — both sides always agree on who yields
without any extra coordination.
@category network
*/

// Build the RTCPeerConnection config from the user's configured STUN servers.
// STUN lets each peer discover its server-reflexive (`srflx`) address, which is
// what gets the majority of cross-NAT connections to connect directly.
//
// There is intentionally NO TURN server: when a direct P2P connection can't be
// formed (e.g. symmetric NAT / CGNAT on cellular), the encrypted-envelope relay
// server already carries messages between peers, covering the same need without
// a separate TURN relay to host and maintain.
const buildRtcConfiguration = (stunServers) => {
  const urls = (Array.isArray(stunServers) ? stunServers : []).filter(Boolean);
  return urls.length > 0 ? { iceServers: [{ urls }] } : { iceServers: [] };
};

const DATA_CHANNEL_LABEL = "iou-json";

// Why a peer connection closed, as onPeerClosed reports it. client.js retries
// unexpected closes and skips the deliberate ones (server disconnect, replaced
// by a newer connection). A failed connection reports its RTC state instead.
export const PeerCloseReason = Object.freeze({
  CHANNEL_CLOSED: "channel_closed",
  STALE_REPLACED: "stale_replaced",
  DISCONNECTED_TIMEOUT: "disconnected_timeout",
  WAKE_FROM_SUSPEND: "wake_from_suspend",
  SERVER_DISCONNECT: "server_disconnect",
});

// The two kinds of WebRTC signal relayed between peers.
const SignalKind = Object.freeze({
  DESCRIPTION: "description",
  CANDIDATE: "candidate",
});

// How long a peer is allowed to linger in the "disconnected" state while we
// try an ICE restart before we give up and tear the connection down.
const PEER_GRACE_PERIOD_MS = 10000;
// Wake-from-suspend detector. A setInterval tick that's more than
// WAKE_GAP_THRESHOLD_MS late means the tab/device was suspended (laptop lid
// closed, mobile screen off, OS throttled the tab). On wake, existing
// RTCPeerConnections report stale state for several seconds before their
// underlying ICE events catch up, and any signaling that arrived during
// suspend is applied against a stale PC. Tearing down all peers on wake
// lets the normal reconnect flow rebuild them cleanly.
const WAKE_CHECK_INTERVAL_MS = 1000;
const WAKE_GAP_THRESHOLD_MS = 5000;

const safeParseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

// One-line WebRTC log. Call sites are responsible for composing a useful
// single string — pick the one detail that matters (reason, state, peer)
// and let the noise fall away. No object payloads: console logs flood fast
// during ICE and SDP exchanges, and objects are hard to scan.
const logPeerEvent = (message) => {
  console.log(`[WebRTC] ${message}`);
};

// Compact a long identifier (npub, device UUID, message id) for log output.
// npub keys are ~63 chars, UUIDs are 36 — the first 10 chars are almost
// always unique enough to correlate across log lines.
const shortKey = (key) => {
  if (typeof key !== "string" || !key) return "—";
  if (key.length <= 12) return key;
  return `${key.slice(0, 10)}…`;
};

const createPeerMesh = (
  {
    // Returns the local key ("self identifier"), used only as a sanity
    // check so we never create a peer for our own key. For the friend mesh
    // this is our own user id; for the self-mesh it can stay empty — the
    // server already guarantees we never get a peer_connect for our own
    // device.
    getLocalKey = () => "",
    // Returns the current STUN server URL list (from the realtime snapshot, so
    // settings edits take effect on the next connection without a reload).
    getStunServers = () => [],
    sendSignal = (_peerKey, _signal, _route) => {},
    onPeerMessage = null,
    onPeerReady = null,
    onPeerStatusChange = null,
    // Fired after a peer is removed from the mesh. The caller can use the
    // reason + `wasConnected` flag to decide whether to ask the server for
    // a fresh connection attempt. We only pass `wasConnected: true` when
    // the connection reached the "connected" state at some point, which
    // filters out cases where the network fundamentally blocks WebRTC
    // (ICE fails outright without ever establishing).
    onPeerClosed = null,
    // If true, `closePeersNotInSet` is a no-op. Used by the self-mesh:
    // same-user devices aren't in the friend snapshot, so the snapshot-
    // driven cleanup doesn't apply to them.
    alwaysAllow = false,
  } = {}
) => {
  const resolveLocalKey = typeof getLocalKey === "function" ? getLocalKey : () => "";
  const peers = new Map();

  const getConnectedPeerKeys = () => {
    return Array.from(peers.values())
      .filter((peer) => peer?.channel?.readyState === "open")
      .map((peer) => peer.peerKey)
      .filter(Boolean);
  };

  const notifyPeerStatusChange = () => {
    if (typeof onPeerStatusChange === "function") {
      onPeerStatusChange(getConnectedPeerKeys());
    }
  };

  const notifyPeerReady = (peer) => {
    if (typeof onPeerReady === "function") {
      onPeerReady({
        peerKey: peer.peerKey,
        peerUserId: peer.peerUserId,
        peerDeviceId: peer.peerDeviceId,
      });
    }
  };

  const clearDisconnectTimer = (peer) => {
    if (!peer?.disconnectTimer) {
      return;
    }

    window.clearTimeout(peer.disconnectTimer);
    peer.disconnectTimer = null;
  };

  const closePeer = (peerKey, detail = {}) => {
    const peer = peers.get(peerKey);
    if (!peer) {
      return;
    }

    clearDisconnectTimer(peer);
    logPeerEvent(
      `Closing ${shortKey(peerKey)} — ${detail.reason || "no reason"}`
    );
    peer.channel?.close();
    peer.connection?.close();
    peers.delete(peerKey);
    notifyPeerStatusChange();

    if (typeof onPeerClosed === "function") {
      onPeerClosed({
        peerKey,
        peerUserId: peer.peerUserId,
        peerDeviceId: peer.peerDeviceId,
        reason: detail.reason || "",
        wasConnected: peer.wasConnected === true,
      });
    }
  };

  const bindChannel = (peerKey, channel) => {
    const peer = peers.get(peerKey);
    if (!peer) {
      return;
    }

    peer.channel = channel;
    channel.addEventListener("open", () => {
      logPeerEvent(`Channel open with ${shortKey(peerKey)}`);
      notifyPeerStatusChange();
      notifyPeerReady(peer);
    });
    channel.addEventListener("close", () => {
      logPeerEvent(`Channel closed with ${shortKey(peerKey)}`);
      peer.inflightMessageIds.clear();
      peer.channel = null;
      clearDisconnectTimer(peer);
      notifyPeerStatusChange();
      if (peers.get(peerKey) !== peer) {
        return;
      }

      closePeer(peerKey, {
        reason: PeerCloseReason.CHANNEL_CLOSED,
      });
    });
    channel.addEventListener("message", (event) => {
      const message = safeParseJson(event.data);
      logPeerEvent(
        `Received ${message?.type || "data"} from ${shortKey(peerKey)}`
      );
      if (!message || typeof onPeerMessage !== "function") {
        return;
      }

      onPeerMessage({
        peerKey,
        peerUserId: peer.peerUserId,
        peerDeviceId: peer.peerDeviceId,
        message,
      });
    });
  };

  const dispatchSignal = (peer, signal) => {
    sendSignal(peer.peerKey, signal, {
      peerUserId: peer.peerUserId,
      peerDeviceId: peer.peerDeviceId,
    });
  };

  const ensurePeer = (peerKey, {
    initiator = false,
    peerUserId = "",
    peerDeviceId = "",
  } = {}) => {
    const normalizedPeerKey =
      typeof peerKey === "string" ? peerKey.trim() : "";
    if (!normalizedPeerKey || normalizedPeerKey === resolveLocalKey()) {
      return null;
    }

    if (peers.has(normalizedPeerKey)) {
      const existingPeer = peers.get(normalizedPeerKey);
      // Refresh metadata in case the remote device's id/user id arrived
      // in a later signal (e.g. the first peer_connect landed without it).
      if (peerUserId) existingPeer.peerUserId = peerUserId;
      if (peerDeviceId) existingPeer.peerDeviceId = peerDeviceId;
      const state = existingPeer.connection?.connectionState;
      if (state === "closed" || state === "failed") {
        logPeerEvent(
          `Replacing stale peer ${shortKey(normalizedPeerKey)} (${state})`
        );
        closePeer(normalizedPeerKey, { reason: PeerCloseReason.STALE_REPLACED });
      } else {
        return existingPeer;
      }
    }

    const connection = new RTCPeerConnection(
      buildRtcConfiguration(
        typeof getStunServers === "function" ? getStunServers() : []
      )
    );
    // Perfect negotiation: the non-initiator yields during offer collisions
    // (e.g. on ICE restart). The server deterministically picks exactly one
    // initiator per connection, so both sides always disagree on isPolite.
    const isPolite = !initiator;
    const peer = {
      peerKey: normalizedPeerKey,
      peerUserId: typeof peerUserId === "string" ? peerUserId : "",
      peerDeviceId: typeof peerDeviceId === "string" ? peerDeviceId : "",
      connection,
      channel: null,
      isPolite,
      inflightMessageIds: new Set(),
      pendingCandidates: [],
      makingOffer: false,
      disconnectTimer: null,
      // Flipped to true the first time the RTCPeerConnection reaches the
      // "connected" state. Used by onPeerClosed listeners to distinguish
      // between "network was working but dropped" (worth retrying) and
      // "connection never established" (network likely blocks WebRTC).
      wasConnected: false,
    };
    peers.set(normalizedPeerKey, peer);
    logPeerEvent(
      `Establishing ${initiator ? "outbound" : "inbound"} peer ${shortKey(normalizedPeerKey)}`
    );

    // Perfect negotiation: onnegotiationneeded handles both initial offers and
    // ICE restarts. setLocalDescription() with no args creates offer or answer
    // as appropriate for the current signaling state.
    connection.addEventListener("negotiationneeded", async () => {
      try {
        peer.makingOffer = true;
        await connection.setLocalDescription();
        logPeerEvent(`Sending offer to ${shortKey(normalizedPeerKey)}`);
        dispatchSignal(peer, {
          type: SignalKind.DESCRIPTION,
          description: connection.localDescription,
        });
      } catch (error) {
        logPeerEvent(
          `Offer failed for ${shortKey(normalizedPeerKey)}: ${String(error?.message || error)}`
        );
      } finally {
        peer.makingOffer = false;
      }
    });

    connection.addEventListener("icecandidate", (event) => {
      if (!event.candidate) {
        return;
      }

      dispatchSignal(peer, {
        type: SignalKind.CANDIDATE,
        candidate: event.candidate,
      });
    });

    connection.addEventListener("connectionstatechange", () => {
      logPeerEvent(
        `${shortKey(normalizedPeerKey)} → ${connection.connectionState}`
      );

      if (connection.connectionState === "connected") {
        peer.wasConnected = true;
        clearDisconnectTimer(peer);
        return;
      }

      if (connection.connectionState === "connecting") {
        clearDisconnectTimer(peer);
        return;
      }

      if (connection.connectionState === "disconnected") {
        if (peer.disconnectTimer) {
          return;
        }

        // Attempt ICE restart before giving up. restartIce() fires
        // negotiationneeded which sends a new offer with fresh ICE credentials.
        logPeerEvent(`ICE restart for ${shortKey(normalizedPeerKey)}`);
        try {
          connection.restartIce();
        } catch {
          // restartIce not available — fall through to close after timeout
        }

        peer.disconnectTimer = window.setTimeout(() => {
          peer.disconnectTimer = null;
          if (!peers.has(normalizedPeerKey)) {
            return;
          }
          if (
            connection.connectionState === "connected" ||
            connection.connectionState === "connecting"
          ) {
            return;
          }

          closePeer(normalizedPeerKey, {
            reason: PeerCloseReason.DISCONNECTED_TIMEOUT,
          });
        }, PEER_GRACE_PERIOD_MS);
        return;
      }

      if (["failed", "closed"].includes(connection.connectionState)) {
        closePeer(normalizedPeerKey, {
          reason: connection.connectionState,
        });
      }
    });

    connection.addEventListener("datachannel", (event) => {
      bindChannel(normalizedPeerKey, event.channel);
    });

    if (initiator) {
      const channel = connection.createDataChannel(DATA_CHANNEL_LABEL);
      bindChannel(normalizedPeerKey, channel);
      // createDataChannel triggers negotiationneeded, which sends the initial offer
    }

    return peer;
  };

  const handleDescription = async (peer, description) => {
    if (!peer || !description) {
      return;
    }

    // Perfect negotiation: detect a collision where both sides are trying to offer
    // simultaneously. The impolite peer ignores the incoming offer and keeps its own.
    // The polite peer proceeds — setRemoteDescription implicitly rolls back its
    // in-progress offer so the remote offer can be accepted.
    const offerCollision =
      description.type === "offer" &&
      (peer.makingOffer || peer.connection.signalingState !== "stable");

    if (offerCollision && !peer.isPolite) {
      logPeerEvent(
        `Ignoring colliding offer from ${shortKey(peer.peerKey)} (impolite)`
      );
      return;
    }

    // Guard against stale answers. Applying an answer SDP when the PC is
    // already "stable" (no in-flight local offer) throws InvalidStateError.
    // This happens after a suspend/resume when queued signaling from a prior
    // negotiation arrives against a PC whose state has already settled.
    if (
      description.type === "answer" &&
      peer.connection.signalingState !== "have-local-offer"
    ) {
      logPeerEvent(
        `Ignoring stale answer from ${shortKey(peer.peerKey)} (state: ${peer.connection.signalingState})`
      );
      return;
    }

    logPeerEvent(
      `Received ${description.type} from ${shortKey(peer.peerKey)}`
    );
    await peer.connection.setRemoteDescription(description);

    if (description.type === "offer") {
      await peer.connection.setLocalDescription();
      logPeerEvent(`Sending answer to ${shortKey(peer.peerKey)}`);
      dispatchSignal(peer, {
        type: SignalKind.DESCRIPTION,
        description: peer.connection.localDescription,
      });
    }

    while (peer.pendingCandidates.length) {
      const candidate = peer.pendingCandidates.shift();
      if (!candidate) continue;
      await peer.connection.addIceCandidate(candidate);
    }
  };

  const handleCandidate = async (peer, candidate) => {
    if (!peer || !candidate) {
      return;
    }

    // ICE candidates fire frequently during negotiation; log the candidate
    // type (host, srflx, relay) so tests can verify TURN relay usage.
    const candidateStr = candidate.candidate || "";
    const type = candidateStr.match(/typ\s+\w+/)?.[0]
    logPeerEvent(`ICE candidate from ${shortKey(peer.peerKey)} ${type}`);
    if (!peer.connection.remoteDescription) {
      peer.pendingCandidates.push(candidate);
      return;
    }

    await peer.connection.addIceCandidate(candidate);
  };

  const normalizeKey = (value) =>
    typeof value === "string" ? value.trim() : "";

  // Wake-from-suspend detector: if more than WAKE_GAP_THRESHOLD_MS elapses
  // between ticks, the runtime was frozen (laptop lid, phone sleep, tab
  // throttled). Close every peer so the reconnect flow rebuilds them with
  // fresh PeerConnections instead of reusing ones whose state is stale.
  let lastWakeCheckAt = Date.now();
  const wakeCheckInterval = window.setInterval(() => {
    const now = Date.now();
    const gap = now - lastWakeCheckAt;
    lastWakeCheckAt = now;
    if (gap <= WAKE_GAP_THRESHOLD_MS) {
      return;
    }

    const peerKeys = Array.from(peers.keys());
    if (peerKeys.length === 0) {
      return;
    }

    logPeerEvent(
      `Wake from suspend (gap ${gap}ms), resetting ${peerKeys.length} peer(s)`
    );
    peerKeys.forEach((peerKey) => {
      closePeer(peerKey, { reason: PeerCloseReason.WAKE_FROM_SUSPEND });
    });
  }, WAKE_CHECK_INTERVAL_MS);

  return {
    ensurePeer,
    closePeer: (peerKey) => {
      const normalizedPeerKey = normalizeKey(peerKey);
      if (normalizedPeerKey) {
        closePeer(normalizedPeerKey, { reason: PeerCloseReason.SERVER_DISCONNECT });
      }
    },
    hasPeer: (peerKey) => {
      const normalizedPeerKey = normalizeKey(peerKey);
      if (!normalizedPeerKey) {
        return false;
      }

      return peers.has(normalizedPeerKey);
    },
    handleSignal: async (peerKey, signal, context = {}) => {
      if (!signal || typeof signal !== "object") {
        return;
      }

      const peer = ensurePeer(peerKey, {
        initiator: false,
        peerUserId: context.peerUserId || "",
        peerDeviceId: context.peerDeviceId || "",
      });
      if (!peer) {
        return;
      }

      if (signal.type === SignalKind.DESCRIPTION) {
        await handleDescription(peer, signal.description);
      } else if (signal.type === SignalKind.CANDIDATE) {
        await handleCandidate(peer, signal.candidate);
      }
    },
    canSend: (peerKey) => {
      const peer = peers.get(peerKey);
      return peer?.channel?.readyState === "open";
    },
    hasInflightMessage: (peerKey, messageId) => {
      const peer = peers.get(peerKey);
      if (!peer) {
        return false;
      }

      return peer.inflightMessageIds.has(messageId);
    },
    clearInflightMessage: (messageId) => {
      peers.forEach((peer) => {
        peer.inflightMessageIds.delete(messageId);
      });
    },
    sendPeerMessage: (peerKey, message) => {
      const peer = peers.get(peerKey);
      if (!peer?.channel || peer.channel.readyState !== "open") {
        return false;
      }

      logPeerEvent(
        `Sent ${message?.type || "data"} to ${shortKey(peerKey)}`
      );
      peer.channel.send(JSON.stringify(message));
      if (message?.id) {
        peer.inflightMessageIds.add(message.id);
      }
      return true;
    },
    sendControlMessage: (peerKey, message) => {
      const peer = peers.get(peerKey);
      if (!peer?.channel || peer.channel.readyState !== "open") {
        return false;
      }

      logPeerEvent(
        `Sent control ${message?.type || "data"} to ${shortKey(peerKey)}`
      );
      peer.channel.send(JSON.stringify(message));
      return true;
    },
    // Iterate currently-open peers. The self-mesh uses this to broadcast
    // fresh ledger entries to every other connected device in one pass.
    forEachConnectedPeer: (callback) => {
      peers.forEach((peer) => {
        if (peer?.channel?.readyState !== "open") return;
        callback({
          peerKey: peer.peerKey,
          peerUserId: peer.peerUserId,
          peerDeviceId: peer.peerDeviceId,
        });
      });
    },
    closePeersNotInSet: (allowedPeerKeys) => {
      if (alwaysAllow) return;
      const allowedIds = new Set(Array.isArray(allowedPeerKeys) ? allowedPeerKeys : []);
      Array.from(peers.keys()).forEach((peerKey) => {
        if (!allowedIds.has(peerKey)) {
          closePeer(peerKey);
        }
      });
    },
    // Like `closePeersNotInSet` but filters by an arbitrary peer predicate
    // (e.g. peer.peerUserId membership). Used by the friend mesh whose key is
    // composite (userId|deviceId) but whose snapshot eligibility is user-id
    // based — we want to keep all device-peers of allowed user ids.
    closePeersNotMatching: (predicate) => {
      if (alwaysAllow) return;
      if (typeof predicate !== "function") return;
      Array.from(peers.entries()).forEach(([peerKey, peer]) => {
        let keep = false;
        try {
          keep = predicate({
            peerKey,
            peerUserId: peer.peerUserId || "",
            peerDeviceId: peer.peerDeviceId || "",
          }) === true;
        } catch {
          keep = false;
        }
        if (!keep) {
          closePeer(peerKey);
        }
      });
    },
    // Returns the peerKey of the first peer with an open data channel
    // whose `peerUserId` matches the given user id. Used by call sites that
    // think in user ids ("deliver to friend X") in the multi-device-aware
    // friend mesh.
    findOpenPeerKeyByUserId: (userId) => {
      const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
      if (!normalizedUserId) return "";
      for (const [peerKey, peer] of peers.entries()) {
        if (peer.peerUserId !== normalizedUserId) continue;
        if (peer.channel?.readyState !== "open") continue;
        return peerKey;
      }
      return "";
    },
    // Like `findOpenPeerKeyByUserId` but also matches peers that are mid-
    // handshake (no open channel yet). Used to decide whether to ask the
    // server for a fresh peer_connect.
    findAnyPeerKeyByUserId: (userId) => {
      const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
      if (!normalizedUserId) return "";
      for (const [peerKey, peer] of peers.entries()) {
        if (peer.peerUserId === normalizedUserId) return peerKey;
      }
      return "";
    },
    // Unique user ids that have at least one peer with an open data channel.
    getConnectedPeerUserIds: () => {
      const ids = new Set();
      peers.forEach((peer) => {
        if (peer.channel?.readyState !== "open") return;
        if (peer.peerUserId) ids.add(peer.peerUserId);
      });
      return Array.from(ids);
    },
    destroy: () => {
      Array.from(peers.keys()).forEach((peerKey) => {
        closePeer(peerKey);
      });
      notifyPeerStatusChange();
    },
  };
};

export {
  createPeerMesh,
};
