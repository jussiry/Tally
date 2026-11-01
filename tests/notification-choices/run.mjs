/*
Per-type notification choices (app/js/notify/notification-policy.js, run
against the built app/dist — run `npm run build` first if sources changed).

A user's saved settings hold only the types they actually switched; every
other type follows its default. So a notification type added after the user
saved still starts at its default, and older entries that stored only an
`enabled` list are read as choices for the types that existed then.

Usage: node tests/notification-choices/run.mjs   (or: npm run test:notification-choices)
*/

import {
  getDefaultOsNotifyTypes,
  getOsNotifyChoices,
  getOsNotifyTypes,
  resolveOsNotifyTypes,
} from "../../app/dist/js/notify/notification-policy.js";

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const ME = "npub1me";
const prefs = (payload, at = "2026-10-01T00:00:00.000Z") => ({
  type: "notification_prefs",
  from_user_id: ME,
  to_user_id: ME,
  originated_at: at,
  payload,
});
const has = (types, type) => types.includes(type);

// No entry: defaults.
check("no entry → defaults", getOsNotifyTypes([], ME), getDefaultOsNotifyTypes());
check("no entry → no choices", getOsNotifyChoices([], ME), {});

// Only the switched type is stored; the others follow their defaults.
const onlyMoneyOff = resolveOsNotifyTypes({ transaction_created: false });
check("switched off type is off", has(onlyMoneyOff, "transaction_created"), false);
check("unset default-on type stays on", has(onlyMoneyOff, "payment_request"), true);
check("unset default-on new type stays on", has(onlyMoneyOff, "friendship_default"), true);
check("unset default-off type stays off", has(onlyMoneyOff, "name_changed"), false);

// Newest entry with choices wins.
const ledger = [
  prefs({ choices: { name_changed: true }, enabled: [] }, "2026-10-02T00:00:00.000Z"),
  prefs({ choices: { transaction_created: false }, enabled: [] }, "2026-10-01T00:00:00.000Z"),
];
check("latest choices read", getOsNotifyChoices(ledger, ME), { name_changed: true });
check("latest choices resolved", has(getOsNotifyTypes(ledger, ME), "transaction_created"), true);

// Legacy entry (enabled list only): every type known then is set; newer
// types — the friendship ones — keep their defaults.
const legacy = [prefs({ enabled: ["payment_request"] })];
const legacyTypes = getOsNotifyTypes(legacy, ME);
check("legacy: listed type on", has(legacyTypes, "payment_request"), true);
check("legacy: unlisted old type off", has(legacyTypes, "transaction_created"), false);
check("legacy: newer type at default", has(legacyTypes, "friendship_default"), true);
check("legacy: newer response type at default", has(legacyTypes, "reactivation_response"), true);

// Unknown types and non-boolean values are ignored.
check(
  "unknown and malformed choices dropped",
  getOsNotifyChoices([prefs({ choices: { some_future_type: true, name_changed: "yes" }, enabled: [] })], ME),
  {}
);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passing");
