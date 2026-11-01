/*
Manages the outbound peer message queue (outbox) and message deduplication.

All functions operate on the state object directly. Persistence is handled
by the caller (app-state.js).

Outbound peer messages are Schnorr-signed at queue time. Keeping the
signature in the outbox (rather than producing it only at wrap time) means
the same signature travels with the message through retries, persists
across reloads, and is available when we mirror the message into the local
ledger — so recovering peers can verify authorship offline.
@category network
*/

import { createPeerMessageModel } from "../models/data-model.js";
import { MessageType } from "./messages.js";
import { signTallyMessage } from "./authorship.js";
import { createKeyProviderFromState } from "../crypto/key-provider.js";
import { asTrimmedString, createId, hasUser } from "../state-utils.js";

const PROCESSED_MESSAGE_ID_LIMIT = 500;

export const ensureOutbox = (state) => {
  if (!Array.isArray(state.outbox)) {
    state.outbox = [];
  }
};

export const ensureProcessedPeerMessageIds = (state) => {
  if (!Array.isArray(state.processed_peer_message_ids)) {
    state.processed_peer_message_ids = [];
  }
};

/**
 * @param {object} state
 * @param {{ toUserId?: string, type?: string, payload?: object }} [message]
 */
export const queuePeerMessage = async (state, { toUserId, type, payload = {} } = {}) => {
  if (!hasUser(state)) {
    return null;
  }

  const normalizedTargetUserId = asTrimmedString(toUserId);
  if (!normalizedTargetUserId) {
    return null;
  }

  ensureOutbox(state);
  const unsigned = createPeerMessageModel({
    id: createId("peer"),
    type,
    from_user_id: state.user.id,
    to_user_id: normalizedTargetUserId,
    created_at: new Date().toISOString(),
    payload,
  });

  // Durable messages get a Tally authorship proof at queue time, so the proof
  // travels with the message through retries, persists across reloads, and is
  // mirrored into the ledger for offline verification by recovering peers.
  const keyProvider = createKeyProviderFromState(state);
  let authorship = null;
  if (keyProvider) {
    try {
      authorship = await signTallyMessage(unsigned, keyProvider);
    } catch {
      // Signing should not fail for a local key. If it does (e.g. an external
      // signer rejection), we still queue the message; recipients enforcing
      // authorship will reject it and we'll surface the issue that way.
      authorship = null;
    }
  }

  const message = createPeerMessageModel({ ...unsigned, authorship });
  state.outbox.push(message);
  return message;
};

export const markProcessedPeerMessage = (state, messageId) => {
  const normalizedMessageId = asTrimmedString(messageId);
  if (!normalizedMessageId) {
    return;
  }

  ensureProcessedPeerMessageIds(state);
  if (state.processed_peer_message_ids.includes(normalizedMessageId)) {
    return;
  }

  state.processed_peer_message_ids.unshift(normalizedMessageId);
  if (state.processed_peer_message_ids.length > PROCESSED_MESSAGE_ID_LIMIT) {
    state.processed_peer_message_ids.length = PROCESSED_MESSAGE_ID_LIMIT;
  }
};

export const hasProcessedPeerMessage = (state, messageId) => {
  const normalizedMessageId = asTrimmedString(messageId);
  if (!normalizedMessageId) {
    return false;
  }

  ensureProcessedPeerMessageIds(state);
  return state.processed_peer_message_ids.includes(normalizedMessageId);
};

export const removeQueuedPeerMessage = (state, messageId) => {
  const normalizedMessageId = asTrimmedString(messageId);
  if (!normalizedMessageId) {
    return null;
  }

  ensureOutbox(state);
  const removedMessage = state.outbox.find((message) => message.id === normalizedMessageId);
  if (!removedMessage) return null;
  state.outbox = state.outbox.filter((message) => message.id !== normalizedMessageId);
  return removedMessage;
};

export const hasQueuedPeerMessage = (state, { toUserId = "", type = "" } = {}) => {
  const normalizedTargetUserId = asTrimmedString(toUserId);
  const normalizedType = asTrimmedString(type);
  ensureOutbox(state);

  return state.outbox.some((message) => {
    if (normalizedTargetUserId && message.to_user_id !== normalizedTargetUserId) {
      return false;
    }
    if (normalizedType && message.type !== normalizedType) {
      return false;
    }
    return true;
  });
};

export const queueTrustLimitSuggestion = async (state, friendId, trustLimit) => {
  if (!Number.isFinite(trustLimit) || trustLimit < 0) {
    return null;
  }

  return queuePeerMessage(state, {
    toUserId: friendId,
    type: MessageType.TRUST_LIMIT_SUGGESTION,
    payload: {
      credit_limit_eur: trustLimit,
    },
  });
};
