/*
This module owns the backend websocket signaling server for the IOU app. It
keeps track of online devices, their eligible peer targets, and the signaling
messages needed to establish direct WebRTC sessions.

A single user may be connected from multiple devices at the same time. Each
device generates and persists its own `deviceId` client-side on first start
and sends it in the `register` message. The server uses that id for routing
peer_connect / webrtc_signal messages back to the exact device. A stable id
across reconnects (and, later, across multiple relay servers) lets dedup work
on (userId, deviceId) instead of churning on every reconnect.

For legacy clients that don't include a `device_id`, the server mints one
(via randomUUID) so older builds keep working during rollout.

The server intentionally limits itself to presence and offer/answer/ICE
routing. Once peers are connected, application data stays on the WebRTC data
channel and the websocket layer only needs to reconnect or re-initiate peer
setup when availability changes.

Cross-user peering uses the existing `peer_candidates` eligibility rule
(mutual opt-in). Same-user device pairs are *always* eligible — the user
naturally trusts their own other devices, and they sync ledger state over
WebRTC the same way peers do during recovery. When WebRTC can't connect them,
self-addressed envelopes carry that sync through this server instead (see
handleQueuePeerEnvelope).
*/

const { WebSocket, WebSocketServer } = require("ws");
const { randomUUID } = require("crypto");
const { createPushService } = require("../push/push-service");

const SIGNALING_PATH = "/ws";

const safeParseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const sendJson = (socket, payload) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  socket.send(JSON.stringify(payload));
  return true;
};

const normalizePeerIds = (peerIds) => {
  if (!Array.isArray(peerIds)) {
    return [];
  }

  return Array.from(
    new Set(
      peerIds
        .map((peerId) => (typeof peerId === "string" ? peerId.trim() : ""))
        .filter(Boolean)
    )
  );
};

// The server stores opaque ciphertext envelopes for offline recipients so peers
// can hand off messages without waiting for both sides to be online at once.
// Envelopes are kept in memory only; on restart any undelivered messages are
// lost and the senders' client outboxes will eventually re-queue them.
// WebSocket message types between client and relay. The other side keeps the
// same list in app/js/signaling/socket-client.js; change both together.
const SignalType = Object.freeze({
  REGISTER: "register",
  PEER_CANDIDATES: "peer_candidates",
  CONNECT_PEER: "connect_peer",
  WEBRTC_SIGNAL: "webrtc_signal",
  QUEUE_PEER_ENVELOPE: "queue_peer_envelope",
  PUSH_SUBSCRIBE: "push_subscribe",
  PUSH_UNSUBSCRIBE: "push_unsubscribe",
  PEER_CONNECT: "peer_connect",
  PEER_DISCONNECT: "peer_disconnect",
  PEER_ENVELOPE: "peer_envelope",
  QUEUE_DRAINED: "queue_drained",
});

// Web Push payload type; the service worker (app/sw.js) reads only its hint.
const PUSH_PAYLOAD_PEER_MESSAGE = "peer_message";

const PER_RECIPIENT_ENVELOPE_LIMIT = 500;

