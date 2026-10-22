/*
Notification policy — the single place that describes Tally's notification
layers and decides which peer events deserve an OS-level notification.

The app surfaces "something happened" through four distinct layers, each with a
different audience, lifetime, and trigger:

  1. Logs (the logs page, derived from the ledger)
     Every ledger event. Rows whose event type the user routes to the OS are
     highlighted there.

  2. In-app toasts (js/ui/notifications.js)
     Every inbound event in OS_NOTIFY_SETTINGS, shown while the app is open.
     Transient acknowledgement that the UI just changed.

  3. Actionable boxes (the friend page, derived from app state)
     Persistent, state-derived prompts that need a decision — pending friend
     requests, pending payment requests, trust-limit suggestions. They live as
     long as the state that produced them.

  4. OS notifications (Web Push -> service worker -> showNotification, or a
     local showNotification while the app is open but hidden)
     The only layer that reaches the user when the app is closed. Each event
     type is opt-in per user (Settings → Notifications); OS_NOTIFY_SETTINGS
     lists them, grouped into settings, with their defaults.

Per-type choice and delivery. Browsers forbid silent pushes (every push must
show a notification), so the recipient can't filter in its service worker.
Instead the recipient publishes its choice as a `notification_prefs` ledger
message to every friend (and a self-addressed copy for its own devices); the
*sender* reads the latest one from its ledger and attaches the encrypted
`push_hint` only for enabled types. The relay pushes only envelopes with a
hint, so it still never learns the event type. A peer with no prefs entry
(new friend, stranger's friend request, older app) gets the defaults.
See TIPs/TIP-005-os-notifications.md.

Keeping this mapping separate from the state-mutation handlers (peer/handlers.js)
means the "what shows where" question has one answer, and adding a new
OS-notifiable event is a type in OS_NOTIFY_SETTINGS plus a HINT_BUILDERS
function here.
@category ui
*/

import { formatCurrency } from "../ui/format.js";
import {
  PEER_MESSAGE_TYPE_FRIEND_ACCEPT,
  PEER_MESSAGE_TYPE_FRIEND_REJECT,
  PEER_MESSAGE_TYPE_FRIEND_REQUEST,
  PEER_MESSAGE_TYPE_FRIENDSHIP_DEFAULT,
  PEER_MESSAGE_TYPE_NAME_CHANGED,
  PEER_MESSAGE_TYPE_NOTIFICATION_PREFS,
  PEER_MESSAGE_TYPE_PAYMENT_REQUEST,
  PEER_MESSAGE_TYPE_PAYMENT_REQUEST_CANCEL,
  PEER_MESSAGE_TYPE_PAYMENT_REQUEST_RESPONSE,
  PEER_MESSAGE_TYPE_REACTIVATION_REQUEST,
  PEER_MESSAGE_TYPE_REACTIVATION_RESPONSE,
  PEER_MESSAGE_TYPE_TRANSACTION_CREATED,
  PEER_MESSAGE_TYPE_TRUST_LIMIT_SUGGESTION,
} from "../peer/messages.js";

const APP_NAME = "Tally";

