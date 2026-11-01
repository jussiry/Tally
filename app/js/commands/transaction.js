/*
IOU transaction command. Records that the user has signed a tally toward a
friend (a "sent IOU"), updates the running friend tally, and propagates the
transaction to the peer so both sides agree on the tally.

State is mutated via routeOutboundEntry so the same logic runs whether the
transaction was created on this device or received via self-mesh sync.
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
import { getDisplayName, getFriend } from "../friends-helpers.js";
import { appendLedgerEntryFromMessage } from "../ledger.js";
import { routeOutboundEntry } from "../peer/handlers.js";

export const createTransaction = async ({ friendId, amount, message }) => {
  const normalizedFriendId = asTrimmedString(friendId);
  const normalizedAmount = normalizeCurrencyAmount(amount, NaN);
  if (!normalizedFriendId || !Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    return loadData();
  }

  const state = await loadState();
  if (!hasUser(state)) {
    return null;
  }

  const displayName = getDisplayName(state, normalizedFriendId);
  const friend = getFriend(state, normalizedFriendId);
  if (!friend || !isAcceptedFriendshipStatus(friend.friendship_status)) {
    return loadData();
  }

  friend.person_name = displayName;

  const trimmedMessage = asTrimmedString(message);
  const timestamp = new Date();
  const date = timestamp.toISOString().slice(0, 10);
  const transactionId = createId("tx");
  const note = trimmedMessage.length ? trimmedMessage : "record signed";

  const txMsg = await queuePeerMessage(state, {
    toUserId: normalizedFriendId,
    type: MessageType.TRANSACTION_CREATED,
    payload: {
      transaction_id: transactionId,
      amount_eur: normalizedAmount,
      date,
      note,
      message: trimmedMessage,
    },
  });
  appendLedgerEntryFromMessage(state, txMsg);
  routeOutboundEntry(state, txMsg);

  return persistAndBuildView(state);
};
