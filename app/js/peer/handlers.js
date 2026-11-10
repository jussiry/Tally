/*
Routes verified, deduplicated, already-appended ledger entries to
type-specific handlers that derive app-state mutations from them.

The pipeline is ledger-first: the caller (peer/bridge.js) appends the
entry to the ledger and then calls routeInboundEntry(state, entry) or
routeOutboundEntry(state, entry) on that stored entry. State is always
derived from the ledger, never the other way around, whether the entry
was produced by a local user action, received from a peer, or synced
from another device of the same user.

Each apply*Entry function takes (state, entry) and returns null if the
entry was inapplicable, or a notification object { text, hash, friendId }
on success. The notification text is reused for both the toast and the
log entry, keeping the two in sync without duplication.
@category network
*/

import {
  createPeerMessageModel,
  createTransactionModel,
  normalizeCurrencyAmount,
} from "../models/data-model.js";
import {
  cancelPendingFriendRequest,
  ensureContact,
  ensureContactBackLink,
  disableFriend,
  ensureFriend,
  getDisplayName,
  getFriend,
  removeFriendRelationshipData,
} from "../friends-helpers.js";
import { formatCurrency } from "../ui/format.js";
import { queuePeerMessage } from "./outbox.js";
import { shareOsNotifyTypesWith } from "../notify/notification-prefs.js";
import { MessageType } from "./messages.js";
import { describeSchedule, normalizeSchedule } from "../recurring.js";
import {
  appendLedgerEntryFromMessage,
  deriveTallyFromLedger,
  getFriendshipActivity,
  getOpenOfflineClaims,
  getPendingLinkPayments,
  ClaimDirection,
  mergeVerifiedEntries,
  verifyReactivationHistory,
} from "../ledger.js";
import { asTrimmedString, createId } from "../state-utils.js";
import { sha256HexOfString } from "../crypto/secp256k1.js";
import { appendSelfLedgerEntry } from "./self-entry.js";
import { reportError } from "../ui/error-report.js";
import {
  FriendshipStatus,
  PENDING_CREDIT_LIMIT_LOWERED,
  isAcceptedFriendshipStatus,
  isDeactivatedFriendshipStatus,
  isPeerEligibleFriendshipStatus,
} from "../utils/friendships.js";

const getIncomingTrustLimitFromPayload = (payload) => {
  const suggestedTrustLimit = normalizeCurrencyAmount(
    payload?.suggested_credit_limit_eur,
    NaN
  );
  return Number.isFinite(suggestedTrustLimit) && suggestedTrustLimit >= 0
    ? suggestedTrustLimit
    : null;
};

const serializePeerMessageData = (message) => {
  try {
    return JSON.stringify(createPeerMessageModel(message));
  } catch {
    return String(message);
  }
};

const warnIllegalPeerEntry = (entry) => {
  reportError("Ignored a message that isn't allowed", {
    detail: serializePeerMessageData(entry),
    toast: false,
  });
};

const notification = (text, friendId, hash) => ({ text, friendId, hash });
const friendNotification = (text, friendId) => notification(text, friendId, `friend/${friendId}`);

// TIP-4: records by link. A friend request carrying the secret of one of our
// open links comes from the person the link was for. We accept the friendship
// (if it isn't already) with no prompt; for a record we owe, we also send it,
// and an invitation is then used up.
// For a request, their client sends the record right behind the friend
// request, so it doesn't depend on the device where they accepted coming back.
// Records by link take their transaction id from the link, so a second device
// doing the same is deduplicated, and the link closes once the record is in
// the ledger (getOpenOfflineClaims).
const findClaimForProof = async (state, proof) => {
  if (typeof proof !== "string" || !proof) return null;
  const commitment = await sha256HexOfString(proof);
  return (
    getOpenOfflineClaims(state.ledger, state.user.id).find((claim) => claim.commitment === commitment) ||
    null
  );
};

/** Sends the record behind a link to an accepted friend. Returns the message, or null. */
export const sendLinkRecord = async (state, friendId, { claim_id, amount_eur, note }) => {
  const txMsg = await queuePeerMessage(state, {
    toUserId: friendId,
    type: MessageType.TRANSACTION_CREATED,
    payload: {
      transaction_id: `tx_${claim_id}`,
      amount_eur,
      date: new Date().toISOString().slice(0, 10),
      note: note || "record signed",
      message: note,
      claim_id,
    },
  });
  if (!txMsg) return null;
  appendLedgerEntryFromMessage(state, txMsg);
  routeOutboundEntry(state, txMsg);
  return txMsg;
};

