/*
Recurring-payment commands: setting one up toward a friend, cancelling it, and
sending the payments that have fallen due.

Like payment requests, recurring payments live only in the ledger (see
getActiveRecurringPayments in js/recurring.js): these commands append
messages and the friend page reads the active list back. A payment is an
ordinary transaction_created whose transaction id is derived from the due time,
so it applies to the tally like any other and a second device sending the same
due payment changes nothing. js/recurring-scheduler.js decides when to call
sendDueRecurringPayments.
@category command
*/

import { normalizeCurrencyAmount } from "../models/data-model.js";
import { MessageType } from "../peer/messages.js";
import { isAcceptedFriendshipStatus } from "../utils/friendships.js";
import { asTrimmedString, createId, hasUser } from "../state-utils.js";
import { loadData, loadState, persistAndBuildView } from "../app-state.js";
import { queuePeerMessage } from "../peer/outbox.js";
import { getDisplayName, getFriend } from "../friends-helpers.js";
import { appendLedgerEntryFromMessage } from "../ledger.js";
import { routeOutboundEntry } from "../peer/handlers.js";
import {
  getActiveRecurringPayments,
  getUnpaidOccurrences,
  normalizeSchedule,
  occurrenceAfter,
  recurringTransactionId,
} from "../recurring.js";

// Append a recurring_payment_created to `state`, the first payment due at the
// schedule's next time after now. Shared with accepting a recurring request.
/**
 * @param {object} state
 * @param {{ toUserId: string, amount: number, note: string, schedule: object, requestId?: string }} options
 */
export const queueRecurringPaymentCreated = async (state, { toUserId, amount, note, schedule, requestId }) => {
  const message = await queuePeerMessage(state, {
    toUserId,
    type: MessageType.RECURRING_PAYMENT_CREATED,
    payload: {
      recurring_id: createId("rp"),
      amount_eur: amount,
      note,
      schedule,
      first_due_at: occurrenceAfter(schedule, new Date()).toISOString(),
      ...(requestId ? { request_id: requestId } : {}),
    },
  });
  appendLedgerEntryFromMessage(state, message);
  return message;
};

/**
 * @param {{ friendId: string, amount: number, message?: string, schedule?: object | null }} options
 */
export const createRecurringPayment = async ({ friendId, amount, message, schedule }) => {
  const normalizedFriendId = asTrimmedString(friendId);
  const normalizedAmount = normalizeCurrencyAmount(amount, NaN);
  const normalizedSchedule = normalizeSchedule(schedule);
  if (!normalizedFriendId || !(normalizedAmount > 0) || !normalizedSchedule) return loadData();

  const state = await loadState();
  if (!hasUser(state)) return null;
  const friend = getFriend(state, normalizedFriendId);
  if (!friend || !isAcceptedFriendshipStatus(friend.friendship_status)) return loadData();

  await queueRecurringPaymentCreated(state, {
    toUserId: normalizedFriendId,
    amount: normalizedAmount,
    note: asTrimmedString(message),
    schedule: normalizedSchedule,
  });
  return persistAndBuildView(state);
};

// Only the payer can stop a recurring payment; the friend learns of it from
// the cancel message. Payments already made stay in the tally.
export const cancelRecurringPayment = async (friendId, recurringId) => {
  const normalizedFriendId = asTrimmedString(friendId);
  const state = await loadState();
  if (!hasUser(state)) return null;
  const recurring = (getActiveRecurringPayments(state.ledger, state.user.id).get(normalizedFriendId) ?? [])
    .find((item) => item.id === recurringId && item.is_outgoing);
  if (!recurring) return loadData();

  const cancelMsg = await queuePeerMessage(state, {
    toUserId: normalizedFriendId,
    type: MessageType.RECURRING_PAYMENT_CANCEL,
    payload: { recurring_id: recurring.id },
  });
  appendLedgerEntryFromMessage(state, cancelMsg);
  return persistAndBuildView(state);
};

// Send every payment that has fallen due and is not yet in the ledger, each
// dated when it fell due. Payments to a friend who is no longer accepted wait
// (a reactivated friendship catches up). Returns what was sent, for the
// caller's notifications.
export const sendDueRecurringPayments = async (now = new Date()) => {
  const state = await loadState();
  if (!hasUser(state)) return [];

  const sent = [];
  for (const [friendId, list] of getActiveRecurringPayments(state.ledger, state.user.id)) {
    const friend = getFriend(state, friendId);
    if (!friend || !isAcceptedFriendshipStatus(friend.friendship_status)) continue;
    for (const recurring of list) {
      if (!recurring.is_outgoing) continue;
      for (const dueAt of getUnpaidOccurrences(recurring, now).due) {
        const txMsg = await queuePeerMessage(state, {
          toUserId: friendId,
          type: MessageType.TRANSACTION_CREATED,
          payload: {
            transaction_id: recurringTransactionId(recurring.id, dueAt),
            amount_eur: recurring.amount_eur,
            date: localDate(new Date(dueAt)),
            note: recurring.note || "recurring payment",
            message: recurring.note,
            recurring_id: recurring.id,
            due_at: dueAt,
          },
        });
        appendLedgerEntryFromMessage(state, txMsg);
        routeOutboundEntry(state, txMsg);
        sent.push({ message: txMsg, friendId, friendName: getDisplayName(state, friendId), amount: recurring.amount_eur });
      }
    }
  }

  if (sent.length) await persistAndBuildView(state);
  return sent;
};

// YYYY-MM-DD of the device's local day, the date the payment fell due on here.
const localDate = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
