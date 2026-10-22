/*
State helpers that publish the user's OS-notification choice (which event types
should reach them as OS notifications) to the peers that need it.

The choice lives only in the ledger, as `notification_prefs` entries; the
latest one by an author wins (see collectOsNotifyTypesByAuthor in
notification-policy.js). Publishing therefore writes:

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

import { PEER_MESSAGE_TYPE_NOTIFICATION_PREFS } from "../peer/messages.js";
import { queuePeerMessage } from "../peer/outbox.js";
import { signTallyMessage } from "../peer/authorship.js";
import { createKeyProviderFromState } from "../crypto/key-provider.js";
import { appendLedgerEntryFromMessage } from "../ledger.js";
import { createPeerMessageModel } from "../models/data-model.js";
import { isPeerEligibleFriendshipStatus } from "../utils/friendships.js";
import { createId, hasUser } from "../state-utils.js";
import { collectOsNotifyTypesByAuthor, normalizeOsNotifyTypes } from "./notification-policy.js";

const queuePrefsTo = async (state, friendId, enabled) => {
  const message = await queuePeerMessage(state, {
    toUserId: friendId,
    type: PEER_MESSAGE_TYPE_NOTIFICATION_PREFS,
    payload: { enabled },
  });
  if (message) appendLedgerEntryFromMessage(state, message);
};

// Signed, ledger-only entry addressed to the user itself; never queued, since
// self-sync already copies new ledger entries to the user's other devices.
const appendSelfPrefsEntry = async (state, enabled) => {
  const unsigned = createPeerMessageModel({
    id: createId("peer"),
    type: PEER_MESSAGE_TYPE_NOTIFICATION_PREFS,
    from_user_id: state.user.id,
    to_user_id: state.user.id,
    created_at: new Date().toISOString(),
    payload: { enabled },
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

export const publishOsNotifyTypes = async (state, types) => {
  if (!hasUser(state)) return;
  const enabled = normalizeOsNotifyTypes(types);
  await appendSelfPrefsEntry(state, enabled);
  const friends = Array.isArray(state.user.friends) ? state.user.friends : [];
  for (const friend of friends) {
    if (isPeerEligibleFriendshipStatus(friend.friendship_status)) {
      await queuePrefsTo(state, friend.person_id, enabled);
    }
  }
};

// Tell one (newly accepted) friend the user's choice, if the user ever made one.
export const shareOsNotifyTypesWith = async (state, friendId) => {
  if (!hasUser(state) || !friendId) return;
  const own = collectOsNotifyTypesByAuthor(state.ledger)[state.user.id];
  if (own) await queuePrefsTo(state, friendId, own);
};
