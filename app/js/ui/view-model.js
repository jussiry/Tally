/*
Derives a read-only view model from persisted app state.

The view model aggregates balance totals, trust agreements, and connection
data so that page binders never need to compute these values themselves.
@category ui
*/

import { createPublicPersonModel } from "../models/data-model.js";
import {
  isAcceptedFriendshipStatus,
  isDisabledFriendshipStatus,
} from "../utils/friendships.js";
import { getMainRelayUrl } from "../utils/relay-url.js";
import { getRelayStatus } from "../signaling/relay-status-registry.js";
import {
  getLatestFriendshipDefaults,
  getOpenPaymentRequests,
  getOpenReactivationRequests,
} from "../ledger.js";

export const buildView = (state) => {
  const user = state.user;
  const friends = Array.isArray(user.friends) ? user.friends : [];
  const openPaymentRequests = getOpenPaymentRequests(state.ledger, user.id);
  const latestDefaults = getLatestFriendshipDefaults(state.ledger, user.id);
  const openReactivations = getOpenReactivationRequests(state.ledger, user.id);

  const friendsWithInbound = friends.map((friend) => {
    const contact = state.contacts?.[friend.person_id];

    return {
      ...friend,
      person_name: contact?.name || friend.person_name || friend.person_id,
      // Only an accepted friend can be asked to pay or answer a request.
      pending_payment_requests: isAcceptedFriendshipStatus(friend.friendship_status)
        ? openPaymentRequests.get(friend.person_id) ?? []
        : [],
      // A disabled friend's page shows the default and any open suggestion.
      default_info: isDisabledFriendshipStatus(friend.friendship_status)
        ? latestDefaults.get(friend.person_id) ?? null
        : null,
      pending_reactivation: isDisabledFriendshipStatus(friend.friendship_status)
        ? openReactivations.get(friend.person_id) ?? null
        : null,
    };
  });

  const acceptedFriends = friendsWithInbound.filter((friend) =>
    isAcceptedFriendshipStatus(friend.friendship_status)
  );

  const trustAgreements = acceptedFriends.reduce((sum, friend) => {
    return sum + (friend.trust_credit_limit_eur || 0);
  }, 0);

  const friendsOweTotal = acceptedFriends.reduce((sum, friend) => {
    return sum + Math.max(friend.debt_eur || 0, 0);
  }, 0);
  const youOweTotal = acceptedFriends.reduce((sum, friend) => {
    return sum + Math.max(-(friend.debt_eur || 0), 0);
  }, 0);
  const totalTally = friendsOweTotal - youOweTotal;

  const availableTrust = acceptedFriends.reduce((sum, friend) => {
    const trustLimit = friend.trust_credit_limit_eur || 0;
    const tally = friend.debt_eur || 0;
    return sum + Math.max(trustLimit + tally, 0);
  }, 0);

  // Relay list: the main relay (current host) is always first and undeletable.
  // Secondary relays come from `state.relays`. Live connection statuses come
  // from `relay-status-registry`, which the relay pool writes to as sockets
  // open and close. The view-model reads the current snapshot at build time
  // and the pool re-emits the view whenever a status flips.
  const mainRelayUrl = getMainRelayUrl();
  const secondaryRelayUrls = Array.isArray(state.relays) ? state.relays : [];
  const relays = [
    { url: mainRelayUrl, is_main: true, status: getRelayStatus(mainRelayUrl) },
    ...secondaryRelayUrls.map((url) => ({
      url,
      is_main: false,
      status: getRelayStatus(url),
    })),
  ];

  return {
    you: createPublicPersonModel(user),
    friends: friendsWithInbound,
    totals: {
      totalTally,
      friendsOweTotal,
      youOweTotal,
      trustAgreements,
      availableTrust,
    },
    ledger: Array.isArray(state.ledger) ? state.ledger : [],
    relays,
    shareMyRelays: state.share_my_relays !== false,
    // STUN servers hold no persistent connection, so (unlike relays) there is
    // no live status to surface — just the configured URL list.
    stunServers: Array.isArray(state.stun_servers) ? state.stun_servers : [],
  };
};
