/*
This module binds the friend detail subpage. It renders tally/trust summary cards, injects friend-specific labels, and lists recent transactions.

It also exposes navigation triggers to related subpages by wiring the trust tile click target from the current friend context.

A disabled friendship (after a default) shows its records read-only as history, with the default notice on top, a way to suggest or answer reactivation, and a button to delete the history (commands/friendship-default.js).
@category ui
*/

import {
  acceptFriend,
  rejectFriend,
  removeFriendRequest,
} from "../../js/commands/friendship.js";
import {
  cancelTrustLimitSuggestion,
  dismissTrustLimitNotification,
  respondToTrustLimitSuggestion,
} from "../../js/commands/trust-limit.js";
import {
  cancelPaymentRequest,
  respondToPaymentRequest,
} from "../../js/commands/payment-request.js";
import { dismissNameChangeNotification } from "../../js/commands/user.js";
import {
  defaultOnFriendship,
  deleteDisabledFriendHistory,
  respondToReactivation,
  suggestReactivation,
} from "../../js/commands/friendship-default.js";
import {
  FRIENDSHIP_STATUS_ACCEPTED,
  FRIENDSHIP_STATUS_PENDING_INCOMING,
  FRIENDSHIP_STATUS_PENDING_OUTGOING,
  FRIENDSHIP_STATUS_REJECTED,
  isAcceptedFriendshipStatus,
  isDisabledFriendshipStatus,
} from "../../js/utils/friendships.js";
import { formatCurrency, formatDate, formatSigned } from "../../js/ui/format.js";
import { createFriendIcon, setFriendIconStatus } from "../components/friend-icon.js";
import { initInfiniteList } from "../../js/ui/infinite-list.js";
import { getConnectedPeerIds, getServerPresentPeerIds } from "../../js/peer/status.js";
import { showConfirmModal } from "../components/confirm-modal.js";
import { isSameRelayUrl } from "../../js/utils/relay-url.js";

