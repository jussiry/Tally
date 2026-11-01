/*
Notification-preference command: set which event types should reach the user as
OS notifications, one setting at a time. The choice is per user (all devices), stored in the ledger and
shared with friends so their clients know when to wake this user with a push —
see notify/notification-prefs.js for the publishing and
notify/notification-policy.js for the event catalogue and defaults.
@category command
*/

import { loadData, loadState, persistAndBuildView } from "../app-state.js";
import { hasUser } from "../state-utils.js";
import {
  getOsNotifyChoices,
  normalizeOsNotifyChoices,
} from "../notify/notification-policy.js";
import { publishOsNotifyChoices } from "../notify/notification-prefs.js";

const sameChoices = (a, b) =>
  JSON.stringify(normalizeOsNotifyChoices(a)) === JSON.stringify(normalizeOsNotifyChoices(b));

// `choices` maps a message type to on/off for every setting the user has set;
// types left out follow their defaults. {} resets everything to defaults.
export const setOsNotifyChoices = async (choices) => {
  const state = await loadState();
  if (!hasUser(state)) return null;
  if (sameChoices(getOsNotifyChoices(state.ledger, state.user.id), choices)) {
    return loadData();
  }
  await publishOsNotifyChoices(state, choices);
  return persistAndBuildView(state);
};
