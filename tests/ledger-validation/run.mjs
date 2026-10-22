/*
Ledger value-validation test for app/js/ledger.ts (run against the built
app/dist/js/ledger.js — run `npm run build` first if sources changed).

A valid signature only proves who wrote an entry, so entries arriving through
sync are also checked for impossible money values before they are stored:
non-positive IOUs and payment requests, and negative trust limits. This test
covers the pure rule (`hasValidLedgerValues`) and that `mergeSyncedLedgerEntries`
drops such entries without touching the ledger.

Usage: node tests/ledger-validation/run.mjs   (or: npm run test:ledger-validation)
*/

import {
  hasValidLedgerValues,
  mergeSyncedLedgerEntries,
} from "../../app/dist/js/ledger.js";

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` (got ${actual}, want ${expected})`}`);
};

const entry = (type, payload) => ({ type, payload });

// IOUs and payment requests: amount must be a number above 0.
for (const type of ["transaction_created", "payment_request"]) {
  check(`${type} 12.5 accepted`, hasValidLedgerValues(entry(type, { amount_eur: 12.5 })), true);
  for (const bad of [-5, 0, "-5", "abc", null, undefined, Infinity, NaN]) {
    check(`${type} ${String(bad)} rejected`, hasValidLedgerValues(entry(type, { amount_eur: bad })), false);
  }
}

// Trust-limit suggestion: required, 0 or more.
check("limit suggestion 0 accepted", hasValidLedgerValues(entry("credit_limit_suggestion", { credit_limit_eur: 0 })), true);
check("limit suggestion -1 rejected", hasValidLedgerValues(entry("credit_limit_suggestion", { credit_limit_eur: -1 })), false);
check("limit suggestion missing rejected", hasValidLedgerValues(entry("credit_limit_suggestion", {})), false);

// Friend accept/request: limit optional, but never negative.
check("friend_accept without limit accepted", hasValidLedgerValues(entry("friend_accept", {})), true);
check("friend_accept -10 rejected", hasValidLedgerValues(entry("friend_accept", { trust_credit_limit_eur: -10 })), false);
check("friend_request -10 rejected", hasValidLedgerValues(entry("friend_request", { suggested_credit_limit_eur: -10 })), false);

// Types without money values always pass.
check("name_changed accepted", hasValidLedgerValues(entry("name_changed", { name: "Bob" })), true);

// Notification prefs: `enabled` must be a list of type names.
check("notification_prefs list accepted", hasValidLedgerValues(entry("notification_prefs", { enabled: ["payment_request"] })), true);
check("notification_prefs empty list accepted", hasValidLedgerValues(entry("notification_prefs", { enabled: [] })), true);
check("notification_prefs missing list rejected", hasValidLedgerValues(entry("notification_prefs", {})), false);
check("notification_prefs non-string rejected", hasValidLedgerValues(entry("notification_prefs", { enabled: [1] })), false);

// Friendship default: the tally at default time is a number; the note optional text.
check("friendship_default accepted", hasValidLedgerValues(entry("friendship_default", { tally_eur: -20, note: "sorry" })), true);
check("friendship_default missing tally rejected", hasValidLedgerValues(entry("friendship_default", { note: "x" })), false);
check("friendship_default non-text note rejected", hasValidLedgerValues(entry("friendship_default", { tally_eur: 0, note: 5 })), false);

// Reactivation request: a history list (vetted per entry on receipt), limit never negative.
check("reactivation_request accepted", hasValidLedgerValues(entry("reactivation_request", { history: [], trust_credit_limit_eur: 10 })), true);
check("reactivation_request without history rejected", hasValidLedgerValues(entry("reactivation_request", {})), false);
check("reactivation_request -1 limit rejected", hasValidLedgerValues(entry("reactivation_request", { history: [], trust_credit_limit_eur: -1 })), false);

// History deletion names the friend.
check("friendship_history_deleted accepted", hasValidLedgerValues(entry("friendship_history_deleted", { friend_id: "npub1x" })), true);
check("friendship_history_deleted without friend rejected", hasValidLedgerValues(entry("friendship_history_deleted", {})), false);

// Merge: an invalid-value entry never reaches the ledger.
const state = { ledger: [] };
const added = await mergeSyncedLedgerEntries(state, [
  {
    id: "peer_negative",
    type: "transaction_created",
    from_user_id: "npub1alice",
    to_user_id: "npub1bob",
    payload: { amount_eur: -50, transaction_id: "tx_negative" },
    signature: "00",
  },
]);
check("merge adds nothing for a negative IOU", added, 0);
check("ledger stays empty", state.ledger.length, 0);

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