const formatDefaultDate = (iso) => {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

// The default notice, from this user's side. tally_eur is the author's tally
// at the time: negative when the author owed.
const describeDefault = (info, friendName) => {
  if (!info) return "This friend connection is disabled.";
  const amount = formatCurrency(info.tally_eur);
  const date = formatDefaultDate(info.created_at);
  const text = info.is_mine
    ? info.tally_eur < 0
      ? `You defaulted on ${amount}`
      : info.tally_eur > 0
      ? `You absolved ${friendName}'s tally of ${amount}`
      : "You deactivated this friend connection"
    : info.tally_eur < 0
    ? `${friendName} defaulted on ${amount}`
    : info.tally_eur > 0
    ? `${friendName} absolved your tally of ${amount}`
    : `${friendName} deactivated this friend connection`;
  return date ? `${text} on ${date}.` : `${text}.`;
};

const renderDisabledFriendship = (root, { friend, friendId, friendName, friendFirstName, isDisabled }) => {
  const infoEl = root.querySelector('[data-section="default-info"]');
  const requestEl = root.querySelector('[data-section="reactivation-request"]');
  if (!isDisabled || !infoEl || !friendId) return;

  const textEl = infoEl.querySelector('[data-bind="default-info-text"]');
  const noteEl = infoEl.querySelector('[data-bind="default-info-note"]');
  const statusEl = infoEl.querySelector('[data-bind="reactivation-status"]');
  const suggestButton = infoEl.querySelector('[data-action="suggest-reactivation"]');
  const info = friend?.default_info;
  const pending = friend?.pending_reactivation;

  infoEl.hidden = false;
  textEl.textContent = describeDefault(info, friendName);
  noteEl.textContent = info?.note ? `“${info.note}”` : "";
  noteEl.hidden = !info?.note;

  if (pending?.is_incoming && requestEl) {
    requestEl.hidden = false;
    requestEl.querySelector('[data-bind="reactivation-request-label"]').textContent =
      `${friendFirstName} suggests reactivating your friendship`;
    requestEl.querySelector('[data-action="accept-reactivation"]').addEventListener("click", async () => {
      const confirmed = await showConfirmModal({
        title: "Reactivate friendship",
        body: `Your friendship with ${friendName} becomes active again, and your historic records count in your total tally again.`,
        confirmLabel: "Reactivate",
        variant: "success",
      });
      if (!confirmed) return;
      requestEl.hidden = true;
      await respondToReactivation(friendId, pending.id, true);
    });
    requestEl.querySelector('[data-action="decline-reactivation"]').addEventListener("click", async () => {
      requestEl.hidden = true;
      await respondToReactivation(friendId, pending.id, false);
    });
  } else if (pending) {
    statusEl.hidden = false;
    statusEl.textContent = `Reactivation suggested to ${friendFirstName}`;
  } else if (suggestButton) {
    suggestButton.hidden = false;
    suggestButton.addEventListener("click", async () => {
      const confirmed = await showConfirmModal({
        title: "Suggest reactivation",
        body: `If ${friendName} accepts, your friendship and your historic records are reactivated and count in your total tally again.\n\nYour copy of the records goes along with the suggestion, in case ${friendFirstName} no longer has theirs.`,
        confirmLabel: "Suggest",
        variant: "success",
      });
      if (!confirmed) return;
      await suggestReactivation(friendId);
    });
  }
};

export const bindFriendDetail = (root, data, friendId) => {
  const titleEl = root.querySelector('[data-bind="page-title"]');
  const labelEl = root.querySelector('[data-bind="friend-label"]');
  const headerRight = root.querySelector('[data-slot="subpage-header-right"]');
  const bodyEl = root.querySelector('[data-section="friend-body"]');
  const tallyLabelEl = root.querySelector('[data-bind="tally-label"]');
  const tallyAmountEl = root.querySelector('[data-bind="tally-amount"]');
  const trustTitleEl = root.querySelector('[data-bind="trust-title"]');
  const trustAmountEl = root.querySelector('[data-bind="trust-amount"]');
  const trustButton = root.querySelector('[data-section="trust-limit"]');
  const listEl = root.querySelector('[data-list="friend-transactions"]');
  const txTemplate = root.querySelector('[data-template="tx-item"]');
  const friendRequestEl = root.querySelector('[data-section="friend-request-notification"]');
  const friendRequestLabelEl = root.querySelector('[data-bind="friend-request-label"]');
  const friendAcceptActionsEl = root.querySelector('[data-section="friend-accept-actions"]');
  const friendRemoveActionsEl = root.querySelector('[data-section="friend-remove-actions"]');
  const suggestionEl = root.querySelector('[data-section="trust-suggestion"]');
  const suggestionLabelEl = root.querySelector('[data-bind="trust-suggestion-label"]');
  const suggestionActionsEl = root.querySelector('[data-section="trust-suggestion-actions"]');
  const suggestionCancelActionsEl = root.querySelector('[data-section="trust-cancel-actions"]');
  const suggestionOkActionsEl = root.querySelector('[data-section="trust-ok-actions"]');

  const paymentRequestListEl = root.querySelector('[data-list="payment-requests"]');
  const paymentRequestTemplate = root.querySelector('[data-template="payment-request"]');

  const syncInfoEl = root.querySelector('[data-section="sync-info"]');
  const syncTimeEl = root.querySelector('[data-bind="sync-time"]');
  const friendKeyLabelEl = root.querySelector('[data-bind="friend-key-label"]');
  const friendDangerButton = root.querySelector('[data-action="friend-danger-action"]');
  const friendDangerLabelEl = root.querySelector('[data-bind="friend-danger-label"]');

  const friend = data.friends.find((entry) => entry.person_id === friendId);
  const friendName = friend?.person_name || "Friend";
  const friendFirstName = friendName.split(/\s+/)[0] || friendName;
  const friendshipStatus = friend?.friendship_status || FRIENDSHIP_STATUS_ACCEPTED;
  const tally = friend?.debt_eur || 0;
  const isOnline = getConnectedPeerIds().includes(friendId);
  const isRelay = !isOnline && getServerPresentPeerIds().includes(friendId);
  const isDisabled = isDisabledFriendshipStatus(friendshipStatus);
  // Accepted and disabled friendships both have records to show.
  const hasRecords = isAcceptedFriendshipStatus(friendshipStatus) || isDisabled;
  const tallyText = formatCurrency(tally);
  const friendDangerActionLabel = isDisabled
    ? "Delete history"
    : tally > 0 ? "Absolve tally" : tally < 0 ? "Default on tally" : "Deactivate friend connection";
  const friendDangerBody = isDisabled
    ? `This deletes your records with ${friendName} from this device and your other devices. **After this you can't restore the friendship yourself.**\n\nIf ${friendName} keeps their copy, they can still suggest reactivating it, and their copy of the records comes back with the suggestion.`
    : tally > 0
    ? `${friendName} currently **owes you ${tallyText}**. This action will absolve ${friendName} and also deactivate your friend connection, stopping any activity between you two.\n\nIf you want to reset the tally without deactivating the connection, you can do this by sending them ${tallyText}.\n\nIt is still possible to reactivate the friend connection and this tally later, if both of you agree to do so.`
    : tally < 0
    ? `You currently **owe ${friendName} ${tallyText}**. Resetting the tally can damage your friendship badly. It is strongly recommended to talk this through with ${friendName} before taking this step.\n\nThis action also stops any activity between you two. Though if both of you agree, the friend connection and current tally can be reactivated later.`
    : `With this action, you deactivate your friend connection to ${friendName}, stopping any activity between you two. The record history will remain visible on this page.\n\nThe friend connection can be reactivated later if both of you agree to do so.`;

  if (titleEl) {
    titleEl.textContent = friendName;
    if (isOnline || isRelay) {
      const icon = createFriendIcon();
      setFriendIconStatus(icon, isOnline, isRelay);
      titleEl.append(icon);
    }
  }

  if (friendKeyLabelEl) friendKeyLabelEl.textContent = `${friendFirstName}'s key`;
  if (friendDangerLabelEl) friendDangerLabelEl.textContent = friendDangerActionLabel;
  // Only accepted and disabled friendships have a danger action; pending
  // requests have their own buttons.
  if (friendDangerButton) friendDangerButton.hidden = !hasRecords;
  if (friendDangerButton && hasRecords && friendId) {
    friendDangerButton.addEventListener("click", async () => {
      if (isDisabled) {
        const confirmed = await showConfirmModal({
          title: friendDangerActionLabel,
          body: friendDangerBody,
          confirmLabel: friendDangerActionLabel,
        });
        if (!confirmed) return;
        await deleteDisabledFriendHistory(friendId);
        window.location.hash = "friends";
        return;
      }
      const note = await showConfirmModal({
        title: friendDangerActionLabel,
        body: friendDangerBody,
        confirmLabel: friendDangerActionLabel,
        textInput: {
          label: `Message to ${friendFirstName} (optional)`,
          placeholder: "Sent along with the notice",
        },
      });
      if (note === null) return;
      await defaultOnFriendship(friendId, note);
    });
  }

  renderDisabledFriendship(root, { friend, friendId, friendName, friendFirstName, isDisabled });

  if (syncInfoEl && syncTimeEl) {
    if (friend?.last_synced_at) {
      const syncDate = new Date(friend.last_synced_at);
      if (!Number.isNaN(syncDate.getTime())) {
        const now = new Date();
        const diffMs = now - syncDate;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffMinutes = Math.floor(diffMs / (1000 * 60));

        let timeAgo;
        if (diffDays > 0) {
          timeAgo = `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
        } else if (diffHours > 0) {
          timeAgo = `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
        } else {
          timeAgo = `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
        }

        syncTimeEl.textContent = timeAgo;
        syncInfoEl.hidden = false;
      }
    } else {
      syncTimeEl.textContent = "Never";
      syncInfoEl.hidden = false;
    }
  }
  if (labelEl) {
    labelEl.textContent = isDisabled
      ? `Historic records with ${friendFirstName}`
      : isAcceptedFriendshipStatus(friendshipStatus)
      ? `My records with ${friendFirstName}`
      : `Friendship with ${friendFirstName}`;
  }
  if (headerRight) {
    if (friendshipStatus === FRIENDSHIP_STATUS_ACCEPTED) {
      headerRight.innerHTML = `
        <button class="friend-send surface-box" type="button" data-action="send" aria-label="Record tally">
          <svg class="friend-send-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <use href="#icon-send" />
          </svg>
          <span class="friend-send-label">Send</span>
        </button>
        <button class="friend-send friend-request surface-box" type="button" data-action="request" aria-label="Request payment">
          <svg class="friend-send-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <use href="#icon-request" />
          </svg>
        </button>
      `;
    } else if (friendshipStatus === FRIENDSHIP_STATUS_REJECTED) {
      headerRight.innerHTML = `
        <span class="friend-status-chip surface-box">Rejected</span>
      `;
    } else if (isDisabled) {
      headerRight.innerHTML = `
        <span class="friend-status-chip surface-box">Disabled</span>
      `;
    }
  }
  if (friendRequestEl) {
    if (friendshipStatus === FRIENDSHIP_STATUS_PENDING_INCOMING) {
      friendRequestEl.hidden = false;
      if (friendRequestLabelEl) friendRequestLabelEl.textContent = `${friendFirstName} wants to be friends`;
      if (friendAcceptActionsEl) friendAcceptActionsEl.hidden = false;
    } else if (friendshipStatus === FRIENDSHIP_STATUS_PENDING_OUTGOING) {
      friendRequestEl.hidden = false;
      if (friendRequestLabelEl) friendRequestLabelEl.textContent = `Friend request sent to ${friendFirstName}`;
      if (friendRemoveActionsEl) friendRemoveActionsEl.hidden = false;
    }
  }
  if (trustTitleEl) {
    trustTitleEl.textContent =
      friendshipStatus === FRIENDSHIP_STATUS_PENDING_OUTGOING ||
      friendshipStatus === FRIENDSHIP_STATUS_PENDING_INCOMING
        ? "Suggested trust limit"
        : "Trust limit";
  }
  if (trustAmountEl) {
    const trustLimit = friend?.trust_credit_limit_eur ?? 0;
    trustAmountEl.textContent = formatCurrency(trustLimit);
  }
  if (
    trustButton &&
    friendId &&
    (friendshipStatus === FRIENDSHIP_STATUS_ACCEPTED ||
      friendshipStatus === FRIENDSHIP_STATUS_PENDING_OUTGOING)
  ) {
    trustButton.addEventListener("click", () => {
      window.location.hash = `trust/${friendId}`;
    });
  } else if (trustButton) {
    trustButton.classList.add("friend-stat--disabled");
    trustButton.setAttribute("aria-disabled", "true");
  }
  if (tallyLabelEl) {
    if (isDisabled) {
      tallyLabelEl.textContent = tally >= 0 ? "owed you" : "you owed";
    } else if (isAcceptedFriendshipStatus(friendshipStatus)) {
      tallyLabelEl.textContent = tally >= 0 ? "owes you" : "you owe";
    } else {
      tallyLabelEl.textContent = "Friendship";
    }
  }
  if (tallyAmountEl) {
    if (hasRecords) {
      tallyAmountEl.textContent = formatSigned(tally);
      tallyAmountEl.classList.toggle("pos", tally >= 0);
      tallyAmountEl.classList.toggle("neg", tally < 0);
    } else {
      const statusText =
        friendshipStatus === FRIENDSHIP_STATUS_PENDING_INCOMING
          ? "Incoming"
          : friendshipStatus === FRIENDSHIP_STATUS_REJECTED
          ? "Rejected"
          : "Pending";
      tallyAmountEl.textContent = statusText;
      tallyAmountEl.classList.remove("pos", "neg");
    }
  }

  const acceptButton = root.querySelector('[data-action="accept-friend"]');
  if (acceptButton && friendId) {
    acceptButton.addEventListener("click", async () => {
      await acceptFriend(friendId);
    });
  }
  const rejectButton = root.querySelector('[data-action="reject-friend"]');
  if (rejectButton && friendId) {
    rejectButton.addEventListener("click", async () => {
      await rejectFriend(friendId);
      window.location.hash = "friends";
    });
  }
  const removeRequestButton = root.querySelector('[data-action="remove-request"]');
  if (removeRequestButton && friendId) {
    removeRequestButton.addEventListener("click", async () => {
      await removeFriendRequest(friendId);
      window.location.hash = "friends";
    });
  }

  const pendingLimit = friend?.pending_credit_limit_eur;
  const isIncoming = friend?.pending_credit_limit_is_incoming;
  const hasPendingSuggestion = Number.isFinite(pendingLimit) && pendingLimit >= 0;

  if (suggestionEl && hasPendingSuggestion) {
    suggestionEl.hidden = false;
    if (isIncoming === "lowered") {
      const amountText = `${friendFirstName} lowered trust limit to ${formatCurrency(pendingLimit)}`;
      if (suggestionLabelEl) suggestionLabelEl.textContent = amountText;
      if (suggestionOkActionsEl) suggestionOkActionsEl.hidden = false;
    } else {
      const amountText = `Suggested trust limit* of ${formatCurrency(pendingLimit)}`;
      if (suggestionLabelEl) suggestionLabelEl.textContent = amountText;
      if (isIncoming === true && suggestionActionsEl) suggestionActionsEl.hidden = false;
      if (isIncoming === false && suggestionCancelActionsEl) suggestionCancelActionsEl.hidden = false;
    }
  }

  const agreeTrustButton = root.querySelector('[data-action="agree-trust"]');
  if (agreeTrustButton && friendId) {
    agreeTrustButton.addEventListener("click", async () => {
      if (suggestionEl) suggestionEl.hidden = true;

      await respondToTrustLimitSuggestion(friendId, true);
    });
  }
  const disagreeTrustButton = root.querySelector('[data-action="disagree-trust"]');
  if (disagreeTrustButton && friendId) {
    disagreeTrustButton.addEventListener("click", async () => {
      if (suggestionEl) suggestionEl.hidden = true;

      await respondToTrustLimitSuggestion(friendId, false);
    });
  }
  const cancelTrustButton = root.querySelector('[data-action="cancel-trust"]');
  if (cancelTrustButton && friendId) {
    cancelTrustButton.addEventListener("click", async () => {
      if (suggestionEl) suggestionEl.hidden = true;

      await cancelTrustLimitSuggestion(friendId);
    });
  }

  const dismissTrustButton = root.querySelector('[data-action="dismiss-trust"]');
  if (dismissTrustButton && friendId) {
    dismissTrustButton.addEventListener("click", async () => {
      if (suggestionEl) suggestionEl.hidden = true;
      await dismissTrustLimitNotification(friendId);
    });
  }

  const nameChangeEl = root.querySelector('[data-section="name-change-notification"]');
  const nameChangeLabelEl = root.querySelector('[data-bind="name-change-label"]');
  const pendingNameChange = friend?.pending_name_change;
  if (nameChangeEl && pendingNameChange) {
    nameChangeEl.hidden = false;
    if (nameChangeLabelEl) {
      nameChangeLabelEl.textContent = `${pendingNameChange.oldName} changed their name to ${pendingNameChange.newName}`;
    }
  }

  const dismissNameChangeButton = root.querySelector('[data-action="dismiss-name-change"]');
  if (dismissNameChangeButton && friendId) {
    dismissNameChangeButton.addEventListener("click", async () => {
      if (nameChangeEl) nameChangeEl.hidden = true;
      await dismissNameChangeNotification(friendId);
    });
  }

  // One box per open request, in either direction. The box hides itself on
  // click so the answer feels instant; the re-render after the command
  // persists drops it for good.
  const renderPaymentRequest = (request) => {
    const box = paymentRequestTemplate.content.firstElementChild.cloneNode(true);
    const amount = `€${request.amount_eur.toFixed(2)}`;
    const label = request.is_incoming
      ? `${friendFirstName} requests ${amount}`
      : `You requested ${amount} from ${friendFirstName}`;
    box.querySelector('[data-bind="payment-request-label"]').textContent =
      request.note ? `${label} — ${request.note}` : label;

    const onClick = (action, handler) => {
      box.querySelector(`[data-action="${action}"]`).addEventListener("click", async () => {
        box.hidden = true;
        await handler();
      });
    };
    if (request.is_incoming) {
      box.querySelector('[data-section="payment-request-accept-actions"]').hidden = false;
      onClick("accept-payment-request", () => respondToPaymentRequest(friendId, request.id, true));
      onClick("decline-payment-request", () => respondToPaymentRequest(friendId, request.id, false));
    } else {
      box.querySelector('[data-section="payment-request-cancel-actions"]').hidden = false;
      onClick("cancel-payment-request", () => cancelPaymentRequest(friendId, request.id));
    }
    return box;
  };

  if (paymentRequestListEl && paymentRequestTemplate && friendId) {
    paymentRequestListEl.replaceChildren(
      ...(friend?.pending_payment_requests ?? []).map(renderPaymentRequest)
    );
  }

  const friendKeyEl = root.querySelector('[data-bind="friend-public-key"]');
  if (friendKeyEl) friendKeyEl.textContent = friendId;

  // Relay servers shared by the friend
  const friendRelaysSectionEl = root.querySelector('[data-section="friend-relays"]');
  if (friendRelaysSectionEl) {
    const friendRelays = Array.isArray(friend?.relays) ? friend.relays : [];
    const myRelayUrls = Array.isArray(data?.relays) ? data.relays.map((r) => r.url) : [];

    friendRelaysSectionEl.innerHTML = "";

    if (friendRelays.length === 0) {
      // Friend hasn't shared relay info — hide the section entirely.
      // We don't know if they want to share, so showing a warning would be misleading.
    } else {

    const labelEl = document.createElement("div");
    labelEl.className = "friend-key-label";
    labelEl.textContent = "Relay servers";
    friendRelaysSectionEl.appendChild(labelEl);

    {
      const listEl = document.createElement("ul");
      listEl.className = "friend-relay-list";
      friendRelays.forEach((url) => {
        const isShared = myRelayUrls.some((myUrl) => isSameRelayUrl(myUrl, url));
        const li = document.createElement("li");
        const span = document.createElement("span");
        span.className = `friend-relay-url ${isShared ? "friend-relay-url--shared" : "friend-relay-url--other"}`;
        // Format same as settings: strip protocol, show host+path
        try {
          const parsed = new URL(url);
          const path = parsed.pathname === "/" ? "" : parsed.pathname;
          span.textContent = `${parsed.host}${path}`;
        } catch {
          span.textContent = url;
        }
        li.appendChild(span);
        listEl.appendChild(li);
      });
      friendRelaysSectionEl.appendChild(listEl);
    }
  }
  }

  if (!bodyEl || !listEl || !txTemplate) return;
  listEl.innerHTML = "";

  if (!hasRecords) {
    const statusBodyText =
      friendshipStatus === FRIENDSHIP_STATUS_PENDING_INCOMING
        ? "This friend request is waiting for your decision."
        : friendshipStatus === FRIENDSHIP_STATUS_REJECTED
        ? "This friendship request has been rejected."
        : "This friend request is pending until the other user accepts it.";
    bodyEl.innerHTML = `<div class="empty">${statusBodyText}</div>`;
    return;
  }

  const transactions = Array.isArray(friend?.recent_transactions)
    ? friend.recent_transactions
    : [];
  const lastViewedTransactionIds = new Set(
    Array.isArray(friend?.last_viewed_transaction_ids)
      ? friend.last_viewed_transaction_ids
      : []
  );

  if (!transactions.length) {
    bodyEl.innerHTML = `<div class="empty">No transactions yet.</div>`;
    return;
  }

  initInfiniteList(listEl, transactions, (tx) => {
    const txNode = txTemplate.content.firstElementChild.cloneNode(true);
    const dateEl = txNode.querySelector('[data-bind="date"]');
    const amountTxEl = txNode.querySelector('[data-bind="amount"]');
    const noteEl = txNode.querySelector('[data-bind="note"]');
    const isNewTransaction = tx?.id && !lastViewedTransactionIds.has(tx.id);

    txNode.classList.toggle("tx-item--new", Boolean(isNewTransaction));
    if (dateEl) dateEl.textContent = formatDate(tx.date);
    if (amountTxEl) amountTxEl.textContent = formatSigned(tx.amount_eur);
    if (noteEl) noteEl.textContent = tx.note;
    return txNode;
  });
};