const finaliseOfflineClaim = async (state, entry, claim, requesterName) => {
  const claimantId = entry.from_user_id;
  const existingFriend = getFriend(state, claimantId);
  if (isDeactivatedFriendshipStatus(existingFriend?.friendship_status)) return null;

  if (!isAcceptedFriendshipStatus(existingFriend?.friendship_status)) {
    const friend = ensureFriend(state, claimantId, requesterName, {
      friendshipStatus: FriendshipStatus.ACCEPTED,
    });
    if (!friend) return null;
    friend.friendship_status = FriendshipStatus.ACCEPTED;
    friend.person_name = requesterName;
    ensureContact(state, claimantId, requesterName);
    const acceptMsg = await queuePeerMessage(state, {
      toUserId: claimantId,
      type: MessageType.FRIEND_ACCEPT,
      payload: { accepter_name: state.user.name, trust_credit_limit_eur: 0 },
    });
    if (acceptMsg) appendLedgerEntryFromMessage(state, acceptMsg);
    await shareOsNotifyTypesWith(state, claimantId);
  }

  if (claim.direction === ClaimDirection.FRIEND) {
    // Nothing more to send: close the invitation.
    await appendSelfLedgerEntry(state, MessageType.OFFLINE_CLAIM_REVOKED, { claim_id: claim.claim_id });
    return friendNotification(`${requesterName} accepted your invitation`, claimantId);
  }
  const amountText = `€${claim.amount_eur.toFixed(2)}`;
  if (claim.direction === ClaimDirection.REQUEST) {
    return friendNotification(`${requesterName} accepted your ${amountText} request`, claimantId);
  }
  if (!(await sendLinkRecord(state, claimantId, claim))) return null;
  return friendNotification(`${requesterName} claimed the ${amountText} you recorded`, claimantId);
};

// Requests accepted from this friend's link before records went out at once
// (a self-addressed link_payment entry each), paid now that they accepted us.
// Returns how many were sent.
const sendPendingLinkPayments = async (state, friendId) => {
  let sent = 0;
  for (const payment of getPendingLinkPayments(state.ledger, state.user.id, friendId)) {
    if (await sendLinkRecord(state, friendId, payment)) sent += 1;
  }
  return sent;
};

/**
 * Sends the record for every accepted link request whose author is now an
 * accepted friend. Any of this user's devices can do it once the link_payment
 * entry reaches it through self-sync; the transaction id comes from the link,
 * so two devices sending it count once. Returns how many were sent.
 */
export const sendDueLinkPayments = async (state) => {
  let sent = 0;
  for (const friend of state.user?.friends || []) {
    if (!isAcceptedFriendshipStatus(friend.friendship_status)) continue;
    sent += await sendPendingLinkPayments(state, friend.person_id);
  }
  return sent;
};

// The opener of a request link signs its record before the author has
// accepted, so applying it to their own tally had to wait. Done now that the
// friendship is accepted; routeOutboundEntry skips a record already applied.
const applyOwnLinkRecords = (state, friendId) => {
  state.ledger
    .filter(
      (entry) =>
        entry.type === MessageType.TRANSACTION_CREATED &&
        entry.from_user_id === state.user.id &&
        entry.to_user_id === friendId &&
        typeof entry.payload?.claim_id === "string"
    )
    .reverse()
    .forEach((entry) => routeOutboundEntry(state, entry));
};

