/*
This module renders the friends list page. It sorts friendship rows, formats tally and trust summaries, and binds navigation to each friend's detail view.

It also owns the add-friend button behavior and keeps accepted, pending, and rejected friendships visually distinct so the list remains useful after realtime friend requests are introduced. Disabled friendships (after a default) get their own faded list at the bottom.
@category ui
*/

import { formatCurrency, formatSigned } from "../../js/ui/format.js";
import { getConnectedPeerIds, getServerPresentPeerIds } from "../../js/peer/status.js";
import { setFriendIconStatus } from "../components/friend-icon.js";
import {
  FRIENDSHIP_STATUS_ACCEPTED,
  FRIENDSHIP_STATUS_PENDING_INCOMING,
  FRIENDSHIP_STATUS_PENDING_OUTGOING,
  FRIENDSHIP_STATUS_REJECTED,
  hasActionableNotification,
  isAcceptedFriendshipStatus,
  isDisabledFriendshipStatus,
} from "../../js/utils/friendships.js";

const formatTallyWithLimit = (tallyValue, trustLimitValue) => {
  const formattedDebt = formatSigned(tallyValue).replace("€", "");
  const trustLimit = Math.round(trustLimitValue || 0);
  return `${formattedDebt} <span class="trust-limit">/ ${trustLimit} €</span>`;
};

const FLOATING_BUTTON_ID = "friends-add-button-floating";
const FRIENDSHIP_SORT_ORDER = {
  [FRIENDSHIP_STATUS_ACCEPTED]: 0,
  [FRIENDSHIP_STATUS_PENDING_INCOMING]: 1,
  [FRIENDSHIP_STATUS_PENDING_OUTGOING]: 2,
  [FRIENDSHIP_STATUS_REJECTED]: 3,
};

const compareFriendNames = (leftFriend, rightFriend) => {
  const leftName = leftFriend.person_name || leftFriend.person_id || "";
  const rightName = rightFriend.person_name || rightFriend.person_id || "";
  return leftName.localeCompare(rightName);
};

const getFriendSortWeight = (friend) => {
  return FRIENDSHIP_SORT_ORDER[friend.friendship_status] ?? 99;
};

const getPendingTrustLimit = (friend) => {
  if (
    friend.friendship_status === FRIENDSHIP_STATUS_PENDING_INCOMING ||
    friend.friendship_status === FRIENDSHIP_STATUS_PENDING_OUTGOING
  ) {
    return friend.trust_credit_limit_eur || 0;
  }
  return 0;
};

const getFriendRowState = (friend) => {
  // A disabled row looks like an active one; the section fades it.
  if (
    isAcceptedFriendshipStatus(friend.friendship_status) ||
    isDisabledFriendshipStatus(friend.friendship_status)
  ) {
    const tallyValue = friend.debt_eur || 0;
    return {
      amountHtml: formatTallyWithLimit(
        tallyValue,
        friend.trust_credit_limit_eur
      ),
      amountClassName: tallyValue >= 0 ? "pos" : "neg",
    };
  }

  if (friend.friendship_status === FRIENDSHIP_STATUS_PENDING_INCOMING) {
    const suggestedTrustLimit = getPendingTrustLimit(friend);
    return {
      amountHtml:
        suggestedTrustLimit > 0
          ? `${formatCurrency(suggestedTrustLimit)} <span class="trust-limit">suggested</span>`
          : "Incoming request",
      amountClassName: "amount--muted",
    };
  }

  if (friend.friendship_status === FRIENDSHIP_STATUS_PENDING_OUTGOING) {
    const suggestedTrustLimit = getPendingTrustLimit(friend);
    return {
      amountHtml:
        suggestedTrustLimit > 0
          ? `${formatCurrency(suggestedTrustLimit)} <span class="trust-limit">suggested</span>`
          : "Request sent",
      amountClassName: "amount--muted",
    };
  }

  if (friend.friendship_status === FRIENDSHIP_STATUS_REJECTED) {
    return {
      amountHtml: "",
      amountClassName: "amount--muted",
    };
  }

  return {
    amountHtml: "",
    amountClassName: "",
  };
};

const createFloatingButton = (inlineButton) => {
  const button = document.createElement("button");
  button.type = "button";
  button.id = FLOATING_BUTTON_ID;
  button.className = "friends-add-button friends-add-button--floating";
  button.setAttribute("aria-label", inlineButton.getAttribute("aria-label") || "Add a friend");
  button.innerHTML = inlineButton.innerHTML;
  return button;
};

const removeFloatingButton = () => {
  document.getElementById(FLOATING_BUTTON_ID)?.remove();
};

const isInlineButtonVisible = (button) => {
  const navEl = document.querySelector("nav");
  const buttonRect = button.getBoundingClientRect();
  const navTop = navEl?.getBoundingClientRect()?.top ?? window.innerHeight;
  const visibleBottom = Math.min(navTop, window.innerHeight) - 16;

  return buttonRect.top >= 0 && buttonRect.bottom <= visibleBottom;
};

