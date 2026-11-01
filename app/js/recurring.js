/*
Recurring payments: their schedules, and which ones are active, read off the
ledger.

A recurring payment is set up by its payer with a `recurring_payment_created`
message (or by accepting a payment request that carries a `schedule`) and ends
with a `recurring_payment_cancel` from the payer. Each payment it makes is an
ordinary `transaction_created` carrying `recurring_id` and `due_at`; its
transaction id is derived from those two, so two devices of the payer that
both send the same due payment produce one transaction (tallies dedupe on the
transaction id), and the payments already made are read back off the ledger
rather than stored. Sending is done by commands/recurring-payment.js while the
app runs; see design/recurring-payments.html.

Times are computed in the device's local time zone. Daily payments fall at the
chosen hour; weekly, monthly and yearly ones at FIXED_HOUR on their day.
Everything here is pure (no window, no state), so it runs in tests as is.
@category util
*/

import { MessageType } from "./peer/messages.js";
import { normalizeCurrencyAmount } from "./models/data-model.js";
import { isAcceptedFriendshipStatus } from "./utils/friendships.js";

export const Frequency = Object.freeze({
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  YEARLY: "yearly",
});

// Hour of day for weekly, monthly and yearly payments.
const FIXED_HOUR = 9;

// Catch-up bound: a payment left unsent for longer than this many occurrences
// (over a year of a daily one) sends only the most recent ones.
const MAX_CATCH_UP = 400;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const isIntIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// A schedule is { frequency, hour } (daily), { frequency, weekday } (0 =
// Sunday), { frequency, day } (1–31; clamped to short months) or
// { frequency, month } (0 = January; on its first day).
export const isValidSchedule = (schedule) => {
  if (!schedule || typeof schedule !== "object") return false;
  switch (schedule.frequency) {
    case Frequency.DAILY: return isIntIn(schedule.hour, 0, 23);
    case Frequency.WEEKLY: return isIntIn(schedule.weekday, 0, 6);
    case Frequency.MONTHLY: return isIntIn(schedule.day, 1, 31);
    case Frequency.YEARLY: return isIntIn(schedule.month, 0, 11);
    default: return false;
  }
};

// Only the fields the frequency uses, so a schedule signs and compares the same
// wherever it was built.
export const normalizeSchedule = (schedule) => {
  if (!isValidSchedule(schedule)) return null;
  switch (schedule.frequency) {
    case Frequency.DAILY: return { frequency: Frequency.DAILY, hour: schedule.hour };
    case Frequency.WEEKLY: return { frequency: Frequency.WEEKLY, weekday: schedule.weekday };
    case Frequency.MONTHLY: return { frequency: Frequency.MONTHLY, day: schedule.day };
    default: return { frequency: Frequency.YEARLY, month: schedule.month };
  }
};

const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();

// The first payment time strictly after `after` (a Date).
export const occurrenceAfter = (schedule, after) => {
  const y = after.getFullYear();
  const m = after.getMonth();
  const d = after.getDate();
  switch (schedule.frequency) {
    case Frequency.DAILY: {
      const today = new Date(y, m, d, schedule.hour);
      return today > after ? today : new Date(y, m, d + 1, schedule.hour);
    }
    case Frequency.WEEKLY: {
      const ahead = (schedule.weekday - after.getDay() + 7) % 7;
      const candidate = new Date(y, m, d + ahead, FIXED_HOUR);
      return candidate > after ? candidate : new Date(y, m, d + ahead + 7, FIXED_HOUR);
    }
    case Frequency.MONTHLY: {
      for (let offset = 0; ; offset += 1) {
        const year = y + Math.floor((m + offset) / 12);
        const month = (m + offset) % 12;
        const candidate = new Date(year, month, Math.min(schedule.day, daysInMonth(year, month)), FIXED_HOUR);
        if (candidate > after) return candidate;
      }
    }
    default: {
      const thisYear = new Date(y, schedule.month, 1, FIXED_HOUR);
      return thisYear > after ? thisYear : new Date(y + 1, schedule.month, 1, FIXED_HOUR);
    }
  }
};

// The id of the transaction that makes the payment due at `dueAt` (ISO).
export const recurringTransactionId = (recurringId, dueAt) => `rtx_${recurringId}_${dueAt}`;