const applyInboundFriendRequest = async (state, entry) => {
  const requesterName =
    asTrimmedString(entry.payload?.requester_name) || entry.from_user_id;
  const claim = await findClaimForProof(state, entry.payload?.claim_proof);
  if (claim) {
    return finaliseOfflineClaim(state, entry, claim, requesterName);
  }
  const existingFriend = getFriend(state, entry.from_user_id);

  if (existingFriend?.friendship_status === FriendshipStatus.PENDING_OUTGOING) {
    existingFriend.friendship_status = FriendshipStatus.ACCEPTED;
    existingFriend.person_name = requesterName;
    ensureContact(state, entry.from_user_id, requesterName);
    await queuePeerMessage(state, {
      toUserId: entry.from_user_id,
      type: MessageType.FRIEND_ACCEPT,
      payload: {
        accepter_name: state.user.name,
      },
    });
    await shareOsNotifyTypesWith(state, entry.from_user_id);
    return friendNotification(`${requesterName} is now your friend`, entry.from_user_id);
  }

  // A deactivated friendship comes back only through a reactivation suggestion,
  // never a fresh request that would revive the old tally unannounced.
  if (
    isAcceptedFriendshipStatus(existingFriend?.friendship_status) ||
    isDeactivatedFriendshipStatus(existingFriend?.friendship_status)
  ) {
    return null;
  }

  if (existingFriend?.friendship_status === FriendshipStatus.PENDING_INCOMING) {
    return null;
  }

  const friend = ensureFriend(
    state,
    entry.from_user_id,
    requesterName,
    {
      friendshipStatus: FriendshipStatus.PENDING_INCOMING,
    }
  );
  if (!friend) {
    return null;
  }

  ensureContactBackLink(state, entry.from_user_id, requesterName);
  const suggestedTrustLimit = getIncomingTrustLimitFromPayload(entry.payload);
  if (suggestedTrustLimit !== null) {
    friend.trust_credit_limit_eur = suggestedTrustLimit;
  }

  friend.friendship_status = FriendshipStatus.PENDING_INCOMING;
  friend.person_name = requesterName;
  return friendNotification(`Friend request from ${requesterName}`, entry.from_user_id);
};

const applyInboundFriendAccept = async (state, entry) => {
  const accepterName =
    asTrimmedString(entry.payload?.accepter_name) || entry.from_user_id;
  let friend = getFriend(state, entry.from_user_id);
  // Track whether this is a recovery case *before* ensureFriend runs,
  // because that call sets friendship_status to ACCEPTED immediately — which
  // would otherwise make `wasAccepted` true and suppress the return value.
  const isRecovery = !friend;
  if (!friend) {
    // Recovery path: the peer is telling us we're friends but we don't remember.
    // Since they could only encrypt this message to us via ECDH (proving prior
    // relationship), trust it and re-establish the connection.
    friend = ensureFriend(state, entry.from_user_id, accepterName, {
      friendshipStatus: FriendshipStatus.ACCEPTED,
    });
    if (!friend) return null;
    ensureContactBackLink(state, entry.from_user_id, accepterName);
  }
  if (
    friend.friendship_status === FriendshipStatus.REJECTED ||
    isDeactivatedFriendshipStatus(friend.friendship_status)
  ) {
    return null;
  }

  const wasAccepted = !isRecovery && isAcceptedFriendshipStatus(friend.friendship_status);
  friend.friendship_status = FriendshipStatus.ACCEPTED;
  friend.person_name = accepterName;
  ensureContact(state, entry.from_user_id, accepterName);

  // Restore the trust limit the accepter agreed to. This is the value the
  // peer echoes back from the suggested_credit_limit_eur in our friend_request,
  // so replaying a friend_accept during sync recovery fully reconstitutes the
  // established trust limit without any extra negotiation round-trips.
  const agreedLimit = normalizeCurrencyAmount(entry.payload?.trust_credit_limit_eur, NaN);
  if (Number.isFinite(agreedLimit) && agreedLimit >= 0) {
    friend.trust_credit_limit_eur = agreedLimit;
  }

  applyOwnLinkRecords(state, entry.from_user_id);
  await sendPendingLinkPayments(state, entry.from_user_id);
  if (wasAccepted) {
    return null;
  }
  await shareOsNotifyTypesWith(state, entry.from_user_id);
  return friendNotification(`${accepterName} accepted your friend request`, entry.from_user_id);
};

const applyInboundFriendReject = async (state, entry) => {
  const displayName = getDisplayName(state, entry.from_user_id);
  const applied = await cancelPendingFriendRequest(state, entry.from_user_id, {
    direction: "from",
    displayName,
    skipLog: true,
  });
  if (!applied) {
    return null;
  }
  return notification(`${displayName} rejected your friend request`, entry.from_user_id, "friends");
};

