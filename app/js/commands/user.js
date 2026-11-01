/*
User-profile commands: renaming yourself (which notifies every peer so
their display stays current), and dismissing the "they renamed themselves"
notification on a friend.

Identity creation lives in `app-state.js` rather than here — it's part of
initializing the state store, not a mutation of an already-running one.
@category command
*/

import { MessageType } from "../peer/messages.js";
import { isPeerEligibleFriendshipStatus } from "../utils/friendships.js";
import { asTrimmedString, hasUser } from "../state-utils.js";
import {
  loadData,
  loadState,
  persistAndBuildView,
} from "../app-state.js";
import { queuePeerMessage } from "../peer/outbox.js";
import { appendLedgerEntryFromMessage } from "../ledger.js";
import {
  getFriend,
  syncUserNameAcrossContacts,
} from "../friends-helpers.js";

export const updateUserName = async (name) => {
  const trimmedName = asTrimmedString(name);
  if (!trimmedName) {
    return loadData();
  }

  const state = await loadState();
  if (!hasUser(state)) {
    return null;
  }

  state.user.name = trimmedName;
  syncUserNameAcrossContacts(state);

  const friends = Array.isArray(state.user.friends) ? state.user.friends : [];
  const eligibleFriends = friends.filter((friend) =>
    isPeerEligibleFriendshipStatus(friend.friendship_status)
  );
  for (const friend of eligibleFriends) {
    const message = await queuePeerMessage(state, {
      toUserId: friend.person_id,
      type: MessageType.NAME_CHANGED,
      payload: { name: trimmedName },
    });
    if (message) {
      appendLedgerEntryFromMessage(state, message);
    }
  }

  return persistAndBuildView(state);
};

export const dismissNameChangeNotification = async (friendId) => {
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

  friend.pending_name_change = null;
  return persistAndBuildView(state);
};
