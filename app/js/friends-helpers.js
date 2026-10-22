/*
Manages the bidirectional friendship and contact graph.

Provides helpers to find, create, and update friend relationships on both the
user and their contacts. Also handles friend request cancellation and
relationship cleanup.
@category util
*/

import {
  createFriendModel,
  createPublicPersonModel,
} from "./models/data-model.js";
import {
  ensureOutbox,
  hasQueuedPeerMessage,
  queuePeerMessage,
} from "./peer/outbox.js";
import {
  PEER_MESSAGE_TYPE_FRIEND_REJECT,
  PEER_MESSAGE_TYPE_FRIEND_REQUEST,
} from "./peer/messages.js";
import { appendLedgerEntryFromMessage } from "./ledger.js";
import { asTrimmedString, hasUser } from "./state-utils.js";
import {
  FRIENDSHIP_STATUS_ACCEPTED,
  FRIENDSHIP_STATUS_DISABLED,
  FRIENDSHIP_STATUS_PENDING_INCOMING,
  FRIENDSHIP_STATUS_PENDING_OUTGOING,
} from "./utils/friendships.js";

export const ensureContacts = (state) => {
  if (!state.contacts || typeof state.contacts !== "object") {
    state.contacts = {};
  }
};

export const findFriend = (person, friendId) => {
  if (!Array.isArray(person?.friends)) {
    return null;
  }

  const normalizedFriendId = asTrimmedString(friendId);
  if (!normalizedFriendId) {
    return null;
  }

  return (
    person.friends.find((entry) => entry.person_id === normalizedFriendId) || null
  );
};

export const getFriend = (state, friendId) => {
  if (!hasUser(state)) {
    return null;
  }

  return findFriend(state.user, friendId);
};

const ensureFriendInternal = (person, friendId, friendName, options = {}) => {
  const normalizedFriendId = asTrimmedString(friendId);
  const normalizedFriendName = asTrimmedString(friendName);
  if (!normalizedFriendId) {
    return null;
  }

  if (!Array.isArray(person.friends)) {
    person.friends = [];
  }

  let friend = findFriend(person, normalizedFriendId);
  if (!friend) {
    friend = createFriendModel({
      person_id: normalizedFriendId,
      person_name: normalizedFriendName || normalizedFriendId,
      friendship_status: options.friendshipStatus || FRIENDSHIP_STATUS_ACCEPTED,
      debt_eur: 0,
      trust_credit_limit_eur: 0,
      recent_transactions: [],
    });
    person.friends.push(friend);
  }

  friend.person_name =
    normalizedFriendName || friend.person_name || normalizedFriendId;
  if (!Array.isArray(friend.recent_transactions)) {
    friend.recent_transactions = [];
  }
  if (options.friendshipStatus) {
    friend.friendship_status = options.friendshipStatus;
  }

  return friend;
};

export const ensureContact = (state, contactId, contactName) => {
  const normalizedContactId = asTrimmedString(contactId);
  const normalizedContactName = asTrimmedString(contactName);
  if (!normalizedContactId) {
    return null;
  }

  ensureContacts(state);
  if (state.contacts[normalizedContactId]) {
    const existingContact = state.contacts[normalizedContactId];
    if (normalizedContactName) {
      existingContact.name = normalizedContactName;
    }
    return existingContact;
  }

  const contact = createPublicPersonModel({
    id: normalizedContactId,
    name: normalizedContactName || normalizedContactId,
    public_key: normalizedContactId,
    connections: [],
  });
  state.contacts[contact.id] = contact;
  return contact;
};

export const ensureFriend = (state, friendId, friendName, options = {}) => {
  if (!hasUser(state)) {
    return null;
  }

  const normalizedFriendId = asTrimmedString(friendId);
  if (!normalizedFriendId || normalizedFriendId === state.user.id) {
    return null;
  }

  ensureContact(state, normalizedFriendId, friendName);
  return ensureFriendInternal(state.user, normalizedFriendId, friendName, options);
};

export const ensureContactBackLink = (state, contactId, contactName) => {
  if (!hasUser(state)) {
    return null;
  }

  const contact = ensureContact(state, contactId, contactName);
  if (!contact) {
    return null;
  }

  return ensureFriendInternal(contact, state.user.id, state.user.name);
};

