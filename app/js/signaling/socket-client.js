/*
This module owns the browser-side websocket signaling connection used by the
IOU app for online presence and WebRTC signaling.

Signaling is *device-scoped*: every WebRTC offer/answer/candidate must be
routed to a specific remote device, because one user may have multiple
devices connected at the same time (same npub, different WebSocket session).
Each device generates and persists its own `deviceId` once on first app
start (see `app-state.js`) and sends it on `register`. The server uses
that id to route peer_connect / webrtc_signal messages back to the exact
device, and the client threads remote device ids back on outgoing
`webrtc_signal` so ICE candidates reach the peer that sent the offer.

It keeps websocket lifecycle concerns isolated from the peer transport layer,
so higher-level realtime code can focus on peer sessions and queued delivery
instead of reconnect and JSON routing details.
@category network
*/

// First failure retries quickly (transient blip). Every failure after that
// waits 5 minutes — if the relay didn't answer, it's most likely offline
// and hammering it just bloats the console.
// WebSocket message types between client and relay. The other side keeps the
// same list in server/signaling/websocket-server.js; change both together.
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

const RECONNECT_FIRST_MS = 2500;
const RECONNECT_RETRY_MS = 5 * 60 * 1000;

const getDefaultSocketUrl = () => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
};

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

const createSignalingClient = (
  {
    url = "",
    onPeerConnect = null,
    onPeerDisconnect = null,
    onPeerSignal = null,
    onPeerEnvelopeFromServer = null,
    onSessionReady = null,
    onQueueDrained = null,
    onSocketClose = null,
  } = {}
) => {
  const socketUrl = url || getDefaultSocketUrl();
  let socket = null;
  let reconnectTimer = null;
  let consecutiveFailures = 0;
  let destroyed = false;
  let session = {
    userId: "",
    deviceId: "",
    peerIds: [],
  };
  // Web Push subscription for this device, re-sent on every (re)register so a
  // relay that restarts re-learns where to push. Null until the user opts in.
  let pushSubscription = null;

  const clearReconnectTimer = () => {
    if (!reconnectTimer) {
      return;
    }

    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const sendRegistration = ({ notifyReady = false } = {}) => {
    if (!session.userId) {
      return;
    }

    sendJson(socket, {
      type: SignalType.REGISTER,
      user_id: session.userId,
      device_id: session.deviceId,
    });
    sendJson(socket, {
      type: SignalType.PEER_CANDIDATES,
      peer_user_ids: session.peerIds,
    });
    if (pushSubscription) {
      sendJson(socket, {
        type: SignalType.PUSH_SUBSCRIBE,
        subscription: pushSubscription,
      });
    }
    if (notifyReady && typeof onSessionReady === "function") {
      onSessionReady();
    }
  };

  const scheduleReconnect = () => {
    if (reconnectTimer || destroyed) {
      return;
    }

    const delay = consecutiveFailures === 0 ? RECONNECT_FIRST_MS : RECONNECT_RETRY_MS;
    consecutiveFailures += 1;

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (!destroyed) connect();
    }, delay);
  };

  const handleMessage = (event) => {
    const payload = safeParseJson(event.data);
    if (!payload || typeof payload !== "object") {
      return;
    }

    if (payload.type === SignalType.PEER_CONNECT && typeof onPeerConnect === "function") {
      onPeerConnect({
        peerUserId: payload.peer_user_id,
        peerDeviceId: payload.peer_device_id || "",
        initiator: payload.initiator === true,
      });
      return;
    }

    if (payload.type === SignalType.PEER_DISCONNECT && typeof onPeerDisconnect === "function") {
      onPeerDisconnect({
        peerUserId: payload.peer_user_id,
        peerDeviceId: payload.peer_device_id || "",
      });
      return;
    }

    if (payload.type === SignalType.WEBRTC_SIGNAL && typeof onPeerSignal === "function") {
      onPeerSignal({
        peerUserId: payload.peer_user_id,
        peerDeviceId: payload.peer_device_id || "",
        signal: payload.signal || null,
      });
      return;
    }

    if (payload.type === SignalType.PEER_ENVELOPE && typeof onPeerEnvelopeFromServer === "function") {
      onPeerEnvelopeFromServer({
        envelope: payload.envelope || null,
      });
      return;
    }

    if (payload.type === SignalType.QUEUE_DRAINED && typeof onQueueDrained === "function") {
      onQueueDrained();
    }
  };

  const connect = () => {
    socket = new WebSocket(socketUrl);

    socket.addEventListener("open", () => {
      clearReconnectTimer();
      consecutiveFailures = 0;
      sendRegistration({ notifyReady: true });
    });

    socket.addEventListener("message", handleMessage);

    socket.addEventListener("close", () => {
      if (typeof onSocketClose === "function") {
        try { onSocketClose(); } catch { /* ignore */ }
      }
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // The browser logs "WebSocket connection failed" itself — nothing to
      // add here. The "close" event fires automatically after an error and
      // schedules the next reconnect attempt via scheduleReconnect().
    });
  };

  connect();

  return {
    setSession: ({ userId = "", deviceId = "", peerIds = [] } = {}) => {
      session = {
        userId: typeof userId === "string" ? userId.trim() : "",
        deviceId: typeof deviceId === "string" ? deviceId.trim() : "",
        peerIds: normalizePeerIds(peerIds),
      };

      if (socket?.readyState === WebSocket.OPEN) {
        sendRegistration();
      }
    },
    requestPeerConnection: (peerUserId) => {
      const normalizedPeerUserId =
        typeof peerUserId === "string" ? peerUserId.trim() : "";
      if (!normalizedPeerUserId) {
        return;
      }

      sendJson(socket, {
        type: SignalType.CONNECT_PEER,
        peer_user_id: normalizedPeerUserId,
      });
    },
    sendPeerSignal: (peerUserId, peerDeviceId, signal) => {
      const normalizedPeerUserId =
        typeof peerUserId === "string" ? peerUserId.trim() : "";
      const normalizedPeerDeviceId =
        typeof peerDeviceId === "string" ? peerDeviceId.trim() : "";
      if (!normalizedPeerUserId || !signal) {
        return;
      }

      sendJson(socket, {
        type: SignalType.WEBRTC_SIGNAL,
        peer_user_id: normalizedPeerUserId,
        peer_device_id: normalizedPeerDeviceId,
        signal,
      });
    },
    queuePeerEnvelopeOnServer: (envelope) => {
      if (!envelope || typeof envelope !== "object") {
        return false;
      }

      return sendJson(socket, {
        type: SignalType.QUEUE_PEER_ENVELOPE,
        envelope,
      });
    },
    setPushSubscription: (subscription) => {
      pushSubscription = subscription || null;
      if (pushSubscription && socket?.readyState === WebSocket.OPEN) {
        sendJson(socket, { type: SignalType.PUSH_SUBSCRIBE, subscription: pushSubscription });
      }
    },
    sendPushUnsubscribe: (endpoint) => {
      pushSubscription = null;
      if (endpoint && socket?.readyState === WebSocket.OPEN) {
        sendJson(socket, { type: SignalType.PUSH_UNSUBSCRIBE, endpoint });
      }
    },
    destroy: () => {
      destroyed = true;
      clearReconnectTimer();
      socket?.close();
      socket = null;
    },
  };
};

export {
  createSignalingClient,
};
