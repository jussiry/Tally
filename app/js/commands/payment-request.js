/*
Payment-request commands: asking a friend to pay you, responding to one of
their requests, and cancelling one of your own.

Any number of requests can be open with the same friend. None of them is
stored on the friend record: a request is open for as long as the ledger holds
no response or cancel for its request_id (see getOpenPaymentRequests in
ledger.ts). So these commands only append messages; the friend page reads the
open list back off the ledger, on every device, whatever order sync delivers
entries in.

Paying a request also creates the mirroring IOU transaction in the same tick —
accepting is equivalent to sending the friend an IOU, so tallies stay
consistent. That transaction goes through routeOutboundEntry like any other.
@category command
*/

import { normalizeCurrencyAmount } from "../models/data-model.js";
import { MessageType } from "../peer/messages.js";
import { isAcceptedFriendshipStatus } from "../utils/friendships.js";
import { asTrimmedString, createId, hasUser } from "../state-utils.js";
import {
  loadData,
  loadState,
  persistAndBuildView,
} from "../app-state.js";
import { queuePeerMessage } from "../peer/outbox.js";
import { getFriend } from "../friends-helpers.js";
import { appendLedgerEntryFromMessage, getOpenPaymentRequests } from "../ledger.js";
import { routeOutboundEntry } from "../peer/handlers.js";

export const requestPayment = async ({ friendId, amount, message }) => {
  const normalizedFriendId = asTrimmedString(friendId);
  const normalizedAmount = normalizeCurrencyAmount(amount, NaN);
  if (!normalizedFriendId || !Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    return loadData();
  }

  const state = await loadState();
  if (!hasUser(state)) {
    return null;
  }

  const friend = getFriend(state, normalizedFriendId);
  if (!friend || !isAcceptedFriendshipStatus(friend.friendship_status)) {
    return loadData();
  }

  const trimmedMessage = asTrimmedString(message);
  const requestId = createId("pr");

  const prMsg = await queuePeerMessage(state, {
    toUserId: normalizedFriendId,
    type: MessageType.PAYMENT_REQUEST,
    payload: {
      request_id: requestId,
      amount_eur: normalizedAmount,
      note: trimmedMessage,
    },
  });
  appendLedgerEntryFromMessage(state, prMsg);

  return persistAndBuildView(state);
};

// Load state and find one of this friend's still-open requests, in the given
// direction. Returns null (and the caller bails) when the friend is gone, no
// longer accepted, or the request has meanwhile been answered or cancelled.
const loadOpenRequest = async (friendId, requestId, { incoming }) => {
  const normalizedFriendId = asTrimmedString(friendId);
  const normalizedRequestId = asTrimmedString(requestId);
  if (!normalizedFriendId || !normalizedRequestId) return null;

  const state = await loadState();
  if (!hasUser(state)) return null;

  const friend = getFriend(state, normalizedFriendId);
  if (!friend || !isAcceptedFriendshipStatus(friend.friendship_status)) return null;

  const request = (getOpenPaymentRequests(state.ledger, state.user.id).get(normalizedFriendId) ?? [])
    .find((open) => open.id === normalizedRequestId && open.is_incoming === incoming);
  return request ? { state, friendId: normalizedFriendId, request } : null;
};

export const respondToPaymentRequest = async (friendId, requestId, accepted) => {
  const found = await loadOpenRequest(friendId, requestId, { incoming: true });
  if (!found) return loadData();
  const { state, friendId: toUserId, request } = found;

  const responseMsg = await queuePeerMessage(state, {
    toUserId,
    type: MessageType.PAYMENT_REQUEST_RESPONSE,
    payload: {
      request_id: request.id,
      accepted,
    },
  });
  appendLedgerEntryFromMessage(state, responseMsg);

  if (accepted) {
    const transactionId = createId("tx");
    const date = new Date().toISOString().slice(0, 10);
    const note = request.note || "Payment request accepted";

    const txMsg = await queuePeerMessage(state, {
      toUserId,
      type: MessageType.TRANSACTION_CREATED,
      payload: {
        transaction_id: transactionId,
        amount_eur: request.amount_eur,
        date,
        note,
        message: request.note,
      },
    });
    appendLedgerEntryFromMessage(state, txMsg);
    routeOutboundEntry(state, txMsg);
  }

  return persistAndBuildView(state);
};

// Withdraw one of our own open requests. Unlike a local dismissal, this tells
// the friend: the cancel is a durable message, so their copy closes too.
export const cancelPaymentRequest = async (friendId, requestId) => {
  const found = await loadOpenRequest(friendId, requestId, { incoming: false });
  if (!found) return loadData();
  const { state, friendId: toUserId, request } = found;

  const cancelMsg = await queuePeerMessage(state, {
    toUserId,
    type: MessageType.PAYMENT_REQUEST_CANCEL,
    payload: { request_id: request.id },
  });
  appendLedgerEntryFromMessage(state, cancelMsg);

  return persistAndBuildView(state);
};
