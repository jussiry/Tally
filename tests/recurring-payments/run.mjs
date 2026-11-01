/*
Recurring payments (app/js/recurring.js, run against the built app/dist — run
`npm run build` first if sources changed): when each payment falls due, which
due payments are still unpaid after the app was closed, which recurring
payments are active on the ledger, the relay reminders built from them, and
the ledger value rules for the new message types.

Times are local, so the test pins a time zone with a daylight-saving change
(Europe/Helsinki) to check a daily payment keeps its hour across it.

Usage: node tests/recurring-payments/run.mjs   (or: npm run test:recurring-payments)
*/

process.env.TZ = "Europe/Helsinki";

const {
  buildRecurringReminders,
  getActiveRecurringPayments,
  getUnpaidOccurrences,
  occurrenceAfter,
  recurringTransactionId,
} = await import("../../app/dist/js/recurring.js");
const { hasValidLedgerValues, mergeSyncedLedgerEntries } = await import("../../app/dist/js/ledger.js");

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

// Local wall-clock "YYYY-MM-DD HH:MM" of a Date, to compare readably.
const local = (date) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
};
const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const after = (schedule, date) => local(occurrenceAfter(schedule, date));

// --- When payments fall due ------------------------------------------------
const daily8 = { frequency: "daily", hour: 8 };
check("daily: later today", after(daily8, at(2026, 11, 2, 7, 30)), "2026-11-02 08:00");
check("daily: at the hour → tomorrow", after(daily8, at(2026, 11, 2, 8)), "2026-11-03 08:00");
check("daily: keeps its hour across DST", after(daily8, at(2026, 10, 24, 9)), "2026-10-25 08:00");

const monday = { frequency: "weekly", weekday: 1 };
check("weekly: this Monday 09:00 still ahead", after(monday, at(2026, 11, 2, 8)), "2026-11-02 09:00");
check("weekly: past → next Monday", after(monday, at(2026, 11, 2, 10)), "2026-11-09 09:00");
check("weekly: from a Wednesday", after(monday, at(2026, 11, 4, 12)), "2026-11-09 09:00");

const day31 = { frequency: "monthly", day: 31 };
check("monthly 31: clamps to Feb 28", after(day31, at(2027, 2, 1)), "2027-02-28 09:00");
check("monthly 31: leap year Feb 29", after(day31, at(2028, 2, 1)), "2028-02-29 09:00");
check("monthly 31: Dec → Jan rollover", after(day31, at(2026, 12, 31, 10)), "2027-01-31 09:00");
check("monthly 15: same month", after({ frequency: "monthly", day: 15 }, at(2026, 11, 2)), "2026-11-15 09:00");

const march = { frequency: "yearly", month: 2 };
check("yearly: this year", after(march, at(2026, 1, 10)), "2026-03-01 09:00");
check("yearly: past → next year", after(march, at(2026, 3, 1, 10)), "2027-03-01 09:00");

// --- Catching up -------------------------------------------------------------
const recurring = (extra = {}) => ({
  id: "rp_1",
  amount_eur: 10,
  note: "",
  schedule: daily8,
  first_due_at: at(2026, 11, 1, 8).toISOString(),
  is_outgoing: true,
  paid_due_at: [],
  ...extra,
});
const now = at(2026, 11, 4, 12);
const unpaid = getUnpaidOccurrences(recurring(), now);
check("closed for days: every missed one is due", unpaid.due.map((iso) => local(new Date(iso))), [
  "2026-11-01 08:00", "2026-11-02 08:00", "2026-11-03 08:00", "2026-11-04 08:00",
]);
check("next is after now", local(new Date(unpaid.next)), "2026-11-05 08:00");
const someones = getUnpaidOccurrences(recurring({ paid_due_at: [unpaid.due[0], unpaid.due[2]] }), now);
check("paid ones are skipped", someones.due, [unpaid.due[1], unpaid.due[3]]);
check("nothing due before the first", getUnpaidOccurrences(recurring(), at(2026, 10, 31)).due, []);
check(
  "next skips payments already made ahead of time",
  local(new Date(getUnpaidOccurrences(recurring({ paid_due_at: unpaid.due.slice(0, 2) }), at(2026, 10, 31)).next)),
  "2026-11-03 08:00"
);
check(
  "transaction id is derived from the due time",
  recurringTransactionId("rp_1", unpaid.due[0]),
  `rtx_rp_1_${unpaid.due[0]}`
);