const applyInboundTrustLimitSuggestion = (state, entry) => {
  const trustLimit = normalizeCurrencyAmount(entry.payload?.credit_limit_eur, NaN);
  if (!Number.isFinite(trustLimit) || trustLimit < 0) {
    return null;
  }

  const displayName = getDisplayName(state, entry.from_user_id);
  const friend = getFriend(state, entry.from_user_id);
  if (
    !friend ||
    !isPeerEligibleFriendshipStatus(friend.friendship_status)
  ) {
    return null;
  }

  const existingLimit = friend.trust_credit_limit_eur || 0;
  const pendingOutgoing = friend.pending_credit_limit_is_incoming === false
    ? friend.pending_credit_limit_eur
    : null;
  const wasIncoming = friend.pending_credit_limit_is_incoming === true;

  if (Number.isFinite(pendingOutgoing) && trustLimit === pendingOutgoing) {
    // Peer accepted our suggestion — apply it locally now
    friend.trust_credit_limit_eur = trustLimit;
    friend.pending_credit_limit_eur = null;
    friend.pending_credit_limit_is_incoming = null;
    return friendNotification(
      `${displayName} agreed on trust limit of ${formatCurrency(trustLimit)}`,
      entry.from_user_id,
    );
  }

  if (trustLimit === existingLimit && friend.pending_credit_limit_eur !== null) {
    // Peer cancelled or declined — clear pending
    friend.pending_credit_limit_eur = null;
    friend.pending_credit_limit_is_incoming = null;
    if (wasIncoming) {
      return friendNotification(`${displayName} cancelled trust limit suggestion`, entry.from_user_id);
    }
    return friendNotification(`${displayName} rejected trust limit suggestion`, entry.from_user_id);
  }

  if (trustLimit < existingLimit) {
    // Lower: apply automatically, show notification
    friend.trust_credit_limit_eur = trustLimit;
    friend.pending_credit_limit_eur = trustLimit;
    friend.pending_credit_limit_is_incoming = PENDING_CREDIT_LIMIT_LOWERED;
    return friendNotification(
      `${displayName} lowered trust limit to ${formatCurrency(trustLimit)}`,
      entry.from_user_id,
    );
  }

  if (trustLimit === existingLimit) {
    // Same as current with no pending: no-op
    return null;
  }

  // Higher than current: let user decide
  friend.pending_credit_limit_eur = trustLimit;
  friend.pending_credit_limit_is_incoming = true;
  return friendNotification(
    `${displayName} suggested trust limit of ${formatCurrency(trustLimit)}`,
    entry.from_user_id,
  );
};

const applyInboundNameChanged = (state, entry) => {
  const newName = asTrimmedString(entry.payload?.name);
  if (!newName) return null;

  const friend = getFriend(state, entry.from_user_id);
  if (!friend || !isPeerEligibleFriendshipStatus(friend.friendship_status)) {
    return null;
  }

  const oldName = friend.person_name || entry.from_user_id;
  friend.person_name = newName;
  ensureContact(state, entry.from_user_id, newName);

  if (oldName === newName) return null;
  friend.pending_name_change = { oldName, newName };
  return friendNotification(`${oldName} changed their name to ${newName}`, entry.from_user_id);
};

// A friend's OS-notification choice changes no friend state either: it is read
// from the ledger when building push hints (notification-policy.js). The entry
// only needs vetting; the empty text keeps it out of the toasts.
const applyInboundNotificationPrefs = (state, entry) => {
  if (!Array.isArray(entry.payload?.enabled)) return null;
  const friend = getFriend(state, entry.from_user_id);
  if (!friend || !isPeerEligibleFriendshipStatus(friend.friendship_status)) {
    return null;
  }
  return notification("", entry.from_user_id, "");
};

// Payment requests, their responses, and cancellations change no friend state:
// whether a request is still open is derived from the ledger entries themselves
// (see getOpenPaymentRequests in ledger.ts). These handlers only vet an entry
// and word its notification. A closing entry for an already-closed request is
// still accepted — when a cancel crosses a payment in flight, the ledger should
// record both, and the notification tells the requester money did move.
const isFromAcceptedFriend = (state, entry) => {
  const friend = getFriend(state, entry.from_user_id);
  return Boolean(friend) && isAcceptedFriendshipStatus(friend.friendship_status);
};

const applyInboundPaymentRequest = (state, entry) => {
  const amount = normalizeCurrencyAmount(entry.payload?.amount_eur, NaN);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!isFromAcceptedFriend(state, entry)) return null;

  const schedule = normalizeSchedule(entry.payload?.schedule);
  const recurrence = schedule ? ` ${describeSchedule(schedule)}` : "";
  return friendNotification(
    `${getDisplayName(state, entry.from_user_id)} requested €${amount.toFixed(2)}${recurrence}`,
    entry.from_user_id,
  );
};

// Recurring payments, like payment requests, are read off the ledger
// (getActiveRecurringPayments in js/recurring.js); these only vet and word.
const applyInboundRecurringPaymentCreated = (state, entry) => {
  const amount = normalizeCurrencyAmount(entry.payload?.amount_eur, NaN);
  const schedule = normalizeSchedule(entry.payload?.schedule);
  if (!(amount > 0) || !schedule) return null;
  if (!isFromAcceptedFriend(state, entry)) return null;

  return friendNotification(
    `${getDisplayName(state, entry.from_user_id)} set up a payment of €${amount.toFixed(2)} to you, ${describeSchedule(schedule)}`,
    entry.from_user_id,
  );
};

