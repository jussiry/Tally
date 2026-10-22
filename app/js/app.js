/*
This module is the entry point for the client app. It parses hash routes, loads HTML templates, binds page-specific UI logic, and swaps pages with the transition controller.

It also coordinates shared startup concerns such as icon sprite injection, version-gated local data resets, navigation state, and the realtime transport bootstrap so all page modules stay focused on rendering.
@category entry
*/

import {
  createUser,
  ensureVersion,
  hasUserData,
  loadData,
  markFriendTransactionsViewed,
  subscribeToDataChanges,
} from "./app-state.js";
import { createFriend } from "./commands/friendship.js";
import { createTransaction } from "./commands/transaction.js";
import { requestPayment } from "./commands/payment-request.js";
import { updateTrustLimit } from "./commands/trust-limit.js";
import { bindTally, initTallyToggles } from "../ui-modules/tally-page/index.js";
import { bindFriends } from "../ui-modules/friends-page/index.js";
import { bindLogs } from "../ui-modules/logs-page/index.js";
import { bindSettings } from "../ui-modules/settings-page/index.js";
import { bindWelcome } from "../ui-modules/welcome-page/index.js";
import { bindFriendDetail } from "../ui-modules/subpage/friend.js";
import { bindAddFriend } from "../ui-modules/subpage/add-friend.js";
import { initTallyActions } from "../ui-modules/components/tally-actions.js";
import { showConfirmModal } from "../ui-modules/components/confirm-modal.js";
import { bindRecord } from "../ui-modules/subpage/record.js";
import { bindRequest } from "../ui-modules/subpage/request.js";
import { bindTrust } from "../ui-modules/subpage/trust.js";
import { bindTransfer } from "../ui-modules/subpage/transfer.js";
import { bindNotificationSettings } from "../ui-modules/subpage/notifications.js";
import { applyDevSeedIfRequested } from "./dev/seed.js";
import { createRealtimeClient } from "./peer/client.js";
import { subscribeToPeerStatusChanges } from "./peer/status.js";
import { ensureIconSprite } from "./ui/icons.js";
import { setActiveNav, updateNavBadges } from "./ui/nav.js";
import { getSlideDirection, swapPage } from "./ui/page-transitions.js";
import { getAppVersion } from "./version.js";
import { initSwipeNavigation } from "./ui/swipe.js";
import { registerServiceWorker, onUpdateChange } from "./ui/app-update.js";
import { showNotification } from "./ui/notifications.js";
import { resyncPushSubscription } from "./push/push-subscribe.js";

const navButtons = Array.from(document.querySelectorAll(".nav-item[data-page]"));
const contentRoot = document.getElementById("page-content");
const appRoot = document.querySelector(".app");
const navOrder = navButtons.map((button) => button.dataset.page).filter(Boolean);

const pageTitles = {
  tally: "Tally",
  friends: "Tally — Friends",
  logs: "Tally — Logs",
  settings: "Tally — Settings",
};

const templatePaths = {
  welcome: "ui-modules/welcome-page/index.html",
  tally: "ui-modules/tally-page/index.html",
  friends: "ui-modules/friends-page/index.html",
  logs: "ui-modules/logs-page/index.html",
  settings: "ui-modules/settings-page/index.html",
  subpage: "ui-modules/subpage/index.html",
  friend: "ui-modules/subpage/friend.html",
  addFriend: "ui-modules/subpage/add-friend.html",
  record: "ui-modules/subpage/record.html",
  request: "ui-modules/subpage/request.html",
  trust: "ui-modules/subpage/trust.html",
  transfer: "ui-modules/subpage/transfer.html",
  notifications: "ui-modules/subpage/notifications.html",
  trustLimitField: "ui-modules/subpage/trust-limit-field.html",
  trustExplainer: "ui-modules/subpage/trust-explainer.html",
  tallyActions: "ui-modules/components/tally-actions.html",
};

const pageBinders = {
  tally: bindTally,
  friends: bindFriends,
  logs: bindLogs,
  settings: bindSettings,
};

let lastMainPage = "tally";
let currentRoute = null;
let navigationSequence = 0;
const templateCache = new Map();
let appVersion = null;
let routeRefreshTimer = null;
const hashHistory = [];

const navigateTo = (hash) => {
  const index = hashHistory.lastIndexOf(hash);
  if (index !== -1) {
    const stepsBack = hashHistory.length - 1 - index;
    hashHistory.length = index + 1;
    window.history.go(-stepsBack);
  } else {
    window.location.hash = hash;
  }
};

const scheduleRouteRefresh = () => {
  if (routeRefreshTimer) {
    return;
  }

  routeRefreshTimer = window.setTimeout(() => {
    routeRefreshTimer = null;
    void loadActiveRoute();
  }, 0);
};

