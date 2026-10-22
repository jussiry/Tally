/*
Notification-preference command: set which event types should reach the user as
OS notifications. The choice is per user (all devices), stored in the ledger and
shared with friends so their clients know when to wake this user with a push —
see notify/notification-prefs.js for the publishing and
notify/notification-policy.js for the event catalogue and defaults.
@category command
*/

import { loadData, loadState, persistAndBuildView } from "../app-state.js";
import { hasUser } from "../state-utils.js";
import { getOsNotifyTypes, sameOsNotifyTypes } from "../notify/notification-policy.js";
import { publishOsNotifyTypes } from "../notify/notification-prefs.js";

export const setOsNotifyTypes = async (types) => {
  const state = await loadState();
  if (!hasUser(state)) return null;
  if (sameOsNotifyTypes(getOsNotifyTypes(state.ledger, state.user.id), types)) {
    return loadData();
  }
  await publishOsNotifyTypes(state, types);
  return persistAndBuildView(state);
};