const createSignalingServer = (server) => {
  const websocketServer = new WebSocketServer({ noServer: true });
  const pushService = createPushService();
  const clientsBySocket = new Map();
  // userId -> Set<client>. Multiple devices of the same user coexist here.
  const clientsByUserId = new Map();
  // deviceId -> client. Used to route webrtc_signal to a specific device when
  // a user has more than one online.
  const clientsByDeviceId = new Map();
  const envelopesByRecipient = new Map();

  const getUserClients = (userId) => {
    if (!userId) return [];
    const set = clientsByUserId.get(userId);
    if (!set) return [];
    return Array.from(set);
  };

  const addUserClient = (userId, client) => {
    if (!userId || !client) return;
    let set = clientsByUserId.get(userId);
    if (!set) {
      set = new Set();
      clientsByUserId.set(userId, set);
    }
    set.add(client);
  };

  const removeUserClient = (userId, client) => {
    if (!userId || !client) return;
    const set = clientsByUserId.get(userId);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) {
      clientsByUserId.delete(userId);
    }
  };

  const getStoredEnvelopes = (userId) => {
    const existing = envelopesByRecipient.get(userId);
    if (existing) return existing;
    const created = new Map();
    envelopesByRecipient.set(userId, created);
    return created;
  };

  const storeEnvelopeForRecipient = (recipientUserId, envelope) => {
    if (!recipientUserId || !envelope?.id) {
      return;
    }

    const stored = getStoredEnvelopes(recipientUserId);
    if (stored.has(envelope.id)) {
      return;
    }

    if (stored.size >= PER_RECIPIENT_ENVELOPE_LIMIT) {
      // Drop the oldest stored envelope to keep the per-recipient queue bounded.
      const oldestKey = stored.keys().next().value;
      if (oldestKey) {
        stored.delete(oldestKey);
      }
    }

    stored.set(envelope.id, envelope);
  };

  const flushStoredEnvelopes = (client) => {
    if (!client?.userId) {
      return;
    }

    const stored = envelopesByRecipient.get(client.userId);
    if (!stored || stored.size === 0) {
      return;
    }

    Array.from(stored.values()).forEach((envelope) => {
      const delivered = sendJson(client.socket, {
        type: SignalType.PEER_ENVELOPE,
        envelope,
      });
      if (delivered) {
        stored.delete(envelope.id);
      }
    });

    if (stored.size === 0) {
      envelopesByRecipient.delete(client.userId);
    }
  };

  const handleQueuePeerEnvelope = (sendingClient, envelope) => {
    if (!sendingClient?.userId || !envelope || typeof envelope !== "object") {
      return;
    }

    const recipientUserId =
      typeof envelope.to_user_id === "string" ? envelope.to_user_id.trim() : "";
    if (!recipientUserId) {
      return;
    }
    if (!envelope.id || !envelope.from_user_id || !envelope.ciphertext) {
      return;
    }

    // Self-addressed envelopes are the own-device sync fallback for when two
    // devices of the same user can't open a direct WebRTC channel. Deliver
    // them to the sender's *other* online devices only. They're never stored
    // or pushed: a device that comes online later re-runs sync_hello anyway.
    if (recipientUserId === sendingClient.userId) {
      getUserClients(recipientUserId).forEach((recipientClient) => {
        if (recipientClient === sendingClient) return;
        sendJson(recipientClient.socket, { type: SignalType.PEER_ENVELOPE, envelope });
      });
      return;
    }

    // Deliver to every online device of the recipient. Each device's
    // processed_peer_message_ids dedupes the same envelope.id so the
    // overlap is harmless, and it keeps all devices in lock-step even
    // before they've opened a same-user WebRTC channel to each other.
    const recipientClients = getUserClients(recipientUserId);
    let deliveredToAny = false;
    recipientClients.forEach((recipientClient) => {
      const ok = sendJson(recipientClient.socket, {
        type: SignalType.PEER_ENVELOPE,
        envelope,
      });
      if (ok) deliveredToAny = true;
    });

    if (!deliveredToAny) {
      storeEnvelopeForRecipient(recipientUserId, envelope);
      // No device of the recipient is online to receive over WebSocket — wake
      // them with a Web Push. The hint is ciphertext the sender encrypted for
      // the recipient; this server only forwards it. Best-effort: a failed or
      // absent subscription just means no OS notification this time.
      if (envelope.push_hint) {
        pushService
          .sendToUser(recipientUserId, {
            type: PUSH_PAYLOAD_PEER_MESSAGE,
            from_user_id: envelope.from_user_id,
            message_id: envelope.id,
            hint: envelope.push_hint,
          })
          .catch(() => {});
      }
    }
  };

  const getClient = (socket) => {
    return clientsBySocket.get(socket) || null;
  };

  const notifyPeersOfDisconnect = (client) => {
    if (!client?.userId) {
      return;
    }

    clientsBySocket.forEach((otherClient) => {
      if (!otherClient || otherClient === client) {
        return;
      }

      if (areClientsEligiblePeers(client, otherClient)) {
        sendJson(otherClient.socket, {
          type: SignalType.PEER_DISCONNECT,
          peer_user_id: client.userId,
          peer_device_id: client.deviceId,
        });
      }
    });
  };

  const unregisterClient = (client) => {
    if (!client) {
      return;
    }

    notifyPeersOfDisconnect(client);
    clientsBySocket.delete(client.socket);
    if (client.deviceId) {
      clientsByDeviceId.delete(client.deviceId);
    }
    if (client.userId) {
      removeUserClient(client.userId, client);
    }
  };

  const areClientsEligiblePeers = (leftClient, rightClient) => {
    if (!leftClient?.userId || !rightClient?.userId) {
      return false;
    }

    // Same user, different devices: always eligible — a user's own devices
    // sync ledger state over WebRTC just like peers do.
    if (leftClient.userId === rightClient.userId) {
      return leftClient !== rightClient;
    }

    return (
      leftClient.peerIds.has(rightClient.userId) ||
      rightClient.peerIds.has(leftClient.userId)
    );
  };

  const getInitiatorClient = (leftClient, rightClient) => {
    // Same user: pick by device id so both sides agree deterministically.
    if (leftClient.userId === rightClient.userId) {
      return leftClient.deviceId < rightClient.deviceId ? leftClient : rightClient;
    }

    const leftWantsRight = leftClient.peerIds.has(rightClient.userId);
    const rightWantsLeft = rightClient.peerIds.has(leftClient.userId);

    if (leftWantsRight && !rightWantsLeft) {
      return leftClient;
    }
    if (rightWantsLeft && !leftWantsRight) {
      return rightClient;
    }

    // Tie-break by user id, then by device id for determinism when two
    // devices of the same friend both request each other simultaneously.
    if (leftClient.userId !== rightClient.userId) {
      return leftClient.userId < rightClient.userId ? leftClient : rightClient;
    }
    return leftClient.deviceId < rightClient.deviceId ? leftClient : rightClient;
  };

  const initiatePeerConnection = (leftClient, rightClient) => {
    if (!areClientsEligiblePeers(leftClient, rightClient)) {
      return;
    }

    const initiatorClient = getInitiatorClient(leftClient, rightClient);
    sendJson(leftClient.socket, {
      type: SignalType.PEER_CONNECT,
      peer_user_id: rightClient.userId,
      peer_device_id: rightClient.deviceId,
      initiator: leftClient === initiatorClient,
    });
    sendJson(rightClient.socket, {
      type: SignalType.PEER_CONNECT,
      peer_user_id: leftClient.userId,
      peer_device_id: leftClient.deviceId,
      initiator: rightClient === initiatorClient,
    });
  };

  const syncClientPeers = (sourceClient) => {
    if (!sourceClient?.userId) {
      return;
    }

    clientsBySocket.forEach((otherClient) => {
      if (!otherClient || otherClient === sourceClient) {
        return;
      }

      initiatePeerConnection(sourceClient, otherClient);
    });
  };

  const isValidDeviceId = (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 128;

  const registerClient = (client, userId, deviceId) => {
    const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
    if (!normalizedUserId) {
      return;
    }

    // Determine the deviceId for this client:
    // - prefer the client-provided id (stable across reconnects/servers)
    // - fall back to a server-minted UUID for legacy clients that don't send one
    // - if a different device of the same user already owns this id, evict it
    //   so routing maps stay consistent
    const clientProvided = typeof deviceId === "string" ? deviceId.trim() : "";
    const nextDeviceId = isValidDeviceId(clientProvided) ? clientProvided : randomUUID();
    if (client.deviceId && client.deviceId !== nextDeviceId) {
      clientsByDeviceId.delete(client.deviceId);
    }
    const existing = clientsByDeviceId.get(nextDeviceId);
    if (existing && existing !== client) {
      // Stale entry: another socket previously claimed this id. The new
      // socket is the live owner; drop the old mapping.
      clientsByDeviceId.delete(nextDeviceId);
    }
    client.deviceId = nextDeviceId;
    clientsByDeviceId.set(nextDeviceId, client);

    // Unlike the single-device era, we no longer kick out existing clients
    // for the same user — the server now supports multiple devices per user
    // and same-user pairs get their own WebRTC mesh.
    if (client.userId && client.userId !== normalizedUserId) {
      removeUserClient(client.userId, client);
    }

    client.userId = normalizedUserId;
    addUserClient(normalizedUserId, client);
    flushStoredEnvelopes(client);
    sendJson(client.socket, { type: SignalType.QUEUE_DRAINED });
    syncClientPeers(client);
  };

  const updatePeerCandidates = (client, peerIds) => {
    client.peerIds = new Set(normalizePeerIds(peerIds));
    syncClientPeers(client);
  };

  const handleConnectPeer = (client, peerUserId) => {
    const normalizedPeerUserId =
      typeof peerUserId === "string" ? peerUserId.trim() : "";
    if (!client?.userId || !normalizedPeerUserId) {
      return;
    }

    // Trigger a peer_connect with every device of the requested user id.
    // In the common single-device-per-friend case this is exactly one client.
    getUserClients(normalizedPeerUserId).forEach((targetClient) => {
      initiatePeerConnection(client, targetClient);
    });
  };

  const handlePeerSignal = (client, peerUserId, peerDeviceId, signal) => {
    const normalizedPeerUserId =
      typeof peerUserId === "string" ? peerUserId.trim() : "";
    const normalizedPeerDeviceId =
      typeof peerDeviceId === "string" ? peerDeviceId.trim() : "";
    if (!client?.userId || !normalizedPeerUserId || !signal) {
      return;
    }

    // Prefer device-id routing so two devices of the same user get their
    // own ICE candidates. Fall back to user-id lookup for legacy clients.
    let targetClient = null;
    if (normalizedPeerDeviceId) {
      targetClient = clientsByDeviceId.get(normalizedPeerDeviceId) || null;
    }
    if (!targetClient) {
      const candidates = getUserClients(normalizedPeerUserId);
      targetClient = candidates.length === 1 ? candidates[0] : null;
    }
    if (!targetClient || !areClientsEligiblePeers(client, targetClient)) {
      return;
    }

    sendJson(targetClient.socket, {
      type: SignalType.WEBRTC_SIGNAL,
      peer_user_id: client.userId,
      peer_device_id: client.deviceId,
      signal,
    });
  };

  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (requestUrl.pathname !== SIGNALING_PATH) {
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (clientSocket) => {
      websocketServer.emit("connection", clientSocket, request);
    });
  });

  websocketServer.on("connection", (socket) => {
    // deviceId is now provided by the client on `register` so it stays stable
    // across reconnects and across relay servers. We keep a server-minted
    // fallback for transitional compatibility with older clients.
    const client = {
      socket,
      deviceId: "",
      userId: "",
      peerIds: new Set(),
    };
    clientsBySocket.set(socket, client);

    socket.on("message", (rawMessage) => {
      const payload = safeParseJson(rawMessage.toString());
      if (!payload || typeof payload !== "object") {
        return;
      }

      if (payload.type === SignalType.REGISTER) {
        registerClient(client, payload.user_id, payload.device_id);
        return;
      }

      if (payload.type === SignalType.PEER_CANDIDATES) {
        updatePeerCandidates(client, payload.peer_user_ids);
        return;
      }

      if (payload.type === SignalType.CONNECT_PEER) {
        handleConnectPeer(client, payload.peer_user_id);
        return;
      }

      if (payload.type === SignalType.WEBRTC_SIGNAL) {
        handlePeerSignal(
          client,
          payload.peer_user_id,
          payload.peer_device_id,
          payload.signal
        );
        return;
      }

      if (payload.type === SignalType.QUEUE_PEER_ENVELOPE) {
        handleQueuePeerEnvelope(client, payload.envelope);
        return;
      }

      if (payload.type === SignalType.PUSH_SUBSCRIBE) {
        // Bind the subscription to this user so offline envelopes can wake the
        // device. We require a registered userId so a push can be routed.
        if (client.userId && payload.subscription) {
          pushService.addSubscription(client.userId, payload.subscription);
        }
        return;
      }

      if (payload.type === SignalType.PUSH_UNSUBSCRIBE) {
        const endpoint =
          typeof payload.endpoint === "string" ? payload.endpoint : payload.subscription?.endpoint;
        if (client.userId && endpoint) {
          pushService.removeSubscription(client.userId, endpoint);
        }
      }
    });

    socket.on("close", () => {
      unregisterClient(client);
    });

    socket.on("error", () => {
      socket.close();
    });
  });

  return { websocketServer, pushService };
};

module.exports = {
  createSignalingServer,
};
