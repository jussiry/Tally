/*
This module defines the peer-to-peer message types and small helpers used by the IOU realtime layer.

By keeping transport message names and envelope helpers together, the data layer and WebRTC transport can share one message contract without duplicating literal strings in multiple modules.
@category network
*/

export const MessageType = Object.freeze({
  FRIEND_REQUEST: "friend_request",
  FRIEND_ACCEPT: "friend_accept",
  FRIEND_REJECT: "friend_reject",
  TRUST_LIMIT_SUGGESTION: "credit_limit_suggestion",
  TRANSACTION_CREATED: "transaction_created",
  NAME_CHANGED: "name_changed",
  PAYMENT_REQUEST: "payment_request",
  PAYMENT_REQUEST_RESPONSE: "payment_request_response",
  PAYMENT_REQUEST_CANCEL: "payment_request_cancel",
  // A payer's standing payment and its end; see js/recurring.js. Each payment
  // it makes is a transaction_created carrying recurring_id and due_at.
  RECURRING_PAYMENT_CREATED: "recurring_payment_created",
  RECURRING_PAYMENT_CANCEL: "recurring_payment_cancel",
  // Deactivating a friendship and bringing it back; see commands/friendship-default.js.
  FRIENDSHIP_DEFAULT: "friendship_default",
  REACTIVATION_REQUEST: "reactivation_request",
  REACTIVATION_RESPONSE: "reactivation_response",
  // Self-addressed: the author deleted their history with a deactivated friend.
  HISTORY_DELETED: "friendship_history_deleted",
  // Self-addressed, for records by link (TIP-4; commands/offline-claim.js):
  // a link the author shared (a record to send or a request), its withdrawal,
  // and a request accepted from someone's link, to be paid once they accept
  // the friendship.
  OFFLINE_CLAIM: "offline_claim",
  OFFLINE_CLAIM_REVOKED: "offline_claim_revoked",
  LINK_PAYMENT: "link_payment",
  // Which events the author wants as OS notifications; see notify/notification-policy.js.
  NOTIFICATION_PREFS: "notification_prefs",
  PING: "ping",
  PONG: "pong",
  RECEIVED: "received",
  SYNC_HELLO: "sync_hello",
  SYNC_DATA: "sync_data",
});

export const ReceiptResult = Object.freeze({
  PROCESSED: "peer_processed",
  IGNORED: "peer_ignored",
});

// Transport-only message types: live control frames, sync containers, and
// acknowledgements. These are NOT durable ledger facts, so they carry no
// authorship proof (TIP-6 §"Sync transport messages"/"Receipts") and are
// not authorship-verified on receipt. Everything else is a durable message
// whose authorship must be proven before it can be applied or stored.
/** @type {Set<string>} */
const NON_DURABLE_PEER_MESSAGE_TYPES = new Set([
  MessageType.PING,
  MessageType.PONG,
  MessageType.RECEIVED,
  MessageType.SYNC_HELLO,
  MessageType.SYNC_DATA,
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
  result = ReceiptResult.PROCESSED,
}) => {
  return {
    id: createRuntimeMessageId(),
    type: MessageType.RECEIVED,
    from_user_id: fromUserId,
    to_user_id: toUserId,
    created_at: new Date().toISOString(),
    payload: {
      message_id: messageId,
      result,
    },
  };
};
