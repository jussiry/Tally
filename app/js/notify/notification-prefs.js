/*
State helpers that publish the user's OS-notification choice (which event types
should reach them as OS notifications) to the peers that need it.

The choice lives only in the ledger, as `notification_prefs` entries; the
latest one by an author wins (see collectOsNotifyChoicesByAuthor in
notification-policy.js). Each entry holds only the settings the user set;
the rest follow their defaults. Publishing therefore writes:

  - one entry to every peer-eligible friend, so their client attaches push
    hints only for the types this user enabled, and
  - one self-addressed entry, so the user's other devices see the choice even
    when the user has no friends yet (self-sync carries it, like the initial
    name_changed entry).

A new friend learns the choice through shareOsNotifyTypesWith once the
friendship is accepted. Users who never changed anything publish nothing:
peers already assume the defaults.

All helpers mutate `state` in place; the caller persists.
@category network
*/

import { MessageType } from "../peer/messages.js";
import { queuePeerMessage } from "../peer/outbox.js";
import { appendSelfLedgerEntry } from "../peer/self-entry.js";
import { appendLedgerEntryFromMessage } from "../ledger.js";
import { isPeerEligibleFriendshipStatus } from "../utils/friendships.js";
import { hasUser } from "../state-utils.js";
import {
  collectOsNotifyChoicesByAuthor,
  normalizeOsNotifyChoices,
  resolveOsNotifyTypes,
} from "./notification-policy.js";

// Only the settings the user set, plus the resolved list for older clients.
const prefsPayload = (choices) => ({ choices, enabled: resolveOsNotifyTypes(choices) });

const queuePrefsTo = async (state, friendId, payload) => {
  const message = await queuePeerMessage(state, {
    toUserId: friendId,
    type: MessageType.NOTIFICATION_PREFS,
    payload,
  });
  if (message) appendLedgerEntryFromMessage(state, message);
};

export const publishOsNotifyChoices = async (state, choices) => {
  if (!hasUser(state)) return;
  const payload = prefsPayload(normalizeOsNotifyChoices(choices));
  await appendSelfLedgerEntry(state, MessageType.NOTIFICATION_PREFS, payload);
  const friends = Array.isArray(state.user.friends) ? state.user.friends : [];
  for (const friend of friends) {
    if (isPeerEligibleFriendshipStatus(friend.friendship_status)) {
      await queuePrefsTo(state, friend.person_id, payload);
    }
  }
};

// Tell one (newly accepted) friend the user's choice, if the user ever made one.
export const shareOsNotifyTypesWith = async (state, friendId) => {
  if (!hasUser(state) || !friendId) return;
  const own = collectOsNotifyChoicesByAuthor(state.ledger)[state.user.id];
  if (own) await queuePrefsTo(state, friendId, prefsPayload(own));
};