const applyInboundRecurringPaymentCancel = (state, entry) => {
  if (!asTrimmedString(entry.payload?.recurring_id)) return null;
  if (!isFromAcceptedFriend(state, entry)) return null;

  return friendNotification(
    `${getDisplayName(state, entry.from_user_id)} cancelled their recurring payment`,
    entry.from_user_id,
  );
};

const applyInboundPaymentRequestCancel = (state, entry) => {
  if (!asTrimmedString(entry.payload?.request_id)) return null;
  if (!isFromAcceptedFriend(state, entry)) return null;

  return friendNotification(
    `${getDisplayName(state, entry.from_user_id)} cancelled their payment request`,
    entry.from_user_id,
  );
};

const applyInboundPaymentRequestResponse = (state, entry) => {
  if (!asTrimmedString(entry.payload?.request_id)) return null;
  if (!isFromAcceptedFriend(state, entry)) return null;

  const displayName = getDisplayName(state, entry.from_user_id);
  if (entry.payload?.accepted === true) {
    return friendNotification(
      `${displayName} accepted your payment request`,
      entry.from_user_id,
    );
  }
  return friendNotification(
    `${displayName} declined your payment request`,
    entry.from_user_id,
  );
};

const applyInboundTransactionCreated = (state, entry) => {
  const amount = normalizeCurrencyAmount(entry.payload?.amount_eur, NaN);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const displayName = getDisplayName(state, entry.from_user_id);
  const friend = getFriend(state, entry.from_user_id);
  if (!friend || !isAcceptedFriendshipStatus(friend.friendship_status)) {
    return null;
  }

  const transactionId =
    asTrimmedString(entry.payload?.transaction_id) || asTrimmedString(entry.id) || createId("tx");

  // Idempotent: if we already recorded this transaction (e.g. the entry is
  // being replayed during recovery), don't double-count.
  if (
    Array.isArray(friend.recent_transactions) &&
    friend.recent_transactions.some((tx) => tx.id === transactionId)
  ) {
    return null;
  }

  const date =
    asTrimmedString(entry.payload?.date) || new Date().toISOString().slice(0, 10);
  const note =
    asTrimmedString(entry.payload?.note) || "IOU received";

  friend.person_name = displayName;
  friend.debt_eur = (friend.debt_eur || 0) + amount;
  friend.recent_transactions.unshift(
    createTransactionModel({
      id: transactionId,
      date,
      amount_eur: amount,
      note,
    })
  );

  return friendNotification(`${displayName} sent €${amount.toFixed(2)} to you`, entry.from_user_id);
};

// Defaulting disables the friendship on both sides; the tally text is worded
// from this user's side. A default crossing our own is still recorded, so
// both appear in the ledger.
const applyInboundFriendshipDefault = (state, entry) => {
  const friend = getFriend(state, entry.from_user_id);
  if (
    !friend ||
    !(isAcceptedFriendshipStatus(friend.friendship_status) ||
      isDeactivatedFriendshipStatus(friend.friendship_status))
  ) {
    return null;
  }
  disableFriend(friend);

  const displayName = getDisplayName(state, entry.from_user_id);
  const tally = friend.debt_eur || 0;
  const text =
    tally > 0
      ? `${displayName} defaulted on ${formatCurrency(tally)}`
      : tally < 0
      ? `${displayName} absolved your tally of ${formatCurrency(-tally)}`
      : `${displayName} deactivated your friend connection`;
  return friendNotification(text, entry.from_user_id);
};