const setRouteUiState = (route) => {
  const isWelcome = route.type === "welcome";
  appRoot?.classList.toggle("is-welcome", isWelcome);
  document.body.classList.toggle("is-welcome", isWelcome);

  if (isWelcome) {
    appRoot?.classList.remove("is-subpage");
    document.title = "Tally — Welcome";
    setActiveNav(navButtons, null);
    return;
  }

  if (route.type !== "page") {
    appRoot?.classList.add("is-subpage");
    setActiveNav(navButtons, route.mainPage || lastMainPage);
    return;
  }

  appRoot?.classList.remove("is-subpage");
  document.title = pageTitles[route.page] || pageTitles.tally;
  setActiveNav(navButtons, route.page);
};

const setFallbackBackNavigation = (pageView) => {
  const backButton = pageView.querySelector("[data-back]");
  if (!backButton) return;

  backButton.addEventListener("click", () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.hash = lastMainPage || "tally";
    }
  });
};

const renderSubpageContent = (pageView, html) => {
  const contentSlot = pageView.querySelector('[data-slot="subpage-content"]');
  if (contentSlot) {
    contentSlot.innerHTML = html;
  }
  return contentSlot;
};

const renderTemplateIntoSlots = (root, slotName, html) => {
  root.querySelectorAll(`[data-slot="${slotName}"]`).forEach((slot) => {
    slot.innerHTML = html;
  });
};

const createSubpageRoute = (type, friendId = null) => ({
  type,
  friendId,
  mainPage: lastMainPage,
});

// Identity of a route for "did the page actually change?" checks. Ignores
// `mainPage`, which is only back-navigation context and can differ between two
// renders of the same page.
const routeKey = (route) =>
  route ? `${route.type}:${route.page || route.friendId || ""}` : "";

const fetchTemplate = async (path) => {
  if (templateCache.has(path)) {
    return templateCache.get(path);
  }
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error("Template not found");
  const html = await response.text();
  templateCache.set(path, html);
  return html;
};

const createPageView = (html) => {
  const page = document.createElement("div");
  page.className = "page-view";
  page.innerHTML = html;
  return page;
};

const parseRoute = () => {
  const hash = window.location.hash.replace("#", "");
  if (!hash) return { type: "page", page: "tally" };
  if (hash === "welcome") {
    return { type: "welcome" };
  }
  if (hash.startsWith("friend/")) {
    const friendId = hash.replace("friend/", "");
    return createSubpageRoute("friend", friendId);
  }
  if (hash === "add-friend") {
    return createSubpageRoute("add-friend");
  }
  if (hash.startsWith("record")) {
    const parts = hash.split("/");
    return createSubpageRoute("record", parts[1] || null);
  }
  if (hash.startsWith("request")) {
    const parts = hash.split("/");
    return createSubpageRoute("request", parts[1] || null);
  }
  if (hash.startsWith("trust/")) {
    const friendId = hash.replace("trust/", "");
    return createSubpageRoute("trust", friendId);
  }
  if (hash === "transfer") {
    return createSubpageRoute("transfer");
  }
  if (hash === "notifications") {
    return createSubpageRoute("notifications");
  }
  return pageTitles[hash] ? { type: "page", page: hash } : { type: "page", page: "tally" };
};

const resolveRouteForUserState = async (route) => {
  const userExists = await hasUserData();

  if (!userExists) {
    if (route.type !== "welcome") {
      window.location.hash = "welcome";
      return null;
    }
    return route;
  }

  if (route.type === "welcome") {
    window.location.hash = "tally";
    return null;
  }

  return route;
};