const scheduleAfterLayout = (callback) => {
  let cancelled = false;

  requestAnimationFrame(() => {
    if (cancelled) return;
    requestAnimationFrame(() => {
      if (cancelled) return;
      callback();
    });
  });

  return () => {
    cancelled = true;
  };
};

export const bindFriends = (root, data) => {
  const listContainer = root.querySelector('[data-list="friends"]');
  const friendTemplate = root.querySelector('[data-template="friend-item"]');
  const addFriendButton = root.querySelector('[data-action="add-friend"]');
  const connectedPeerIds = new Set(getConnectedPeerIds());
  const serverPresentPeerIds = new Set(getServerPresentPeerIds());
  if (!listContainer || !friendTemplate) return;

  listContainer.innerHTML = "";

  if (addFriendButton) {
    addFriendButton.addEventListener("click", () => {
      window.location.hash = "add-friend";
    });

    removeFloatingButton();
    addFriendButton.style.visibility = "";

    let floatingButton = null;

    const ensureFloatingButton = () => {
      if (floatingButton?.isConnected) {
        return floatingButton;
      }

      floatingButton = createFloatingButton(addFriendButton);
      floatingButton.addEventListener("click", () => {
        window.location.hash = "add-friend";
      });
      document.body.appendChild(floatingButton);
      return floatingButton;
    };

    const hideFloatingButton = () => {
      floatingButton?.remove();
      floatingButton = null;
    };

    const syncAddFriendButton = () => {
      if (!root.isConnected) return;
      const showFloating = !isInlineButtonVisible(addFriendButton);
      if (showFloating) {
        ensureFloatingButton();
        addFriendButton.style.visibility = "hidden";
        return;
      }

      hideFloatingButton();
      addFriendButton.style.visibility = "visible";
    };

    let rafId = 0;
    const scheduleSync = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        if (!root.isConnected) return;
        syncAddFriendButton();
      });
    };

    const controller = new AbortController();
    const cleanup = () => {
      controller.abort();
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      cancelInitialSync();
      hideFloatingButton();
      addFriendButton.style.visibility = "";
    };

    window.addEventListener("scroll", scheduleSync, {
      passive: true,
      signal: controller.signal,
    });
    window.addEventListener("resize", scheduleSync, {
      passive: true,
      signal: controller.signal,
    });
    window.addEventListener("hashchange", cleanup, {
      once: true,
      signal: controller.signal,
    });

    const cancelInitialSync = scheduleAfterLayout(syncAddFriendButton);
  }

  const disabledSectionEl = root.querySelector('[data-section="disabled-friends"]');
  const disabledListEl = root.querySelector('[data-list="disabled-friends"]');
  const activeFriends = data.friends.filter(
    (friend) => !isDisabledFriendshipStatus(friend.friendship_status)
  );
  const disabledFriends = data.friends
    .filter((friend) => isDisabledFriendshipStatus(friend.friendship_status))
    .sort(compareFriendNames);

  const sortedFriends = [...activeFriends].sort((leftFriend, rightFriend) => {
    const sortWeightDifference =
      getFriendSortWeight(leftFriend) - getFriendSortWeight(rightFriend);
    if (sortWeightDifference !== 0) {
      return sortWeightDifference;
    }

    if (
      isAcceptedFriendshipStatus(leftFriend.friendship_status) &&
      isAcceptedFriendshipStatus(rightFriend.friendship_status)
    ) {
      const tallyDifference =
        Math.abs(rightFriend.debt_eur || 0) - Math.abs(leftFriend.debt_eur || 0);
      if (tallyDifference !== 0) {
        return tallyDifference;
      }
    }

    return compareFriendNames(leftFriend, rightFriend);
  });

  const renderFriendRow = (friend) => {
    const node = friendTemplate.content.firstElementChild.cloneNode(true);
    const nameEl = node.querySelector('[data-bind="name"]');
    const amountEl = node.querySelector('[data-bind="amount"]');
    const iconEl = node.querySelector('[data-bind="friend-icon"]');
    const actionDotEl = node.querySelector('[data-bind="action-dot"]');
    const rowState = getFriendRowState(friend);
    node.addEventListener("click", () => {
      window.location.hash = `friend/${friend.person_id}`;
    });
    if (nameEl) nameEl.textContent = friend.person_name || friend.person_id;
    if (iconEl) {
      const isOnline = connectedPeerIds.has(friend.person_id);
      const isRelay = !isOnline && serverPresentPeerIds.has(friend.person_id);
      setFriendIconStatus(iconEl, isOnline, isRelay);
    }
    if (actionDotEl) {
      actionDotEl.hidden = !hasActionableNotification(friend);
    }
    if (amountEl) {
      amountEl.innerHTML = rowState.amountHtml;
      amountEl.classList.remove("pos", "neg", "amount--muted");
      if (rowState.amountClassName) {
        amountEl.classList.add(rowState.amountClassName);
      }
    }

    return node;
  };

  sortedFriends.forEach((friend) => listContainer.appendChild(renderFriendRow(friend)));

  if (disabledSectionEl && disabledListEl) {
    disabledListEl.replaceChildren(...disabledFriends.map(renderFriendRow));
    disabledSectionEl.hidden = disabledFriends.length === 0;
  }
};
