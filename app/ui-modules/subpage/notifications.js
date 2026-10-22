/*
Binds the Settings → Notifications subpage: which events reach the user as OS
notifications, the push service this browser uses, and a reset to defaults.

The event list and defaults come from notify/notification-policy.js; the
current choice is read from the ledger (latest notification_prefs entry by the
user) and saved with setOsNotifyTypes, which also shares it with friends so
their clients only push the enabled events.

The push service is the browser vendor's (FCM for Chromium browsers, Mozilla's
for Firefox, Apple's for Safari). It's fixed by the browser, so it is shown,
not edited.
@category ui
*/

import { initCheckToggle } from "../components/check-toggle.js";
import { setOsNotifyTypes } from "../../js/commands/notification-prefs.js";
import {
  OS_NOTIFIABLE_EVENTS,
  getDefaultOsNotifyTypes,
  getOsNotifyTypes,
} from "../../js/notify/notification-policy.js";

// Push endpoint host → service name. Hosts not listed show as the bare host.
const PUSH_SERVICES = [
  { match: /(^|\.)fcm\.googleapis\.com$|(^|\.)googleapis\.com$/, name: "Google Firebase Cloud Messaging" },
  { match: /(^|\.)push\.services\.mozilla\.com$/, name: "Mozilla Push Service" },
  { match: /(^|\.)push\.apple\.com$/, name: "Apple Push Notification service" },
  { match: /(^|\.)notify\.windows\.com$/, name: "Windows Push Notification Services" },
];

const describePushEndpoint = (endpoint) => {
  try {
    const host = new URL(endpoint).host;
    const known = PUSH_SERVICES.find((service) => service.match.test(host));
    return { name: known?.name || host, host };
  } catch {
    return null;
  }
};

const renderPushService = async (root) => {
  const nameEl = root.querySelector('[data-bind="push-service-name"]');
  const hostEl = root.querySelector('[data-bind="push-service-host"]');
  if (!nameEl || !hostEl) return;
  let subscription = null;
  try {
    const registration = await navigator.serviceWorker?.ready;
    subscription = await registration?.pushManager?.getSubscription();
  } catch {
    subscription = null;
  }
  const service = subscription ? describePushEndpoint(subscription.endpoint) : null;
  nameEl.textContent = service?.name || "Not registered on this device";
  hostEl.textContent = service && service.name !== service.host ? service.host : "";
  hostEl.hidden = !hostEl.textContent;
};

export const bindNotificationSettings = (root, data) => {
  const titleEl = root.querySelector('[data-bind="page-title"]');
  const listEl = root.querySelector('[data-list="notify-events"]');
  const templateEl = root.querySelector('[data-template="notify-event"]');
  const resetEl = root.querySelector('[data-action="reset-notify-defaults"]');
  if (titleEl) titleEl.textContent = "Notifications";
  if (!listEl || !templateEl) return;

  // The page's own copy of the choice; each change saves the whole list.
  let enabled = new Set(getOsNotifyTypes(data?.ledger, data?.you?.id));
  const toggles = new Map();
  let isSyncing = true;

  const save = () => setOsNotifyTypes(Array.from(enabled));

  OS_NOTIFIABLE_EVENTS.forEach((event) => {
    const row = templateEl.content.firstElementChild.cloneNode(true);
    const labelEl = row.querySelector('[data-bind="label"]');
    const toggleEl = row.querySelector('[data-bind="toggle"]');
    if (labelEl) labelEl.textContent = event.label;
    toggleEl?.setAttribute("aria-label", `Notify me: ${event.label}`);
    const toggle = initCheckToggle(toggleEl, {
      checked: enabled.has(event.type),
      onChange: (isChecked) => {
        if (isSyncing) return;
        if (isChecked) enabled.add(event.type);
        else enabled.delete(event.type);
        void save();
      },
    });
    toggles.set(event.type, toggle);
    listEl.appendChild(row);
  });
  isSyncing = false;

  resetEl?.addEventListener("click", () => {
    enabled = new Set(getDefaultOsNotifyTypes());
    isSyncing = true;
    toggles.forEach((toggle, type) => toggle.setChecked(enabled.has(type)));
    isSyncing = false;
    void save();
  });

  void renderPushService(root);
};