// Every inbound event that shows an in-app toast, as the settings the user
// sees (settings-page order). A setting may cover several message types — e.g.
// both answers to a payment request — and switches them together; the
// published choice is still a plain list of types, so regrouping settings
// never changes the wire format. The three settings that were OS-notifiable
// before per-type choice existed stay on by default, as does a friendship
// being disabled or reactivated (rare, and it matters); the rest are opt-in.
export const OS_NOTIFY_SETTINGS = [
  { label: "Money received", types: [PEER_MESSAGE_TYPE_TRANSACTION_CREATED], defaultEnabled: true },
  { label: "Payment requested", types: [PEER_MESSAGE_TYPE_PAYMENT_REQUEST], defaultEnabled: true },
  {
    label: "Payment request response",
    types: [PEER_MESSAGE_TYPE_PAYMENT_REQUEST_RESPONSE, PEER_MESSAGE_TYPE_PAYMENT_REQUEST_CANCEL],
    defaultEnabled: false,
  },
  { label: "Friend request", types: [PEER_MESSAGE_TYPE_FRIEND_REQUEST], defaultEnabled: true },
  {
    label: "Friend request response",
    types: [PEER_MESSAGE_TYPE_FRIEND_ACCEPT, PEER_MESSAGE_TYPE_FRIEND_REJECT],
    defaultEnabled: false,
  },
  {
    label: "Friendship disabled or reactivated",
    types: [
      PEER_MESSAGE_TYPE_FRIENDSHIP_DEFAULT,
      PEER_MESSAGE_TYPE_REACTIVATION_REQUEST,
      PEER_MESSAGE_TYPE_REACTIVATION_RESPONSE,
    ],
    defaultEnabled: true,
  },
  { label: "Trust limit changes", types: [PEER_MESSAGE_TYPE_TRUST_LIMIT_SUGGESTION], defaultEnabled: false },
  { label: "Friend changed name", types: [PEER_MESSAGE_TYPE_NAME_CHANGED], defaultEnabled: false },
];

const ALL_TYPES = OS_NOTIFY_SETTINGS.flatMap((setting) => setting.types);

export const getDefaultOsNotifyTypes = () =>
  OS_NOTIFY_SETTINGS.filter((setting) => setting.defaultEnabled).flatMap((setting) => setting.types);

// Keep only known types, deduped, in catalogue order — so two lists with the
// same members compare equal and unknown types from newer peers are ignored.
export const normalizeOsNotifyTypes = (types) => {
  const wanted = new Set(Array.isArray(types) ? types : []);
  return ALL_TYPES.filter((type) => wanted.has(type));
};

export const sameOsNotifyTypes = (a, b) =>
  normalizeOsNotifyTypes(a).join(",") === normalizeOsNotifyTypes(b).join(",");

const entryTime = (entry) => entry?.originated_at || entry?.timestamp || "";

// Latest notification_prefs choice per author, from a ledger. Authors with no
// entry are absent; callers fall back to the defaults. In a user's own ledger
// the only entries by a friend are ones addressed to this user, and entries
// by the user itself (to friends or self-addressed) all carry the same choice.
export const collectOsNotifyTypesByAuthor = (ledger) => {
  const latest = new Map();
  (Array.isArray(ledger) ? ledger : []).forEach((entry) => {
    if (entry?.type !== PEER_MESSAGE_TYPE_NOTIFICATION_PREFS) return;
    if (!Array.isArray(entry.payload?.enabled)) return;
    const previous = latest.get(entry.from_user_id);
    if (!previous || entryTime(entry) > entryTime(previous)) {
      latest.set(entry.from_user_id, entry);
    }
  });
  const byAuthor = {};
  latest.forEach((entry, authorId) => {
    byAuthor[authorId] = normalizeOsNotifyTypes(entry.payload.enabled);
  });
  return byAuthor;
};

// The OS-notified event types chosen by `authorId`, or the defaults.
export const getOsNotifyTypes = (ledger, authorId) =>
  collectOsNotifyTypesByAuthor(ledger)[authorId] || getDefaultOsNotifyTypes();

const normalizeAmount = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
};

const hint = (body) => ({ title: APP_NAME, body });