export const syncUserNameAcrossContacts = (state) => {
  if (!hasUser(state)) return;

  Object.values(state.contacts || {}).forEach((contact) => {
    const friend = Array.isArray(contact.friends)
      ? contact.friends.find((entry) => entry.person_id === state.user.id)
      : null;
    if (!friend) return;
    friend.person_name = state.user.name;
  });
};

export const getDisplayName = (state, friendId) => {
  const normalizedFriendId = asTrimmedString(friendId);
  const friend = getFriend(state, normalizedFriendId);
  const contact = state.contacts?.[normalizedFriendId];
  return (
    contact?.name ||
    friend?.person_name ||
    normalizedFriendId
  );
};

export const removeFriendRelationshipData = (state, friendId) => {
  const normalizedFriendId = asTrimmedString(friendId);
  if (!normalizedFriendId || !hasUser(state)) {
    return;
  }

  state.user.friends = Array.isArray(state.user.friends)
    ? state.user.friends.filter((friend) => friend.person_id !== normalizedFriendId)
    : [];
  ensureContacts(state);
  delete state.contacts[normalizedFriendId];
  ensureOutbox(state);
  state.outbox = state.outbox.filter((message) => {
    return (
      message.to_user_id !== normalizedFriendId &&
      message.from_user_id !== normalizedFriendId
    );
  });
};

// Disable a friendship after a default. The records stay for the history
// view; open suggestions and notices about the friend no longer apply.
export const disableFriend = (friend) => {
  friend.friendship_status = FRIENDSHIP_STATUS_DISABLED;
  friend.pending_credit_limit_eur = null;
  friend.pending_credit_limit_is_incoming = null;
  friend.pending_name_change = null;
};

// Forget a disabled friend: their record, contact, queued messages, and the
// ledger entries between the two dated up to `upTo` (all when omitted). The
// record survives only when newer entries remain, e.g. a reactivation
// suggestion that arrived after the deletion on another device.
export const deleteFriendHistory = (state, friendId, { upTo = "" } = {}) => {
  const normalizedFriendId = asTrimmedString(friendId);
  if (!normalizedFriendId || !hasUser(state)) return false;
  const myId = state.user.id;
  const concernsFriend = (entry) =>
    (entry.from_user_id === myId && entry.to_user_id === normalizedFriendId) ||
    (entry.from_user_id === normalizedFriendId && entry.to_user_id === myId);
  const origin = (entry) => entry.originated_at || entry.timestamp || "";
  const before = state.ledger.length;
  state.ledger = state.ledger.filter(
    (entry) => !concernsFriend(entry) || (upTo && origin(entry) > upTo)
  );
  if (!state.ledger.some(concernsFriend)) {
    removeFriendRelationshipData(state, normalizedFriendId);
  }
  return state.ledger.length !== before;
};

export const cancelPendingFriendRequest = async (
  state,
  friendId,
  { direction, displayName, notifyPeer = false, skipLog = false } = {}
) => {
  const normalizedFriendId = asTrimmedString(friendId);
  const normalizedDisplayName = asTrimmedString(displayName) || normalizedFriendId;
  const friend = getFriend(state, normalizedFriendId);
  if (!friend) {
    return false;
  }
  if (
    friend.friendship_status !== FRIENDSHIP_STATUS_PENDING_INCOMING &&
    friend.friendship_status !== FRIENDSHIP_STATUS_PENDING_OUTGOING
  ) {
    return false;
  }

  const hasUnsentOutgoingRequest =
    friend.friendship_status === FRIENDSHIP_STATUS_PENDING_OUTGOING &&
    hasQueuedPeerMessage(state, {
      toUserId: normalizedFriendId,
      type: PEER_MESSAGE_TYPE_FRIEND_REQUEST,
    });
  removeFriendRelationshipData(state, normalizedFriendId);
  let rejectMessage = null;
  if (notifyPeer && !hasUnsentOutgoingRequest) {
    rejectMessage = await queuePeerMessage(state, {
      toUserId: normalizedFriendId,
      type: PEER_MESSAGE_TYPE_FRIEND_REJECT,
      payload: {},
    });
  }
  if (!skipLog && rejectMessage) {
    appendLedgerEntryFromMessage(state, rejectMessage);
  }
  // direction/displayName currently unused; kept for call-site compatibility
  void direction;
  void normalizedDisplayName;
  return true;
};
