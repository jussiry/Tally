/*
Binds the logs page by deriving human-readable rows from the ledger.

Each ledger entry is a peer message that either the user sent or received;
the formatter below turns it into a presentation string based on its type.
Formatting lives here (not in the data layer) so the ledger stays transport-
focused while this module owns display concerns.
@category ui
*/

import { formatMarkdownish } from "../../js/utils/markdownish.js";
import {
  getConnectedPeerIds,
  getConnectedSelfDeviceIds,
} from "../../js/peer/status.js";
import { isAnyRelayConnected } from "../../js/signaling/relay-status-registry.js";
import { initInfiniteList } from "../../js/ui/infinite-list.js";
import { getOsNotifyTypes } from "../../js/notify/notification-policy.js";
import { MessageType } from "../../js/peer/messages.js";
import { getErrorLog } from "../../js/ui/error-report.js";
import { describeSchedule } from "../../js/recurring.js";

const formatEur = (amount) => {
  const value = Number(amount);
  return Number.isFinite(value) ? `€${value.toFixed(2)}` : "€0.00";
};

const getPeerDisplayName = (namesById, peerId, fallback = "") =>
  namesById[peerId] || fallback || peerId;

const formatLedgerEntry = (entry, myId, namesById, context = {}) => {
  const isOutgoing = entry.from_user_id === myId;
  const peerId = isOutgoing ? entry.to_user_id : entry.from_user_id;
  const peerName = getPeerDisplayName(namesById, peerId);
  const payload = entry.payload || {};

  switch (entry.type) {
    case MessageType.FRIEND_REQUEST:
      return isOutgoing
        ? `Friend request sent to ${peerName}`
        : `Friend request received from ${peerName}`;
    case MessageType.FRIEND_ACCEPT:
      return isOutgoing
        ? `You accepted ${peerName} as a friend`
        : `${peerName} accepted your friend request`;
    case MessageType.FRIEND_REJECT:
      return isOutgoing
        ? `You rejected friend request from ${peerName}`
        : `${peerName} rejected your friend request`;
    case MessageType.TRUST_LIMIT_SUGGESTION: {
      const limit = formatEur(payload.credit_limit_eur);
      return isOutgoing
        ? `You suggested trust limit of ${limit} with ${peerName}`
        : `${peerName} suggested trust limit of ${limit}`;
    }
    case MessageType.TRANSACTION_CREATED: {
      const amount = formatEur(payload.amount_eur);
      const recurring = payload.recurring_id ? " (recurring)" : "";
      return isOutgoing
        ? `You sent ${amount} to ${peerName}${recurring}`
        : `${peerName} sent ${amount} to you${recurring}`;
    }
    case MessageType.PAYMENT_REQUEST: {
      const amount = formatEur(payload.amount_eur);
      const recurrence = payload.schedule ? ` ${describeSchedule(payload.schedule)}` : "";
      return isOutgoing
        ? `You requested ${amount}${recurrence} from ${peerName}`
        : `${peerName} requested ${amount}${recurrence} from you`;
    }
    case MessageType.RECURRING_PAYMENT_CREATED: {
      const amount = formatEur(payload.amount_eur);
      const schedule = describeSchedule(payload.schedule);
      return isOutgoing
        ? `You set up a payment of ${amount} to ${peerName}, ${schedule}`
        : `${peerName} set up a payment of ${amount} to you, ${schedule}`;
    }
    case MessageType.RECURRING_PAYMENT_CANCEL:
      return isOutgoing
        ? `You cancelled your recurring payment to ${peerName}`
        : `${peerName} cancelled their recurring payment`;
    case MessageType.PAYMENT_REQUEST_RESPONSE: {
      const accepted = payload.accepted === true;
      if (isOutgoing) {
        return accepted
          ? `You accepted payment request from ${peerName}`
          : `You declined payment request from ${peerName}`;
      }
      return accepted
        ? `${peerName} accepted your payment request`
        : `${peerName} declined your payment request`;
    }
    case MessageType.PAYMENT_REQUEST_CANCEL:
      return isOutgoing
        ? `You cancelled your payment request to ${peerName}`
        : `${peerName} cancelled their payment request`;
    case MessageType.FRIENDSHIP_DEFAULT: {
      // tally_eur is from the author's side: negative means the author owed.
      const tally = Number(payload.tally_eur) || 0;
      const amount = formatEur(Math.abs(tally));
      const note = payload.note ? ` — ${payload.note}` : "";
      if (isOutgoing) {
        const action =
          tally < 0 ? `You defaulted on ${amount} with ${peerName}`
          : tally > 0 ? `You absolved ${peerName}'s tally of ${amount}`
          : `You deactivated your friend connection to ${peerName}`;
        return action + note;
      }
      const action =
        tally < 0 ? `${peerName} defaulted on ${amount}`
        : tally > 0 ? `${peerName} absolved your tally of ${amount}`
        : `${peerName} deactivated your friend connection`;
      return action + note;
    }
    case MessageType.REACTIVATION_REQUEST:
      return isOutgoing
        ? `You suggested reactivating your friendship with ${peerName}`
        : `${peerName} suggested reactivating your friendship`;
    case MessageType.REACTIVATION_RESPONSE: {
      const accepted = payload.accepted === true;
      if (isOutgoing) {
        return accepted
          ? `You reactivated your friendship with ${peerName}`
          : `You declined reactivating your friendship with ${peerName}`;
      }
      return accepted
        ? `${peerName} reactivated your friendship`
        : `${peerName} declined reactivating your friendship`;
    }
    case MessageType.HISTORY_DELETED:
      return "You deleted your history with a deactivated friend";
    case MessageType.NAME_CHANGED: {
      const newName = payload.name || "";
      if (isOutgoing) {
        return `You changed your name to ${newName}`;
      }
      const subject = context.previousName || peerName;
      return `${subject} changed name to ${newName}`;
    }
    default:
      return `${entry.type} ${isOutgoing ? "→" : "←"} ${peerName}`;
  }
};

