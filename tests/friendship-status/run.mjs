/*
Friendship status from the ledger (app/js/ledger.ts getFriendshipActivity and
peer/handlers.js reconcileFriendshipStatuses, run against the built app/dist —
run `npm run build` first if sources changed).

Regression for a bug seen across two devices of one user: entries reach a
device in batches, not in the order they were made, and applying them one at
a time left the wrong friend active. An old reactivation of one friend
arriving after that friend's newer deactivation turned them back on, while a
friend whose reactivation was in the ledger stayed deactivated. The statuses
must follow the ledger: the latest default or accepted reactivation wins.

Usage: node tests/friendship-status/run.mjs   (or: npm run test:friendship-status)
*/

// handlers.js reaches window at import; nothing here uses it.
globalThis.window = globalThis;

const { getFriendshipActivity } = await import("../../app/dist/js/ledger.js");
const { reconcileFriendshipStatuses, routeOutboundEntry } = await import(
  "../../app/dist/js/peer/handlers.js"
);

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const ME = "npub_me";
const OLD = "npub_old";
const TEST = "npub_test";

const at = (day) => `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`;
const entry = (id, type, from, to, day, payload = {}) => ({
  id,
  type,
  from_user_id: from,
  to_user_id: to,
  timestamp: at(day),
  originated_at: at(day),
  payload,
});

// OLD: deactivated, reactivated at OLD's suggestion, then deactivated again.
const oldDefault1 = entry("e1", "friendship_default", ME, OLD, 1, { tally_eur: 0 });
const oldRequest = entry("e2", "reactivation_request", OLD, ME, 2, { request_id: "r_old", history: [] });
const oldResponse = entry("e3", "reactivation_response", ME, OLD, 3, { request_id: "r_old", accepted: true });
const oldDefault2 = entry("e4", "friendship_default", ME, OLD, 4, { tally_eur: 0 });
// TEST: deactivated, then reactivated at this user's suggestion.
const testDefault = entry("e5", "friendship_default", ME, TEST, 5, { tally_eur: 0 });
const testRequest = entry("e6", "reactivation_request", ME, TEST, 6, { request_id: "r_test", history: [] });
const testResponse = entry("e7", "reactivation_response", TEST, ME, 7, { request_id: "r_test", accepted: true });
// A response that answers no request in the ledger proves nothing.
const strayResponse = entry("e8", "reactivation_response", ME, "npub_other", 8, { request_id: "r_none", accepted: true });

const ledger = [oldDefault1, oldRequest, oldResponse, oldDefault2, testDefault, testRequest, testResponse, strayResponse];

const activity = getFriendshipActivity(ledger, ME);
check("old friend: latest is a default → inactive", activity.get(OLD), false);
check("test friend: latest is an accepted reactivation → active", activity.get(TEST), true);
check("response without its request is ignored", activity.has("npub_other"), false);
check("declined reactivation does not activate",
  getFriendshipActivity([testDefault, testRequest, { ...testResponse, payload: { request_id: "r_test", accepted: false } }], ME).get(TEST),
  false);
check("reactivation by the wrong user does not activate",
  getFriendshipActivity([testDefault, testRequest, { ...testResponse, from_user_id: OLD }], ME).get(TEST),
  false);

// The device from the bug report: OLD's newer default arrived first, so OLD
// is deactivated; TEST's reactivation never took. Then OLD's old
// reactivation arrives late and is applied on its own.
const friend = (id, status) => ({
  person_id: id,
  person_name: id,
  friendship_status: status,
  debt_eur: 0,
  recent_transactions: [],
});
const state = {
  user: { id: ME, public_key: ME, name: "Me", friends: [friend(OLD, "disabled"), friend(TEST, "disabled")] },
  contacts: {},
  ledger: [...ledger],
  outbox: [],
};
routeOutboundEntry(state, oldResponse);
const statusOf = (id) => state.user.friends.find((f) => f.person_id === id).friendship_status;
check("applied alone, the late old reactivation turns OLD on (the bug)", statusOf(OLD), "accepted");

const changed = reconcileFriendshipStatuses(state);
check("reconcile changes both friends", changed, 2);
check("OLD stays deactivated after reconcile", statusOf(OLD), "disabled");
check("TEST is active after reconcile", statusOf(TEST), "accepted");
check("reconcile is idempotent", reconcileFriendshipStatuses(state), 0);

// Friends never deactivated are left alone, whatever their status.
const untouched = {
  user: { id: ME, public_key: ME, name: "Me", friends: [friend("npub_new", "pending_incoming"), friend("npub_ok", "accepted")] },
  ledger: [],
};
check("friends without defaults are untouched", reconcileFriendshipStatuses(untouched), 0);

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