// A reactivation suggestion carries the requester's copy of the shared
// history. Every entry is verified (ledger.ts verifyReactivationHistory) and
// merged, so a user who deleted the history gets it back — first as a
// deactivated friend with the rebuilt tally, active again only once they accept.
const applyInboundReactivationRequest = async (state, entry) => {
  const requesterId = entry.from_user_id;
  if (!asTrimmedString(entry.payload?.request_id)) return null;
  let friend = getFriend(state, requesterId);
  if (friend && !isDeactivatedFriendshipStatus(friend.friendship_status)) return null;

  const history = await verifyReactivationHistory(entry.payload?.history, requesterId, state.user.id);
  if (!history) {
    reportError("Ignored a reactivation request whose history couldn't be verified", { detail: entry.id });
    return null;
  }

  const isRestored = !friend;
  if (!friend) {
    const requesterName = asTrimmedString(entry.payload?.requester_name) || requesterId;
    friend = ensureFriend(state, requesterId, requesterName, {
      friendshipStatus: FriendshipStatus.DEACTIVATED,
    });
    if (!friend) return null;
    ensureContactBackLink(state, requesterId, requesterName);
    const limit = normalizeCurrencyAmount(entry.payload?.trust_credit_limit_eur, NaN);
    if (Number.isFinite(limit) && limit >= 0) friend.trust_credit_limit_eur = limit;
  }

  const added = mergeVerifiedEntries(state, history);
  // Rebuild the tally when the history was gone, or when it brought records
  // this side never applied (e.g. one sent while the default was in flight).
  const addedRecords = added > 0 && history.some(
    (record) =>
      record.type === MessageType.TRANSACTION_CREATED &&
      !friend.recent_transactions.some(
        (tx) => tx.id === (asTrimmedString(record.payload?.transaction_id) || record.id)
      )
  );
  if (isRestored || addedRecords) {
    Object.assign(friend, deriveTallyFromLedger(state.ledger, state.user.id, requesterId));
  }

  return friendNotification(
    `${getDisplayName(state, requesterId)} suggests reactivating your friendship`,
    requesterId,
  );
};

const hasOwnReactivationRequest = (state, friendId, requestId) =>
  state.ledger.some(
    (entry) =>
      entry.type === MessageType.REACTIVATION_REQUEST &&
      entry.from_user_id === state.user.id &&
      entry.to_user_id === friendId &&
      entry.payload?.request_id === requestId
  );

const applyInboundReactivationResponse = async (state, entry) => {
  const requestId = asTrimmedString(entry.payload?.request_id);
  const friend = getFriend(state, entry.from_user_id);
  if (!requestId || !friend || !isDeactivatedFriendshipStatus(friend.friendship_status)) return null;
  if (!hasOwnReactivationRequest(state, entry.from_user_id, requestId)) return null;

  const displayName = getDisplayName(state, entry.from_user_id);
  if (entry.payload?.accepted !== true) {
    return friendNotification(`${displayName} declined reactivating your friendship`, entry.from_user_id);
  }
  friend.friendship_status = FriendshipStatus.ACCEPTED;
  await shareOsNotifyTypesWith(state, entry.from_user_id);
  return friendNotification(
    `${displayName} accepted — your friendship is active again`,
    entry.from_user_id,
  );
};

const createInboundProcessingResult = (view, acknowledgeResult = null) => {
  return {
    acknowledgeResult,
    view,
  };
};

/**
 * Derive app-state mutations from a ledger entry authored by a peer
 * (from_user_id = peer, to_user_id = me). The caller owns appending the
 * entry to the ledger, deduplication, last_synced_at, and persistence —
 * this function only derives the state change.
 *
 * Returns a notification `{ text, hash, friendId }` on success or `null`
 * if the entry was inapplicable (e.g. already-accepted friend_request).
 */
export const routeInboundEntry = async (state, entry) => {
  switch (entry.type) {
    case MessageType.FRIEND_REQUEST:
      return await applyInboundFriendRequest(state, entry);
    case MessageType.FRIEND_ACCEPT:
      return await applyInboundFriendAccept(state, entry);
    case MessageType.FRIEND_REJECT:
      return await applyInboundFriendReject(state, entry);
    case MessageType.TRUST_LIMIT_SUGGESTION:
      return applyInboundTrustLimitSuggestion(state, entry);
    case MessageType.PAYMENT_REQUEST:
      return applyInboundPaymentRequest(state, entry);
    case MessageType.PAYMENT_REQUEST_RESPONSE:
      return applyInboundPaymentRequestResponse(state, entry);
    case MessageType.PAYMENT_REQUEST_CANCEL:
      return applyInboundPaymentRequestCancel(state, entry);
    case MessageType.RECURRING_PAYMENT_CREATED:
      return applyInboundRecurringPaymentCreated(state, entry);
    case MessageType.RECURRING_PAYMENT_CANCEL:
      return applyInboundRecurringPaymentCancel(state, entry);
    case MessageType.TRANSACTION_CREATED:
      return applyInboundTransactionCreated(state, entry);
    case MessageType.NAME_CHANGED:
      return applyInboundNameChanged(state, entry);
    case MessageType.NOTIFICATION_PREFS:
      return applyInboundNotificationPrefs(state, entry);
    case MessageType.FRIENDSHIP_DEFAULT:
      return applyInboundFriendshipDefault(state, entry);
    case MessageType.REACTIVATION_REQUEST:
      return await applyInboundReactivationRequest(state, entry);
    case MessageType.REACTIVATION_RESPONSE:
      return await applyInboundReactivationResponse(state, entry);
    default:
      warnIllegalPeerEntry(entry);
      return null;
  }
};