const loadPage = async (route) => {
  const isWelcome = route.type === "welcome";
  const isSubpage = !isWelcome && route.type !== "page";
  const target = isWelcome
    ? templatePaths.welcome
    : isSubpage
    ? templatePaths.subpage
    : templatePaths[route.page] || templatePaths.balance;
  const direction =
    isWelcome || currentRoute?.type === "welcome"
      ? null
      : getSlideDirection(currentRoute, route, navOrder);
  // Navigating to a different page starts at the top; re-rendering the same
  // page (a data change, peer status update, …) must leave the scroll alone.
  const isSameRoute = routeKey(currentRoute) === routeKey(route);
  const sequence = (navigationSequence += 1);

  try {
    const [html, data] = await Promise.all([
      fetchTemplate(target),
      isWelcome ? Promise.resolve(null) : loadData(),
    ]);
    let friendTransactionIdsToMark = null;
    if (sequence !== navigationSequence) return;
    if (!isWelcome && !data) {
      window.location.hash = "welcome";
      return;
    }

    const pageView = createPageView(html);
    setRouteUiState(route);
    if (data) updateNavBadges(navButtons, data);

    if (route.type === "welcome") {
      bindWelcome(pageView, {
        onCreateUser: async (name, options) => {
          await createUser(name, options);
          window.location.hash = "tally";
        },
      });
    } else if (route.type === "friend") {
      const friend = data.friends.find((entry) => entry.person_id === route.friendId);
      if (!friend) {
        window.location.hash = "friends";
        return;
      }
      friendTransactionIdsToMark = Array.isArray(friend.recent_transactions)
        ? friend.recent_transactions
            .map((transaction) => transaction?.id)
            .filter(Boolean)
        : [];
      const [friendHtml, trustExplainerHtml] = await Promise.all([
        fetchTemplate(templatePaths.friend),
        fetchTemplate(templatePaths.trustExplainer),
      ]);
      renderSubpageContent(pageView, friendHtml);
      renderTemplateIntoSlots(pageView, "trust-explainer", trustExplainerHtml);

      bindFriendDetail(pageView, data, route.friendId);
      if (friend?.person_name) {
        document.title = `Tally — ${friend.person_name}`;
      } else {
        document.title = "Tally — Friend";
      }
      initTallyActions(pageView, route.friendId);
      setFallbackBackNavigation(pageView);
    } else if (route.type === "add-friend") {
      const [addFriendHtml, trustLimitFieldHtml, trustExplainerHtml] = await Promise.all([
        fetchTemplate(templatePaths.addFriend),
        fetchTemplate(templatePaths.trustLimitField),
        fetchTemplate(templatePaths.trustExplainer),
      ]);
      renderSubpageContent(pageView, addFriendHtml);
      renderTemplateIntoSlots(pageView, "trust-limit-field", trustLimitFieldHtml);
      renderTemplateIntoSlots(pageView, "trust-explainer", trustExplainerHtml);

      const addFriendHandlers = bindAddFriend(pageView, data);
      document.title = "Tally — Add a friend";
      setFallbackBackNavigation(pageView);

      // Pre-fill friend key if redirected from send page scanner
      if (window.__prefillFriendKey) {
        const friendKeyEl = pageView.querySelector('[data-bind="friend-key"]');
        if (friendKeyEl) {
          friendKeyEl.value = window.__prefillFriendKey;
          friendKeyEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
        delete window.__prefillFriendKey;
      }
      if (addFriendHandlers?.submitEl) {
        addFriendHandlers.submitEl.addEventListener("click", async () => {
          const payload = addFriendHandlers.getPayload();
          if (!payload.friendId || payload.friendId === data.you.id) {
            return;
          }
          await createFriend(payload);
          navigateTo(`friend/${payload.friendId}`);
        });
      }
    } else if (route.type === "record") {
      const recordHtml = await fetchTemplate(templatePaths.record);
      renderSubpageContent(pageView, recordHtml);
      const recordHandlers = bindRecord(pageView, data, route.friendId);
      document.title = "Tally — Record a tally";
      setFallbackBackNavigation(pageView);
      if (recordHandlers?.submitEl) {
        recordHandlers.submitEl.addEventListener("click", async () => {
          const payload = recordHandlers.getPayload();
          if (!payload.friendId || !Number.isFinite(payload.amount) || payload.amount <= 0) {
            return;
          }
          if (payload.amount >= 100) {
            const friend = data?.friends?.find((c) => c.person_id === payload.friendId);
            const friendName = friend?.person_name || payload.friendId;
            const confirmed = await showConfirmModal({
              title: `Send €${payload.amount} to ${friendName}`,
              body: "Tally is in early development. For now, it is recommended to use it only for small transactions. Are you sure you want to continue?",
              confirmLabel: "Send",
              variant: "success",
              holdMs: 750,
            });
            if (!confirmed) return;
          }
          await createTransaction(payload);
          navigateTo(`friend/${payload.friendId}`);
        });
      }
    } else if (route.type === "request") {
      const requestHtml = await fetchTemplate(templatePaths.request);
      renderSubpageContent(pageView, requestHtml);
      const requestHandlers = bindRequest(pageView, data, route.friendId);
      document.title = "Tally — Request";
      setFallbackBackNavigation(pageView);
      if (requestHandlers?.submitEl) {
        requestHandlers.submitEl.addEventListener("click", async () => {
          const payload = requestHandlers.getPayload();
          if (!payload.friendId || !Number.isFinite(payload.amount) || payload.amount <= 0) {
            return;
          }
          await requestPayment(payload);
          navigateTo(`friend/${payload.friendId}`);
        });
      }
    } else if (route.type === "transfer") {
      const transferHtml = await fetchTemplate(templatePaths.transfer);
      renderSubpageContent(pageView, transferHtml);
      bindTransfer(pageView, data);
      document.title = "Tally — Transfer";
      setFallbackBackNavigation(pageView);
    } else if (route.type === "notifications") {
      const notificationsHtml = await fetchTemplate(templatePaths.notifications);
      renderSubpageContent(pageView, notificationsHtml);
      bindNotificationSettings(pageView, data);
      document.title = "Tally — Notifications";
      setFallbackBackNavigation(pageView);
    } else if (route.type === "trust") {
      const [trustHtml, trustLimitFieldHtml, trustExplainerHtml] = await Promise.all([
        fetchTemplate(templatePaths.trust),
        fetchTemplate(templatePaths.trustLimitField),
        fetchTemplate(templatePaths.trustExplainer),
      ]);
      renderSubpageContent(pageView, trustHtml);
      renderTemplateIntoSlots(pageView, "trust-limit-field", trustLimitFieldHtml);
      renderTemplateIntoSlots(pageView, "trust-explainer", trustExplainerHtml);
      const trustHandlers = bindTrust(pageView, data, route.friendId);
      document.title = "Tally — Trust";
      setFallbackBackNavigation(pageView);
      if (trustHandlers?.submitEl && route.friendId) {
        trustHandlers.submitEl.addEventListener("click", async () => {
          const limit = trustHandlers.limitInput
            ? parseFloat(trustHandlers.limitInput.value)
            : NaN;
          if (!Number.isFinite(limit) || limit < 0) {
            return;
          }
          await updateTrustLimit(route.friendId, limit);
          navigateTo(`friend/${route.friendId}`);
        });
      }
    } else {
      if (route.page === "tally") {
        const actionsSlot = pageView.querySelector('[data-slot="tally-actions"]');
        if (actionsSlot) {
          const actionsHtml = await fetchTemplate(templatePaths.tallyActions);
          actionsSlot.innerHTML = actionsHtml;
          initTallyActions(pageView, null);
        }
      }
      const binder = pageBinders[route.page];
      if (binder) {
        binder(pageView, data, appVersion);
      }
    }

    if (!isWelcome) {
      initTallyToggles(pageView);
    }
    await swapPage(contentRoot, pageView, { direction, resetScroll: !isSameRoute });
    if (sequence !== navigationSequence) return;

    currentRoute = route;
    if (route.type === "page") {
      lastMainPage = route.page;
    }
    if (route.type === "friend" && friendTransactionIdsToMark) {
      void markFriendTransactionsViewed(route.friendId, friendTransactionIdsToMark);
    }
  } catch (error) {
    if (sequence !== navigationSequence) return;
    const errorView = createPageView(
      `<div class="section"><div class="empty">Failed to load page.</div></div>`
    );
    await swapPage(contentRoot, errorView, { direction: null });
  }
};

navButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const page = button.dataset.page;
    if (!page) return;
    const route = parseRoute();
    if (route.type === "page" && route.page === page) return;
    window.location.hash = page;
  });
});