// --- Active on the ledger ----------------------------------------------------
const ME = "me";
const BOB = "bob";
const created = (from, to, id, extra = {}) => ({
  type: "recurring_payment_created",
  from_user_id: from,
  to_user_id: to,
  payload: { recurring_id: id, amount_eur: 10, note: "rent", schedule: daily8, first_due_at: unpaid.due[0], ...extra },
});
const cancel = (from, to, id) => ({ type: "recurring_payment_cancel", from_user_id: from, to_user_id: to, payload: { recurring_id: id } });
const payment = (from, to, id, dueAt) => ({
  type: "transaction_created",
  from_user_id: from,
  to_user_id: to,
  payload: { amount_eur: 10, recurring_id: id, due_at: dueAt, transaction_id: recurringTransactionId(id, dueAt) },
});

const ledger = [
  payment(ME, BOB, "rp_out", unpaid.due[0]),
  created(ME, BOB, "rp_out"),
  created(BOB, ME, "rp_in"),
  created(ME, BOB, "rp_gone"),
  cancel(ME, BOB, "rp_gone"),
  created(BOB, ME, "rp_bob_keeps"),
  cancel(ME, BOB, "rp_bob_keeps"), // only the payer can cancel
];
const active = getActiveRecurringPayments(ledger, ME).get(BOB) ?? [];
check("active ids", active.map((r) => r.id).sort(), ["rp_bob_keeps", "rp_in", "rp_out"]);
check("direction", active.find((r) => r.id === "rp_in").is_outgoing, false);
check("payments read back off the ledger", active.find((r) => r.id === "rp_out").paid_due_at, [unpaid.due[0]]);

// --- Relay reminders ---------------------------------------------------------
const state = (status) => ({
  user: { id: ME, friends: [{ person_id: BOB, person_name: "Bob", friendship_status: status }] },
  contacts: {},
  ledger: [created(ME, BOB, "rp_out"), created(BOB, ME, "rp_in")],
});
const reminders = buildRecurringReminders(state("accepted"), now);
check("one reminder per outgoing payment", reminders.length, 1);
check("reminder at the next due time", local(new Date(reminders[0].at)), "2026-11-05 08:00");
check("reminder names the friend", reminders[0].body.includes("€10.00 to Bob"), true);
check("no reminders for a deactivated friend", buildRecurringReminders(state("disabled"), now), []);

// --- Ledger value rules ------------------------------------------------------
const valid = (type, payload) => hasValidLedgerValues({ type, payload });
check("created: valid", valid("recurring_payment_created", created(ME, BOB, "x").payload), true);
check("created: bad schedule", valid("recurring_payment_created", { ...created(ME, BOB, "x").payload, schedule: { frequency: "daily", hour: 24 } }), false);
check("created: zero amount", valid("recurring_payment_created", { ...created(ME, BOB, "x").payload, amount_eur: 0 }), false);
check("created: no first due", valid("recurring_payment_created", { ...created(ME, BOB, "x").payload, first_due_at: "soon" }), false);
check("cancel: needs an id", valid("recurring_payment_cancel", {}), false);
check("request with schedule", valid("payment_request", { amount_eur: 5, schedule: { frequency: "weekly", weekday: 3 } }), true);
check("request with bad schedule", valid("payment_request", { amount_eur: 5, schedule: { frequency: "hourly" } }), false);

// --- Two devices sending the same due payment ---------------------------------
// The copy from the other device has its own message id but the same derived
// transaction id; sync skips it before even checking its signature (an
// unsigned entry that got as far as that check would log a warning).
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
const syncState = { ledger: [{ ...payment(ME, BOB, "rp_out", unpaid.due[0]), id: "msg-from-this-device" }] };
const addedDup = await mergeSyncedLedgerEntries(syncState, [
  { ...payment(ME, BOB, "rp_out", unpaid.due[0]), id: "msg-from-other-device" },
]);
console.warn = originalWarn;
check("duplicate payment from another device not added", addedDup, 0);
check("…and skipped before the signature check", warnings, []);

console.log(failures ? `\n${failures} failure(s)` : "\nAll recurring-payment checks passed");
process.exit(failures ? 1 : 0);