export { createInboundProcessingResult };

// ---------------------------------------------------------------------------
// Outbound entry application
// ---------------------------------------------------------------------------
// The symmetric counterpart to routeInboundEntry. Applies a ledger entry
// authored by this user (from_user_id === myId, to_user_id === peerId) to
// local app state. Called both when a command runs on this device AND when
// the same entry arrives via self-mesh sync from another device.
//
// Returning true means state was mutated; false means the entry was a no-op
// (already applied or not applicable). Callers own persistence.

const applyOutboundFriendRequest = (state, entry) => {
  const toId = asTrimmedString(entry.to_user_id);
  if (!toId) return false;
  // Create PENDING_OUTGOING only when no friend exists — don't overwrite
  // an already-accepted or already-pending connection.
  if (!getFriend(state, toId)) {
    ensureFriend(state, toId, toId, {
      friendshipStatus: FriendshipStatus.PENDING_OUTGOING,
    });
    return true;
  }
  return false;
};

const applyOutboundFriendAccept = (state, entry) => {
  const toId = asTrimmedString(entry.to_user_id);
  if (!toId) return false;
  let friend = getFriend(state, toId);
  let changed = false;
  if (!friend) {
    // No prior friend on this device — create it as accepted.
    friend = ensureFriend(state, toId, toId, {
      friendshipStatus: FriendshipStatus.ACCEPTED,
    });
    changed = !!friend;
  } else if (isDeactivatedFriendshipStatus(friend.friendship_status)) {
    // An old accept replayed by sync must not undo a later default.
    return false;
  } else if (friend.friendship_status !== FriendshipStatus.ACCEPTED) {
    friend.friendship_status = FriendshipStatus.ACCEPTED;
    changed = true;
  }
  // Restore the trust limit that was agreed to (echoed back in the accept payload).
  if (friend) {
    const limit = normalizeCurrencyAmount(entry.payload?.trust_credit_limit_eur, NaN);
    if (Number.isFinite(limit) && limit >= 0) {
      friend.trust_credit_limit_eur = limit;
    }
  }
  return changed;
};

const applyOutboundFriendReject = (state, entry) => {
  const toId = asTrimmedString(entry.to_user_id);
  if (!toId) return false;
  if (!getFriend(state, toId)) return false;
  removeFriendRelationshipData(state, toId);
  return true;
};

const applyOutboundTransactionCreated = (state, entry) => {
  const toId = asTrimmedString(entry.to_user_id);
  if (!toId) return false;
  const friend = getFriend(state, toId);
  if (!friend || !isAcceptedFriendshipStatus(friend.friendship_status)) return false;

  // Idempotent: skip if this transaction is already recorded.
  const txId = asTrimmedString(entry.payload?.transaction_id) || asTrimmedString(entry.id);
  if (
    txId &&
    Array.isArray(friend.recent_transactions) &&
    friend.recent_transactions.some((tx) => tx.id === txId)
  ) {
    return false;
  }

  const amount = normalizeCurrencyAmount(entry.payload?.amount_eur, NaN);
  if (!Number.isFinite(amount) || amount <= 0) return false;

  const date = asTrimmedString(entry.payload?.date) || new Date().toISOString().slice(0, 10);
  const note = asTrimmedString(entry.payload?.note) || "record signed";

  if (!Array.isArray(friend.recent_transactions)) friend.recent_transactions = [];
  friend.debt_eur = (friend.debt_eur || 0) - amount;
  friend.recent_transactions.unshift(
    createTransactionModel({ id: txId || createId("tx"), date, amount_eur: -amount, note })
  );
  return true;
};