export const bindLogs = (root, data) => {
  const peerConnectionsEl = root.querySelector('[data-bind="peer-connections"]');
  const selfDeviceConnectionsEl = root.querySelector(
    '[data-bind="self-device-connections"]'
  );
  const listEl = root.querySelector('[data-list="logs"]');
  const itemTemplate = root.querySelector('[data-template="log-item"]');
  if (!listEl || !itemTemplate) return;

  if (peerConnectionsEl) {
    peerConnectionsEl.textContent = String(getConnectedPeerIds().length);
  }
  if (selfDeviceConnectionsEl) {
    // This device counts itself once it is reachable through a relay; each
    // open WebRTC channel to another own device adds one more.
    selfDeviceConnectionsEl.textContent = String(
      isAnyRelayConnected() ? 1 + getConnectedSelfDeviceIds().length : 0
    );
  }

  listEl.innerHTML = "";

  const myId = data.you?.id || "";
  const namesById = {};
  (Array.isArray(data.friends) ? data.friends : []).forEach((friend) => {
    if (friend.person_id) {
      namesById[friend.person_id] = friend.person_name || friend.person_id;
    }
  });

  const ledger = Array.isArray(data.ledger) ? data.ledger : [];
  // Notification-preference entries are bookkeeping between clients, not
  // something that happened; they'd only clutter the log.
  const entries = ledger.filter((entry) => entry.type !== MessageType.NOTIFICATION_PREFS);
  // Inbound events of these types also reach the user as OS notifications
  // (Settings → Notifications); their rows are highlighted.
  const osNotifyTypes = new Set(getOsNotifyTypes(ledger, myId));

  // For each name_changed entry, find the previous name by scanning the ledger
  // chronologically. We track the last known name per user as we go so
  // "Alice changed name from X to Alice" shows the right X rather than "Alice".
  const previousNameByEntryId = {};
  const nameAtTime = {}; // userId → name just before this point in time
  const chronological = [...entries].sort((a, b) => {
    const aTs = a.originated_at || a.timestamp || "";
    const bTs = b.originated_at || b.timestamp || "";
    return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
  });
  chronological.forEach((entry) => {
    if (entry.type === MessageType.NAME_CHANGED && typeof entry.payload?.name === "string") {
      const userId = entry.from_user_id;
      if (nameAtTime[userId]) {
        previousNameByEntryId[entry.id] = nameAtTime[userId];
      }
      nameAtTime[userId] = entry.payload.name;
    }
  });

  // This device's errors (js/ui/error-report.js) sit among the ledger events,
  // newest first like the ledger, shown in red.
  const ERROR_TYPE = "local_error";
  const errors = getErrorLog().map((error) => ({ ...error, type: ERROR_TYPE }));
  const rows = [...entries, ...errors].sort((a, b) =>
    a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0
  );

  initInfiniteList(listEl, rows, (entry) => {
    const node = itemTemplate.content.firstElementChild.cloneNode(true);
    const timeEl = node.querySelector('[data-bind="time"]');
    const textEl = node.querySelector('[data-bind="text"]');
    if (timeEl) {
      const time = new Date(entry.timestamp);
      timeEl.textContent = Number.isNaN(time.getTime())
        ? ""
        : time.toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
    }
    if (entry.to_user_id === myId && entry.from_user_id !== myId && osNotifyTypes.has(entry.type)) {
      node.classList.add("log-item--os-notify");
      node.title = "Also shown as an OS notification";
    }
    if (entry.type === ERROR_TYPE) {
      node.classList.add("log-item--error");
      if (textEl) {
        textEl.textContent = entry.text;
        if (entry.detail) {
          const detailEl = document.createElement("span");
          detailEl.className = "log-detail";
          detailEl.textContent = entry.detail;
          textEl.appendChild(detailEl);
        }
      }
    } else if (textEl) {
      textEl.innerHTML = formatMarkdownish(
        formatLedgerEntry(entry, myId, namesById, { previousName: previousNameByEntryId[entry.id] })
      );
    }
    node.addEventListener("click", () => {
      node.classList.toggle("log-item--expanded");
    });
    return node;
  });
};
