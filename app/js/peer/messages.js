/*
This module defines the peer-to-peer message types and small helpers used by the IOU realtime layer.

By keeping transport message names and envelope helpers together, the data layer and WebRTC transport can share one message contract without duplicating literal strings in multiple modules.
@category network
*/

export const PEER_MESSAGE_TYPE_FRIEND_REQUEST = "friend_request";
export const PEER_MESSAGE_TYPE_FRIEND_ACCEPT = "friend_accept";
export const PEER_MESSAGE_TYPE_FRIEND_REJECT = "friend_reject";
export const PEER_MESSAGE_TYPE_TRUST_LIMIT_SUGGESTION = "credit_limit_suggestion";
export const PEER_MESSAGE_TYPE_TRANSACTION_CREATED = "transaction_created";
export const PEER_MESSAGE_TYPE_NAME_CHANGED = "name_changed";
export const PEER_MESSAGE_TYPE_PAYMENT_REQUEST = "payment_request";
export const PEER_MESSAGE_TYPE_PAYMENT_REQUEST_RESPONSE = "payment_request_response";
export const PEER_MESSAGE_TYPE_PAYMENT_REQUEST_CANCEL = "payment_request_cancel";
// Which events the author wants as OS notifications; see notify/notification-policy.js.
export const PEER_MESSAGE_TYPE_NOTIFICATION_PREFS = "notification_prefs";
export const PEER_MESSAGE_TYPE_PING = "ping";
export const PEER_MESSAGE_TYPE_PONG = "pong";
export const PEER_MESSAGE_TYPE_RECEIVED = "received";
export const PEER_MESSAGE_TYPE_SYNC_HELLO = "sync_hello";
export const PEER_MESSAGE_TYPE_SYNC_DATA = "sync_data";
export const PEER_RECEIPT_RESULT_PROCESSED = "peer_processed";
export const PEER_RECEIPT_RESULT_IGNORED = "peer_ignored";

// Transport-only message types: live control frames, sync containers, and
// acknowledgements. These are NOT durable ledger facts, so they carry no
// authorship proof (TIP-006 §"Sync transport messages"/"Receipts") and are
// not authorship-verified on receipt. Everything else is a durable message
// whose authorship must be proven before it can be applied or stored.
const NON_DURABLE_PEER_MESSAGE_TYPES = new Set([
  PEER_MESSAGE_TYPE_PING,
  PEER_MESSAGE_TYPE_PONG,
  PEER_MESSAGE_TYPE_RECEIVED,
  PEER_MESSAGE_TYPE_SYNC_HELLO,
  PEER_MESSAGE_TYPE_SYNC_DATA,
]);

export const isDurablePeerMessageType = (type) =>
  typeof type === "string" && type.length > 0 && !NON_DURABLE_PEER_MESSAGE_TYPES.has(type);

const createRuntimeMessageId = () => {
  if (window.crypto?.randomUUID) {
    return `peer_${window.crypto.randomUUID()}`;
  }

  const randomToken = Math.random().toString(36).slice(2, 10);
  return `peer_${Date.now().toString(36)}_${randomToken}`;
};

export const createPeerReceiptMessage = ({
  fromUserId,
  toUserId,
  messageId,
  result = PEER_RECEIPT_RESULT_PROCESSED,
}) => {
  return {
    id: createRuntimeMessageId(),
    type: PEER_MESSAGE_TYPE_RECEIVED,
    from_user_id: fromUserId,
    to_user_id: toUserId,
    created_at: new Date().toISOString(),
    payload: {
      message_id: messageId,
      result,
    },
  };
};