initSwipeNavigation(document.body, {
  navOrder,
  getIsSubpage: () => appRoot?.classList.contains("is-subpage") ?? false,
  getCurrentPage: () => lastMainPage,
});

const loadActiveRoute = async () => {
  const parsedRoute = parseRoute();
  const resolvedRoute = await resolveRouteForUserState(parsedRoute);
  if (!resolvedRoute) return;
  await loadPage(resolvedRoute);
};

window.addEventListener("hashchange", () => {
  const hash = window.location.hash.replace("#", "") || "tally";
  const existingIndex = hashHistory.lastIndexOf(hash);
  if (existingIndex !== -1 && existingIndex < hashHistory.length - 1) {
    hashHistory.length = existingIndex + 1;
  } else if (hashHistory[hashHistory.length - 1] !== hash) {
    hashHistory.push(hash);
  }
  void loadActiveRoute();
});

const initApp = async () => {
  hashHistory.push(window.location.hash.replace("#", "") || "tally");
  await applyDevSeedIfRequested();
  await ensureIconSprite();
  appVersion = await getAppVersion();
  await ensureVersion(appVersion);
  subscribeToDataChanges(scheduleRouteRefresh);
  subscribeToPeerStatusChanges(scheduleRouteRefresh);
  createRealtimeClient();

  // Offline shell + update detection. When a new version finishes installing,
  // surface it as a transient toast and refresh the route so the settings nav
  // badge and in-page update banner appear.
  onUpdateChange(() => {
    showNotification({ text: "A new version of Tally is ready — open Settings to update.", hash: "settings" });
    scheduleRouteRefresh();
  });
  void registerServiceWorker();
  // Re-publish an existing push subscription to the relays (no-op unless the
  // user previously opted in on this device).
  void resyncPushSubscription();

  await loadActiveRoute();
};

void initApp();