// Due times (ISO) not yet paid, oldest first, up to `now`; and the next unpaid
// one after those (the "next payment").
export const getUnpaidOccurrences = (recurring, now = new Date()) => {
  const paid = new Set(recurring.paid_due_at);
  const due = [];
  let next = new Date(recurring.first_due_at);
  if (Number.isNaN(next.getTime())) return { due, next: null };
  while (next <= now) {
    const iso = next.toISOString();
    if (!paid.has(iso)) {
      due.push(iso);
      if (due.length > MAX_CATCH_UP) due.shift();
    }
    next = occurrenceAfter(recurring.schedule, next);
  }
  // Payments can be in the ledger ahead of time (another device's clock runs
  // fast); the next one is the first not paid.
  for (let skipped = 0; paid.has(next.toISOString()) && skipped < MAX_CATCH_UP; skipped += 1) {
    next = occurrenceAfter(recurring.schedule, next);
  }
  return { due, next: next.toISOString() };
};

const pad2 = (n) => String(n).padStart(2, "0");

// "daily at 09:00", "weekly on Monday", "monthly on day 15", "yearly in March".
export const describeSchedule = (schedule) => {
  switch (schedule?.frequency) {
    case Frequency.DAILY: return `daily at ${pad2(schedule.hour)}:00`;
    case Frequency.WEEKLY: return `weekly on ${WEEKDAYS[schedule.weekday]}`;
    case Frequency.MONTHLY: return `monthly on day ${schedule.day}`;
    case Frequency.YEARLY: return `yearly in ${MONTHS[schedule.month]}`;
    default: return "";
  }
};

export const WEEKDAY_NAMES = WEEKDAYS;
export const MONTH_NAMES = MONTHS;

// Active recurring payments, from a ledger. Keyed by the friend's user id;
// each item says whether this user pays (`is_outgoing`) and which due times
// the ledger already holds a payment for. Only the payer can cancel one, so
// only the payer's cancel counts.
export const getActiveRecurringPayments = (ledger, myId) => {
  const active = new Map();
  if (!Array.isArray(ledger) || !myId) return active;

  const cancelled = new Set();
  const paid = new Map(); // `${payer}|${recurring_id}` -> due_at[]
  for (const entry of ledger) {
    const recurringId = entry.payload?.recurring_id;
    if (typeof recurringId !== "string" || !recurringId) continue;
    const key = `${entry.from_user_id}|${recurringId}`;
    if (entry.type === MessageType.RECURRING_PAYMENT_CANCEL) cancelled.add(key);
    else if (entry.type === MessageType.TRANSACTION_CREATED && typeof entry.payload.due_at === "string") {
      paid.set(key, [...(paid.get(key) ?? []), entry.payload.due_at]);
    }
  }

  for (const entry of ledger) {
    if (entry.type !== MessageType.RECURRING_PAYMENT_CREATED) continue;
    const isOutgoing = entry.from_user_id === myId;
    if (!isOutgoing && entry.to_user_id !== myId) continue;
    const key = `${entry.from_user_id}|${entry.payload.recurring_id}`;
    if (cancelled.has(key)) continue;
    const schedule = normalizeSchedule(entry.payload.schedule);
    const amount = normalizeCurrencyAmount(entry.payload.amount_eur, NaN);
    if (!schedule || !(amount > 0)) continue;

    const friendId = isOutgoing ? entry.to_user_id : entry.from_user_id;
    const list = active.get(friendId) ?? [];
    if (list.some((item) => item.id === entry.payload.recurring_id)) continue;
    list.push({
      id: entry.payload.recurring_id,
      amount_eur: amount,
      note: typeof entry.payload.note === "string" ? entry.payload.note.trim() : "",
      schedule,
      first_due_at: entry.payload.first_due_at,
      is_outgoing: isOutgoing,
      paid_due_at: paid.get(key) ?? [],
    });
    active.set(friendId, list);
  }
  return active;
};

// The relay keeps at most this many reminders per user.
const MAX_REMINDERS = 50;

// The next unpaid due time of each recurring payment this user makes to an
// accepted friend, as reminders for the relay to push if the app is closed
// then: { id, at, body }, soonest first.
export const buildRecurringReminders = (state, now = new Date()) => {
  if (!state?.user?.id) return [];
  const reminders = [];
  getActiveRecurringPayments(state.ledger, state.user.id).forEach((list, friendId) => {
    const friend = state.user.friends?.find((f) => f.person_id === friendId);
    if (!isAcceptedFriendshipStatus(friend?.friendship_status)) return;
    const name = state.contacts?.[friendId]?.name || friend.person_name || "a friend";
    list.forEach((recurring) => {
      if (!recurring.is_outgoing) return;
      const { next } = getUnpaidOccurrences(recurring, now);
      if (!next) return;
      reminders.push({
        id: `${recurring.id}_${next}`,
        at: next,
        body: `A recurring payment of €${recurring.amount_eur.toFixed(2)} to ${name} is due. Open Tally to send it.`,
      });
    });
  });
  return reminders.sort((a, b) => (a.at < b.at ? -1 : 1)).slice(0, MAX_REMINDERS);
};
