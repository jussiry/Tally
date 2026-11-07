/*
The number on the installed app's icon (Badging API): how many things are
waiting for the user's answer.

It counts only what the app state already marks as waiting — an incoming friend
request, payment request, trust-limit suggestion, name change or reactivation
request (hasActionableNotification in utils/friendships.js) — and only the kinds
the user gets notified about (Settings → Notifications, defaults when never
set). An item stops counting once it is answered, so nothing has to be tracked
separately. Shown only when Tally runs as the installed app; browsers ignore the
badge for a tab anyway.

While the app is closed, the service worker adds one for each push marked
`waiting` (sw.js). This module saves the exact count it sets, so the worker
adds to the right base and the next open of the app corrects any drift.
@category ui
*/

import { FriendshipStatus, PENDING_CREDIT_LIMIT_LOWERED } from "../utils/friendships.js";
import { MessageType } from "../peer/messages.js";
import { getOsNotifyTypes } from "../notify/notification-policy.js";
import { isRunningInstalled } from "./app-install.js";
import { saveAppBadgeCount } from "../storage/indexeddb.js";

const countWaiting = (friend, notified) => {
  let count = 0;
  const add = (type, n = 1) => {
    if (notified.has(type)) count += n;
  };
  if (friend.friendship_status === FriendshipStatus.PENDING_INCOMING) add(MessageType.FRIEND_REQUEST);
  if (
    friend.pending_credit_limit_is_incoming === true ||
    friend.pending_credit_limit_is_incoming === PENDING_CREDIT_LIMIT_LOWERED
  ) {
    add(MessageType.TRUST_LIMIT_SUGGESTION);
  }
  const incomingRequests = (friend.pending_payment_requests || []).filter((request) => request.is_incoming);
  add(MessageType.PAYMENT_REQUEST, incomingRequests.length);
  if (friend.pending_name_change) add(MessageType.NAME_CHANGED);
  if (friend.pending_reactivation?.is_incoming) add(MessageType.REACTIVATION_REQUEST);
  return count;
};

/** @param {any} data the page view data (view-model.js) */
export const updateAppBadge = (data) => {
  const notified = new Set(getOsNotifyTypes(data?.ledger || [], data?.you?.id || ""));
  const count = (data?.friends || []).reduce((sum, friend) => sum + countWaiting(friend, notified), 0);
  // Saved even in a tab, so the worker's count never drifts far from the truth.
  saveAppBadgeCount(count).catch(() => {});
  const nav = /** @type {any} */ (navigator);
  if (typeof nav.setAppBadge !== "function" || !isRunningInstalled()) return;
  const result = count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge();
  result?.catch?.(() => {});
};
