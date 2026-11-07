/*
Records by link (TIP-4): invite someone not on Tally yet as a friend, give
them a record, or ask them for one, with a link shared any way the user likes.

The author writes a signed, self-addressed entry for the link: its direction,
amount, note, and a commitment to a secret that travels only in the link. The
entry lets the author's devices list the link, share it again or withdraw it,
and recognise the person who opens it. It closes once the record carrying its
claim_id is in the ledger.

The opener's client (claimFromLink) sends the author a friend request carrying
the secret, and the author's client accepts at once (peer/handlers.js). For a
record sent, the author's client then sends it. For a request, the opener has
agreed to the amount; their client keeps a self-addressed link_payment entry
and sends the record when the author's accept arrives, or at once if the two
are already friends. A request is no promise, so nothing is owed until the
opener signs that record.
@category command
*/

import { loadData, loadState, persistAndBuildView } from "../app-state.js";
import { normalizeCurrencyAmount } from "../models/data-model.js";
import { MessageType } from "../peer/messages.js";
import { queuePeerMessage } from "../peer/outbox.js";
import { appendSelfLedgerEntry } from "../peer/self-entry.js";
import { sendLinkRecord } from "../peer/handlers.js";
import { ClaimDirection, getOpenOfflineClaims, appendLedgerEntryFromMessage } from "../ledger.js";
import { sha256HexOfString } from "../crypto/secp256k1.js";
import { asTrimmedString, createId, hasUser } from "../state-utils.js";
import { getFriend } from "../friends-helpers.js";
import { isAcceptedFriendshipStatus, isDeactivatedFriendshipStatus } from "../utils/friendships.js";
import { createFriend } from "./friendship.js";
import { createClaimSecret, encodeClaimLink } from "../utils/claim-link.js";

const getShareableRelays = (state) =>
  state.share_my_relays === false ? [] : Array.isArray(state.relays) ? state.relays : [];

/** The link for an open claim of this user's. */
export const getClaimLink = (state, claim) =>
  encodeClaimLink(window.location.origin, {
    direction: claim.direction,
    claimId: claim.claim_id,
    key: state.user.id,
    secret: claim.secret,
    senderName: state.user.name,
    recipientName: claim.recipient_name,
    amount: claim.amount_eur,
    note: claim.note,
    relays: getShareableRelays(state),
  });

export const createOfflineClaim = async ({ direction, recipientName, amount, note }) => {
  const normalizedDirection = Object.values(ClaimDirection).includes(direction) ? direction : ClaimDirection.SEND;
  const isInvitation = normalizedDirection === ClaimDirection.FRIEND;
  const normalizedAmount = isInvitation ? 0 : normalizeCurrencyAmount(amount, NaN);
  const name = asTrimmedString(recipientName);
  if (!name || (!isInvitation && !(normalizedAmount > 0))) return null;

  const state = await loadState();
  if (!hasUser(state)) return null;

  const secret = createClaimSecret();
  const claim = {
    claim_id: createId("claim"),
    direction: normalizedDirection,
    commitment: await sha256HexOfString(secret),
    // Kept so the link can be shared again, from any of this user's devices.
    // Self-addressed entries never leave the user's own devices.
    secret,
    amount_eur: normalizedAmount,
    note: isInvitation ? "" : asTrimmedString(note),
    recipient_name: name,
  };
  await appendSelfLedgerEntry(state, MessageType.OFFLINE_CLAIM, claim);
  await persistAndBuildView(state);
  return { claim, link: getClaimLink(state, claim) };
};

export const revokeOfflineClaim = async (claimId) => {
  const state = await loadState();
  if (!hasUser(state)) return null;
  const isOpen = getOpenOfflineClaims(state.ledger, state.user.id).some((c) => c.claim_id === claimId);
  if (!isOpen) return loadData();
  await appendSelfLedgerEntry(state, MessageType.OFFLINE_CLAIM_REVOKED, { claim_id: claimId });
  return persistAndBuildView(state);
};

const sendFriendRequestWithProof = async (state, parsed) => {
  const requestMsg = await queuePeerMessage(state, {
    toUserId: parsed.key,
    type: MessageType.FRIEND_REQUEST,
    payload: { requester_name: state.user.name, claim_proof: parsed.secret },
  });
  if (requestMsg) appendLedgerEntryFromMessage(state, requestMsg);
};

/**
 * Opener side: act on a record link, on a brand-new account or an existing
 * one, whether or not the author is already a friend. For a request, the
 * caller has already asked the user to agree. Resolves "sent", "self" or
 * "unavailable".
 */
export const claimFromLink = async (parsed) => {
  const state = await loadState();
  if (!hasUser(state) || !parsed?.key || !parsed?.secret) return "unavailable";
  if (parsed.key === state.user.id) return "self";

  const friend = getFriend(state, parsed.key);
  if (isDeactivatedFriendshipStatus(friend?.friendship_status)) return "unavailable";

  if (parsed.isRequest) {
    const payment = { claim_id: parsed.claimId, amount_eur: parsed.amount, note: parsed.note };
    if (isAcceptedFriendshipStatus(friend?.friendship_status)) {
      await sendLinkRecord(state, parsed.key, payment);
      await persistAndBuildView(state);
      return "sent";
    }
    await appendSelfLedgerEntry(state, MessageType.LINK_PAYMENT, { ...payment, friend_id: parsed.key });
  }

  if (!friend) {
    // Persist the link_payment first: createFriend loads its own copy of state.
    await persistAndBuildView(state);
    await createFriend({
      friendId: parsed.key,
      name: parsed.senderName,
      relays: parsed.relays,
      claimProof: parsed.secret,
    });
    return "sent";
  }

  // Already connected (or a request is pending): send the proof in a request
  // of its own; the author's client handles it before any status checks.
  await sendFriendRequestWithProof(state, parsed);
  await persistAndBuildView(state);
  return "sent";
};
