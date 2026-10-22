/*
This module centralizes friendship-state constants and small predicates that the IOU client reuses across data, UI, and realtime networking code.

Keeping the status vocabulary in one place avoids stringly-typed conditionals spread across pages, and makes it easier to evolve pending or accepted friendship flows consistently.
@category util
*/

export const FRIENDSHIP_STATUS_ACCEPTED = "accepted";
export const FRIENDSHIP_STATUS_PENDING_OUTGOING = "pending_outgoing";
export const FRIENDSHIP_STATUS_PENDING_INCOMING = "pending_incoming";
export const FRIENDSHIP_STATUS_REJECTED = "rejected";
// One side defaulted on (or absolved, or deactivated) the friendship. The
// records stay, but count in no total and allow no new activity until both
// agree to reactivate.
export const FRIENDSHIP_STATUS_DISABLED = "disabled";

export const isAcceptedFriendshipStatus = (status) => {
  return status === FRIENDSHIP_STATUS_ACCEPTED;
};

export const isDisabledFriendshipStatus = (status) => {
  return status === FRIENDSHIP_STATUS_DISABLED;
};

export const isPendingFriendshipStatus = (status) => {
  return (
    status === FRIENDSHIP_STATUS_PENDING_OUTGOING ||
    status === FRIENDSHIP_STATUS_PENDING_INCOMING
  );
};

export const isPeerEligibleFriendshipStatus = (status) => {
  return isAcceptedFriendshipStatus(status) || isPendingFriendshipStatus(status);
};

export const hasActionableNotification = (connection) => {
  if (connection.friendship_status === FRIENDSHIP_STATUS_PENDING_INCOMING) return true;
  if (connection.pending_credit_limit_is_incoming === true) return true;
  if (connection.pending_credit_limit_is_incoming === "lowered") return true;
  if (connection.pending_payment_requests?.some((request) => request.is_incoming)) return true;
  if (connection.pending_name_change) return true;
  if (connection.pending_reactivation?.is_incoming) return true;
  return false;
};