// Builders are keyed by message type. Each receives the outgoing peer message
// and the sender's display name (the recipient sees the sender's name, e.g.
// "Bob sent you €25.00"). Returning null means "no OS notification". Texts
// follow the recipient's in-app toast (peer/handlers.js) where the sender can
// know it; trust-limit wording stays neutral because only the recipient knows
// whether a suggestion raised, lowered or agreed a limit.
const HINT_BUILDERS = {
  [PEER_MESSAGE_TYPE_TRANSACTION_CREATED]: (message, senderName) => {
    const amount = normalizeAmount(message.payload?.amount_eur);
    return amount === null ? null : hint(`${senderName} sent you ${formatCurrency(amount)}`);
  },
  [PEER_MESSAGE_TYPE_PAYMENT_REQUEST]: (message, senderName) => {
    const amount = normalizeAmount(message.payload?.amount_eur);
    if (amount === null) return null;
    const note = typeof message.payload?.note === "string" ? message.payload.note.trim() : "";
    const base = `${senderName} requested ${formatCurrency(amount)}`;
    return hint(note ? `${base} — ${note}` : base);
  },
  [PEER_MESSAGE_TYPE_FRIEND_REQUEST]: (message, senderName) =>
    hint(`${senderName} sent you a friend request`),
  [PEER_MESSAGE_TYPE_PAYMENT_REQUEST_RESPONSE]: (message, senderName) =>
    hint(
      message.payload?.accepted === true
        ? `${senderName} accepted your payment request`
        : `${senderName} declined your payment request`
    ),
  [PEER_MESSAGE_TYPE_PAYMENT_REQUEST_CANCEL]: (message, senderName) =>
    hint(`${senderName} cancelled their payment request`),
  [PEER_MESSAGE_TYPE_FRIEND_ACCEPT]: (message, senderName) =>
    hint(`${senderName} accepted your friend request`),
  [PEER_MESSAGE_TYPE_FRIEND_REJECT]: (message, senderName) =>
    hint(`${senderName} rejected your friend request`),
  [PEER_MESSAGE_TYPE_TRUST_LIMIT_SUGGESTION]: (message, senderName) => {
    const limit = Number(message.payload?.credit_limit_eur);
    if (!Number.isFinite(limit) || limit < 0) return null;
    return hint(`${senderName}: trust limit ${formatCurrency(limit)}`);
  },
  // The tally is worded from the sender's side here; the recipient's toast
  // words it from theirs.
  [PEER_MESSAGE_TYPE_FRIENDSHIP_DEFAULT]: (message, senderName) => {
    const tally = Number(message.payload?.tally_eur) || 0;
    return hint(
      tally < 0
        ? `${senderName} defaulted on ${formatCurrency(-tally)}`
        : tally > 0
        ? `${senderName} absolved your tally of ${formatCurrency(tally)}`
        : `${senderName} deactivated your friend connection`
    );
  },
  [PEER_MESSAGE_TYPE_REACTIVATION_REQUEST]: (message, senderName) =>
    hint(`${senderName} suggests reactivating your friendship`),
  [PEER_MESSAGE_TYPE_REACTIVATION_RESPONSE]: (message, senderName) =>
    hint(
      message.payload?.accepted === true
        ? `${senderName} reactivated your friendship`
        : `${senderName} declined reactivating your friendship`
    ),
  [PEER_MESSAGE_TYPE_NAME_CHANGED]: (message) => {
    const name = typeof message.payload?.name === "string" ? message.payload.name.trim() : "";
    return name ? hint(`A friend is now called ${name}`) : null;
  },
};

// True when a message type can raise an OS notification on the recipient.
export const isOsNotifiableType = (type) => Boolean(HINT_BUILDERS[type]);

// Build the OS-notification hint a recipient should see for an outgoing peer
// message, or null when this type/payload warrants none or the recipient
// turned the type off. `recipientTypes` is the recipient's latest choice
// (undefined → defaults). `senderName` falls back to a generic label so a
// missing name never produces "undefined". The message id becomes the
// notification tag, so a push and a local notification for the same message
// replace each other instead of stacking.
export const buildOsNotificationHint = (message, { senderName, recipientTypes } = {}) => {
  if (!message || typeof message !== "object") return null;
  const builder = HINT_BUILDERS[message.type];
  if (!builder) return null;
  const enabled = recipientTypes ? normalizeOsNotifyTypes(recipientTypes) : getDefaultOsNotifyTypes();
  if (!enabled.includes(message.type)) return null;
  const name = (typeof senderName === "string" && senderName.trim()) || "A friend";
  const built = builder(message, name);
  return built ? { ...built, tag: message.id } : null;
};

// Shown when the service worker receives a push but cannot decrypt the hint
// (e.g. no local key yet, or the user signed out). Generic on purpose.
export const GENERIC_OS_NOTIFICATION = {
  title: APP_NAME,
  body: "You have new Tally activity",
};
