/*
Trust-limit commands: raising/lowering the amount you allow a friend to owe
you, responding to a suggestion from them, withdrawing your own pending
suggestion, and dismissing the "they lowered it" notification.

The asymmetry between raising and lowering is load-bearing: lowering takes
effect immediately (you can always reduce your own exposure), while raising
requires the peer's agreement and sits in a pending state until they echo
it back. routeOutboundEntry encodes this logic so both this command path and
the self-mesh sync path apply the same state transition.
@category command
*/

import { normalizeCurrencyAmount } from "../models/data-model.js";
import {
  isPeerEligibleFriendshipStatus,
  FRIENDSHIP_STATUS_PENDING_INCOMING,
  FRIENDSHIP_STATUS_REJECTED,
  PENDING_CREDIT_LIMIT_LOWERED,
} from "../utils/friendships.js";
import { asTrimmedString, hasUser } from "../state-utils.js";
import { buildView } from "../ui/view-model.js";
import {
  loadData,
  loadState,
  persistAndBuildView,
} from "../app-state.js";
import { queueTrustLimitSuggestion } from "../peer/outbox.js";
import { getFriend } from "../friends-helpers.js";
import { appendLedgerEntryFromMessage } from "../ledger.js";
import { routeOutboundEntry } from "../peer/handlers.js";

export const updateTrustLimit = async (friendId, trustLimit) => {
  const normalizedFriendId = asTrimmedString(friendId);
  const normalizedTrustLimit = normalizeCurrencyAmount(trustLimit, NaN);
  if (!normalizedFriendId || !Number.isFinite(normalizedTrustLimit) || normalizedTrustLimit < 0) {
    return loadData();
  }

  const state = await loadState();
  if (!hasUser(state)) {
    return null;
  }

  const friend = getFriend(state, normalizedFriendId);
  if (!friend) {
    return loadData();
  }
  if (
    friend.friendship_status === FRIENDSHIP_STATUS_PENDING_INCOMING ||
    friend.friendship_status === FRIENDSHIP_STATUS_REJECTED
  ) {
    return buildView(state);
  }

  const existingLimit = friend.trust_credit_limit_eur || 0;
  if (normalizedTrustLimit === existingLimit) {
    return buildView(state);
  }

  const msg = await queueTrustLimitSuggestion(state, normalizedFriendId, normalizedTrustLimit);
  appendLedgerEntryFromMessage(state, msg);
  routeOutboundEntry(state, msg);

  return persistAndBuildView(state);
};

export const respondToTrustLimitSuggestion = async (friendId, accepted) => {
  const normalizedFriendId = asTrimmedString(friendId);
  if (!normalizedFriendId) {
    return loadData();
  }

  const state = await loadState();
  if (!hasUser(state)) {
    return null;
  }

  const friend = getFriend(state, normalizedFriendId);
  if (!friend || friend.pending_credit_limit_is_incoming !== true) {
    return loadData();
  }

  const pendingLimit = friend.pending_credit_limit_eur;

  // Apply state directly on this device first — the agreed/rejected limit must
  // be set before the response message is created so the payload is correct.
  // routeOutboundEntry applied to the same message is a no-op on this device
  // (it sees the already-applied state) but correctly rehydrates the other device.
  if (accepted) {
    friend.trust_credit_limit_eur = pendingLimit;
  }
  friend.pending_credit_limit_eur = null;
  friend.pending_credit_limit_is_incoming = null;

  // On agree: echo the agreed limit so the peer applies it. On disagree: echo
  // the current (unchanged) limit so the peer reverts their pending state.
  const responseLimit = accepted && Number.isFinite(pendingLimit) && pendingLimit >= 0
    ? pendingLimit
    : friend.trust_credit_limit_eur || 0;

  if (isPeerEligibleFriendshipStatus(friend.friendship_status)) {
    const msg = await queueTrustLimitSuggestion(state, normalizedFriendId, responseLimit);
    appendLedgerEntryFromMessage(state, msg);
    routeOutboundEntry(state, msg);
  }

  return persistAndBuildView(state);
};

export const cancelTrustLimitSuggestion = async (friendId) => {
  const normalizedFriendId = asTrimmedString(friendId);
  if (!normalizedFriendId) {
    return loadData();
  }

  const state = await loadState();
  if (!hasUser(state)) {
    return null;
  }

  const friend = getFriend(state, normalizedFriendId);
  if (!friend || friend.pending_credit_limit_is_incoming !== false) {
    return loadData();
  }

  const currentLimit = friend.trust_credit_limit_eur || 0;

  if (isPeerEligibleFriendshipStatus(friend.friendship_status)) {
    const msg = await queueTrustLimitSuggestion(state, normalizedFriendId, currentLimit);
    appendLedgerEntryFromMessage(state, msg);
    routeOutboundEntry(state, msg);
  }

  return persistAndBuildView(state);
};

export const dismissTrustLimitNotification = async (friendId) => {
  const normalizedFriendId = asTrimmedString(friendId);
  if (!normalizedFriendId) {
    return loadData();
  }

  const state = await loadState();
  if (!hasUser(state)) {
    return null;
  }

  const friend = getFriend(state, normalizedFriendId);
  if (!friend || friend.pending_credit_limit_is_incoming !== PENDING_CREDIT_LIMIT_LOWERED) {
    return loadData();
  }

  friend.pending_credit_limit_eur = null;
  friend.pending_credit_limit_is_incoming = null;

  return persistAndBuildView(state);
};
