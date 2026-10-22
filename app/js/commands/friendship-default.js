/*
Defaulting on a friendship, and the way back.

Defaulting (the friend page's danger action — called absolving when the friend
owes you, deactivating when the tally is zero) tells the friend with a signed
friendship_default message and an optional note. Both sides then keep the
friendship disabled: its records stay visible, but they count in no total and
allow no new activity.

Either side can suggest reactivation. The suggestion carries the requester's
copy of the shared history, since the recipient may have deleted theirs; the
recipient verifies every entry before using it (ledger.ts
verifyReactivationHistory). Accepting makes the friendship active again on
both sides, records and all.

Deleting the history is local and final for this user: the friend record and
every ledger entry between the two go, and a self-addressed
friendship_history_deleted entry makes the user's other devices do the same.
Only the friend's own copy can bring the friendship back.

State changes run through routeOutboundEntry, like the other commands, so a
self-synced device ends up the same.
@category command
*/

import {
  PEER_MESSAGE_TYPE_FRIENDSHIP_DEFAULT,
  PEER_MESSAGE_TYPE_HISTORY_DELETED,
  PEER_MESSAGE_TYPE_REACTIVATION_REQUEST,
  PEER_MESSAGE_TYPE_REACTIVATION_RESPONSE,
} from "../peer/messages.js";
import {
  isAcceptedFriendshipStatus,
  isDisabledFriendshipStatus,
} from "../utils/friendships.js";
import { asTrimmedString, createId, hasUser } from "../state-utils.js";
import { loadData, loadState, persistAndBuildView } from "../app-state.js";
import { queuePeerMessage } from "../peer/outbox.js";
import { signTallyMessage } from "../peer/authorship.js";
import { createKeyProviderFromState } from "../crypto/key-provider.js";
import { createPeerMessageModel } from "../models/data-model.js";
import { deleteFriendHistory, getFriend } from "../friends-helpers.js";
import {
  appendLedgerEntryFromMessage,
  getLedgerEntriesForPeer,
  getOpenReactivationRequests,
} from "../ledger.js";
import { routeOutboundEntry } from "../peer/handlers.js";
import { shareOsNotifyTypesWith } from "../notify/notification-prefs.js";

// Load state and the friend, when the friend's status passes `isAllowed`.
const loadFriend = async (friendId, isAllowed) => {
  const normalizedFriendId = asTrimmedString(friendId);
  if (!normalizedFriendId) return null;
  const state = await loadState();
  if (!hasUser(state)) return null;
  const friend = getFriend(state, normalizedFriendId);
  if (!friend || !isAllowed(friend.friendship_status)) return null;
  return { state, friend, friendId: normalizedFriendId };
};

export const defaultOnFriendship = async (friendId, note = "") => {
  const found = await loadFriend(friendId, isAcceptedFriendshipStatus);
  if (!found) return loadData();
  const { state, friend, friendId: toUserId } = found;

  const defaultMsg = await queuePeerMessage(state, {
    toUserId,
    type: PEER_MESSAGE_TYPE_FRIENDSHIP_DEFAULT,
    payload: {
      note: asTrimmedString(note),
      tally_eur: friend.debt_eur || 0,
    },
  });
  appendLedgerEntryFromMessage(state, defaultMsg);
  routeOutboundEntry(state, defaultMsg);
  return persistAndBuildView(state);
};

const respond = async (state, toUserId, requestId, accepted) => {
  const responseMsg = await queuePeerMessage(state, {
    toUserId,
    type: PEER_MESSAGE_TYPE_REACTIVATION_RESPONSE,
    payload: { request_id: requestId, accepted },
  });
  appendLedgerEntryFromMessage(state, responseMsg);
  if (routeOutboundEntry(state, responseMsg)) {
    await shareOsNotifyTypesWith(state, toUserId);
  }
};

export const suggestReactivation = async (friendId) => {
  const found = await loadFriend(friendId, isDisabledFriendshipStatus);
  if (!found) return loadData();
  const { state, friend, friendId: toUserId } = found;

  const open = getOpenReactivationRequests(state.ledger, state.user.id).get(toUserId);
  if (open?.is_incoming) {
    // The friend already asked: suggesting back is agreeing.
    await respond(state, toUserId, open.id, true);
    return persistAndBuildView(state);
  }
  if (open) return persistAndBuildView(state);

  // Earlier requests stay out, or each history would nest the previous ones.
  const history = getLedgerEntriesForPeer(state.ledger, state.user.id, toUserId).filter(
    (entry) => entry.type !== PEER_MESSAGE_TYPE_REACTIVATION_REQUEST
  );
  const requestMsg = await queuePeerMessage(state, {
    toUserId,
    type: PEER_MESSAGE_TYPE_REACTIVATION_REQUEST,
    payload: {
      request_id: createId("react"),
      requester_name: state.user.name,
      trust_credit_limit_eur: friend.trust_credit_limit_eur || 0,
      history,
    },
  });
  appendLedgerEntryFromMessage(state, requestMsg);
  return persistAndBuildView(state);
};

export const respondToReactivation = async (friendId, requestId, accepted) => {
  const found = await loadFriend(friendId, isDisabledFriendshipStatus);
  if (!found) return loadData();
  const { state, friendId: toUserId } = found;

  const open = getOpenReactivationRequests(state.ledger, state.user.id).get(toUserId);
  if (!open?.is_incoming || open.id !== requestId) return persistAndBuildView(state);
  await respond(state, toUserId, open.id, accepted === true);
  return persistAndBuildView(state);
};

// Signed, ledger-only entry addressed to the user itself (see
// notify/notification-prefs.js for the same pattern).
const appendHistoryDeletedEntry = async (state, friendId) => {
  const unsigned = createPeerMessageModel({
    id: createId("peer"),
    type: PEER_MESSAGE_TYPE_HISTORY_DELETED,
    from_user_id: state.user.id,
    to_user_id: state.user.id,
    created_at: new Date().toISOString(),
    payload: { friend_id: friendId },
  });
  const keyProvider = createKeyProviderFromState(state);
  let authorship = null;
  if (keyProvider) {
    try {
      authorship = await signTallyMessage(unsigned, keyProvider);
    } catch {
      authorship = null;
    }
  }
  appendLedgerEntryFromMessage(state, { ...unsigned, authorship });
};

export const deleteDisabledFriendHistory = async (friendId) => {
  const found = await loadFriend(friendId, isDisabledFriendshipStatus);
  if (!found) return loadData();
  const { state, friendId: deletedId } = found;

  deleteFriendHistory(state, deletedId);
  await appendHistoryDeletedEntry(state, deletedId);
  return persistAndBuildView(state);
};
