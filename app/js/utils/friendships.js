/*
This module centralizes friendship-state constants and small predicates that the IOU client reuses across data, UI, and realtime networking code.

Keeping the status vocabulary in one place avoids stringly-typed conditionals spread across pages, and makes it easier to evolve pending or accepted friendship flows consistently.
@category util
*/

export const FriendshipStatus = Object.freeze({
  ACCEPTED: "accepted",
  PENDING_OUTGOING: "pending_outgoing",
  PENDING_INCOMING: "pending_incoming",
  REJECTED: "rejected",
  // One side defaulted on (or absolved, or deactivated) the friendship. The
  // records stay, but count in no total and allow no new activity until both
  // agree to reactivate.
  // Stored as "disabled" (the first name); the UI says deactivated.
  DEACTIVATED: "disabled",
});

// `pending_credit_limit_is_incoming` is true (incoming proposal), false
// (outgoing), null, or this: the friend lowered the limit, which applied at
// once and waits only to be acknowledged.
export const PENDING_CREDIT_LIMIT_LOWERED = "lowered";

export const isAcceptedFriendshipStatus = (status) => {
  return status === FriendshipStatus.ACCEPTED;
};

export const isDeactivatedFriendshipStatus = (status) => {
  return status === FriendshipStatus.DEACTIVATED;
};

export const isPendingFriendshipStatus = (status) => {
  return (
    status === FriendshipStatus.PENDING_OUTGOING ||
    status === FriendshipStatus.PENDING_INCOMING
  );
};

export const isPeerEligibleFriendshipStatus = (status) => {
  return isAcceptedFriendshipStatus(status) || isPendingFriendshipStatus(status);
};

export const hasActionableNotification = (connection) => {
  if (connection.friendship_status === FriendshipStatus.PENDING_INCOMING) return true;
  if (connection.pending_credit_limit_is_incoming === true) return true;
  if (connection.pending_credit_limit_is_incoming === PENDING_CREDIT_LIMIT_LOWERED) return true;
  if (connection.pending_payment_requests?.some((request) => request.is_incoming)) return true;
  if (connection.pending_name_change) return true;
  if (connection.pending_reactivation?.is_incoming) return true;
  return false;
};
