/*
Friend lifecycle commands: sending and accepting requests, rejecting them,
withdrawing outgoing ones.

Each command follows the same shape — load state, validate, queue a peer
message, mirror it into the ledger, apply it via routeOutboundEntry, and
persist. State mutations live exclusively in routeOutboundEntry so that
the same logic runs whether the action originated on this device or arrived
via self-mesh sync from another device.
@category command
*/

import { normalizeCurrencyAmount } from "../models/data-model.js";
import { normalizeRelayUrl } from "../utils/relay-url.js";
import {
  PEER_MESSAGE_TYPE_FRIEND_ACCEPT,
  PEER_MESSAGE_TYPE_FRIEND_REQUEST,
} from "../peer/messages.js";
import {
  FRIENDSHIP_STATUS_ACCEPTED,
  FRIENDSHIP_STATUS_DISABLED,
  FRIENDSHIP_STATUS_PENDING_INCOMING,
  FRIENDSHIP_STATUS_PENDING_OUTGOING,
  FRIENDSHIP_STATUS_REJECTED,
  isAcceptedFriendshipStatus,
} from "../utils/friendships.js";
import { asTrimmedString, hasUser } from "../state-utils.js";
import { shareOsNotifyTypesWith } from "../notify/notification-prefs.js";
import { buildView } from "../ui/view-model.js";
import {
  loadData,
  loadState,
  persistAndBuildView,
} from "../app-state.js";
import { queuePeerMessage } from "../peer/outbox.js";
import {
  cancelPendingFriendRequest,
  findFriend,
  getDisplayName,
  getFriend,
} from "../friends-helpers.js";
import { appendLedgerEntryFromMessage } from "../ledger.js";
import { routeOutboundEntry } from "../peer/handlers.js";

export const createFriend = async ({ friendId, trustLimit, name, relays }) => {
  const normalizedFriendId = asTrimmedString(friendId);
  if (!normalizedFriendId) {
    return loadData();
  }

  const state = await loadState();
  if (!hasUser(state) || normalizedFriendId === state.user.id) {
    return null;
  }

  const existingFriend = findFriend(state.user, normalizedFriendId);
  const existingStatus = existingFriend?.friendship_status || "";

  // A disabled friend comes back only through a reactivation suggestion
  // (commands/friendship-default.js), from their friend page.
  if (existingStatus === FRIENDSHIP_STATUS_ACCEPTED || existingStatus === FRIENDSHIP_STATUS_DISABLED) {
    return persistAndBuildView(state);
  }

  const normalizedTrustLimit = normalizeCurrencyAmount(trustLimit, NaN);

  if (existingStatus === FRIENDSHIP_STATUS_PENDING_INCOMING) {
    // Cross-request: the peer already sent us a request; auto-accept.
    // Trust limit must be written on the friend before the accept message
    // is created so the payload carries the correct agreed value.
    const friend = getFriend(state, normalizedFriendId);
    if (!friend) return loadData();
    if (Number.isFinite(normalizedTrustLimit) && normalizedTrustLimit >= 0) {
      friend.trust_credit_limit_eur = normalizedTrustLimit;
    }
    const acceptMsg = await queuePeerMessage(state, {
      toUserId: normalizedFriendId,
      type: PEER_MESSAGE_TYPE_FRIEND_ACCEPT,
      payload: {
        accepter_name: state.user.name,
        trust_credit_limit_eur: friend.trust_credit_limit_eur || 0,
      },
    });
    appendLedgerEntryFromMessage(state, acceptMsg);
    routeOutboundEntry(state, acceptMsg);
    await shareOsNotifyTypesWith(state, normalizedFriendId);
    return persistAndBuildView(state);
  }

  // New outgoing friend request.
  const requestMsg = await queuePeerMessage(state, {
    toUserId: normalizedFriendId,
    type: PEER_MESSAGE_TYPE_FRIEND_REQUEST,
    payload: {
      requester_name: state.user.name,
      suggested_credit_limit_eur:
        Number.isFinite(normalizedTrustLimit) && normalizedTrustLimit >= 0
          ? normalizedTrustLimit
          : 0,
    },
  });
  appendLedgerEntryFromMessage(state, requestMsg);
  routeOutboundEntry(state, requestMsg);
  // Pre-populate the display name from the scanned QR so the pending friend
  // row shows a real name while the request is still unaccepted. The name gets
  // overwritten by the authoritative value from the friend_accept message once
  // the peer responds.
  const friend = getFriend(state, normalizedFriendId);
  if (friend) {
    const scannedName = asTrimmedString(name);
    if (scannedName) friend.person_name = scannedName;
    // Store relay hints from the scanned QR so later logic can use them to
    // establish a connection even when the two users don't share a relay.
    const scannedRelays = Array.isArray(relays)
      ? relays.map(normalizeRelayUrl).filter(Boolean)
      : [];
    if (scannedRelays.length) friend.relays = scannedRelays;
  }
  return persistAndBuildView(state);
};

export const acceptFriend = async (friendId) => {
  const normalizedFriendId = asTrimmedString(friendId);
  if (!normalizedFriendId) {
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
  if (isAcceptedFriendshipStatus(friend.friendship_status)) {
    return buildView(state);
  }
  if (friend.friendship_status !== FRIENDSHIP_STATUS_PENDING_INCOMING) {
    return buildView(state);
  }

  const acceptMsg = await queuePeerMessage(state, {
    toUserId: normalizedFriendId,
    type: PEER_MESSAGE_TYPE_FRIEND_ACCEPT,
    payload: {
      accepter_name: state.user.name,
      trust_credit_limit_eur: friend.trust_credit_limit_eur || 0,
    },
  });
  appendLedgerEntryFromMessage(state, acceptMsg);
  routeOutboundEntry(state, acceptMsg);
  await shareOsNotifyTypesWith(state, normalizedFriendId);

  return persistAndBuildView(state);
};

export const rejectFriend = async (friendId) => {
  const normalizedFriendId = asTrimmedString(friendId);
  if (!normalizedFriendId) {
    return loadData();
  }

  const state = await loadState();
  if (!hasUser(state)) {
    return null;
  }

  const displayName = getDisplayName(state, normalizedFriendId);
  const friend = getFriend(state, normalizedFriendId);
  if (!friend) {
    return loadData();
  }
  if (friend.friendship_status === FRIENDSHIP_STATUS_REJECTED) {
    return buildView(state);
  }
  if (friend.friendship_status !== FRIENDSHIP_STATUS_PENDING_INCOMING) {
    return buildView(state);
  }

  await cancelPendingFriendRequest(state, normalizedFriendId, {
    direction: "from",
    displayName,
    notifyPeer: true,
  });

  return persistAndBuildView(state);
};

export const removeFriendRequest = async (friendId) => {
  const normalizedFriendId = asTrimmedString(friendId);
  if (!normalizedFriendId) {
    return loadData();
  }

  const state = await loadState();
  if (!hasUser(state)) {
    return null;
  }

  const displayName = getDisplayName(state, normalizedFriendId);
  const friend = getFriend(state, normalizedFriendId);
  if (!friend) {
    return loadData();
  }
  if (friend.friendship_status !== FRIENDSHIP_STATUS_PENDING_OUTGOING) {
    return buildView(state);
  }

  await cancelPendingFriendRequest(state, normalizedFriendId, {
    direction: "to",
    displayName,
    notifyPeer: true,
  });

  return persistAndBuildView(state);
};