const applyOutboundCreditLimitSuggestion = (state, entry) => {
  const toId = asTrimmedString(entry.to_user_id);
  if (!toId) return false;
  const friend = getFriend(state, toId);
  if (!friend || !isPeerEligibleFriendshipStatus(friend.friendship_status)) return false;

  const suggestedLimit = normalizeCurrencyAmount(entry.payload?.credit_limit_eur, NaN);
  if (!Number.isFinite(suggestedLimit) || suggestedLimit < 0) return false;

  const existingLimit = friend.trust_credit_limit_eur || 0;

  // Acceptance echo: the outbound value matches a currently-incoming pending
  // suggestion, meaning we accepted the peer's proposal on another device.
  if (
    friend.pending_credit_limit_is_incoming === true &&
    friend.pending_credit_limit_eur === suggestedLimit
  ) {
    friend.trust_credit_limit_eur = suggestedLimit;
    friend.pending_credit_limit_eur = null;
    friend.pending_credit_limit_is_incoming = null;
    return true;
  }

  if (existingLimit > 0 && suggestedLimit < existingLimit) {
    // Lowering: apply immediately; peer auto-applies on receive.
    friend.trust_credit_limit_eur = suggestedLimit;
    friend.pending_credit_limit_eur = null;
    friend.pending_credit_limit_is_incoming = null;
  } else if (suggestedLimit === existingLimit) {
    // Sending back current value = cancel or rejection echo; clear pending.
    friend.pending_credit_limit_eur = null;
    friend.pending_credit_limit_is_incoming = null;
  } else {
    // New or higher limit: wait for peer to agree.
    friend.pending_credit_limit_eur = suggestedLimit;
    friend.pending_credit_limit_is_incoming = false;
  }
  return true;
};

const applyOutboundFriendshipDefault = (state, entry) => {
  const friend = getFriend(state, asTrimmedString(entry.to_user_id));
  if (!friend || !isAcceptedFriendshipStatus(friend.friendship_status)) return false;
  disableFriend(friend);
  return true;
};

// Accepting a friend's reactivation suggestion on this or another device.
const applyOutboundReactivationResponse = (state, entry) => {
  if (entry.payload?.accepted !== true) return false;
  const friend = getFriend(state, asTrimmedString(entry.to_user_id));
  if (!friend || !isDeactivatedFriendshipStatus(friend.friendship_status)) return false;
  friend.friendship_status = FriendshipStatus.ACCEPTED;
  return true;
};

/**
 * Apply an outbound ledger entry (authored by this user, sent to a peer) to
 * local app state. The mutation is identical whether the entry was just
 * created by a local command or arrived via self-mesh sync from another
 * device. Returns true if state was mutated.
 */
export const routeOutboundEntry = (state, entry) => {
  if (!entry || !state.user?.id) return false;
  if (entry.from_user_id !== state.user.id) return false;
  const toId = asTrimmedString(entry.to_user_id);
  if (!toId || toId === state.user.id) return false;

  switch (entry.type) {
    case MessageType.FRIEND_REQUEST:
      return applyOutboundFriendRequest(state, entry);
    case MessageType.FRIEND_ACCEPT:
      return applyOutboundFriendAccept(state, entry);
    case MessageType.FRIEND_REJECT:
      return applyOutboundFriendReject(state, entry);
    case MessageType.TRANSACTION_CREATED:
      return applyOutboundTransactionCreated(state, entry);
    // Payment requests, recurring payments, and their responses and cancels
    // need no case: their state is derived from the ledger, so there is
    // nothing to mutate.
    case MessageType.TRUST_LIMIT_SUGGESTION:
      return applyOutboundCreditLimitSuggestion(state, entry);
    case MessageType.FRIENDSHIP_DEFAULT:
      return applyOutboundFriendshipDefault(state, entry);
    // A reactivation request changes nothing until it is answered.
    case MessageType.REACTIVATION_RESPONSE:
      return applyOutboundReactivationResponse(state, entry);
    default:
      return false;
  }
};

/**
 * Bring every friendship's active/deactivated status in line with the
 * ledger (ledger.ts getFriendshipActivity). Run after each batch of synced
 * entries and once at startup: the per-entry handlers above see entries in
 * arrival order, which across devices is not the order they were made in.
 * Returns the number of friends changed.
 */
export const reconcileFriendshipStatuses = (state) => {
  if (!state?.user?.id || !Array.isArray(state.user.friends)) return 0;
  const activity = getFriendshipActivity(state.ledger, state.user.id);
  let changed = 0;
  for (const friend of state.user.friends) {
    const active = activity.get(friend.person_id);
    if (active === undefined) continue;
    if (!active && isAcceptedFriendshipStatus(friend.friendship_status)) {
      disableFriend(friend);
      changed += 1;
    } else if (active && isDeactivatedFriendshipStatus(friend.friendship_status)) {
      friend.friendship_status = FriendshipStatus.ACCEPTED;
      changed += 1;
    }
  }
  return changed;
};
