/*
This module binds settings interactions for the app. It renders user/version metadata and wires actions for renaming the user and removing local app data.

By centralizing settings behavior here, the app shell only needs to pass data and version context without owning button logic.
@category ui
*/

import { resetState } from "../../js/app-state.js";
import { updateUserName } from "../../js/commands/user.js";
import { addRelay, removeRelay, setShareMyRelays } from "../../js/commands/relays.js";
import { addStunServer, removeStunServer } from "../../js/commands/stun.js";
import { isAcceptedFriendshipStatus } from "../../js/utils/friendships.js";
import { formatCurrency } from "../../js/ui/format.js";
import { initCheckToggle } from "../components/check-toggle.js";
import { showConfirmModal } from "../components/confirm-modal.js";
import { isUpdateAvailable, applyUpdate } from "../../js/ui/app-update.js";
import { isSameRelayUrl, normalizeRelayUrl } from "../../js/utils/relay-url.js";
import { getPushState, enablePush, disablePush } from "../../js/push/push-subscribe.js";

// Render the relay list inside the settings surface-box. Each row is cloned
// from the <template data-template="relay-item"> in the page HTML. The main
// relay is always first and renders without a remove button.
const ADD_RELAY_ERROR_MESSAGES = {
  invalid: "Enter a valid wss:// URL.",
  is_main: "This is already your main relay.",
  duplicate: "This relay is already in your list.",
  limit: "You've reached the maximum number of relays.",
};

const formatRelayUrlForDisplay = (url) => {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
};

const renderRelayList = (root, relays, { onRemove }) => {
  const listEl = root.querySelector('[data-list="relay-list"]');
  const template = root.querySelector('[data-template="relay-item"]');
  if (!listEl || !template) return;

  listEl.innerHTML = "";
  const entries = Array.isArray(relays) ? relays : [];
  entries.forEach((relay) => {
    const fragment = template.content.cloneNode(true);
    const itemEl = fragment.querySelector(".relay-item");
    const statusEl = fragment.querySelector('[data-bind="status"]');
    const urlEl = fragment.querySelector('[data-bind="url"]');
    const removeEl = fragment.querySelector('[data-action="remove-relay"]');

    if (itemEl) {
      itemEl.classList.toggle("is-main", relay.is_main === true);
      itemEl.dataset.relayUrl = relay.url;
    }
    if (statusEl) {
      statusEl.classList.add(`relay-status-${relay.status || "pending"}`);
      statusEl.title =
        relay.status === "connected"
          ? "Connected"
          : relay.status === "pending"
          ? "Not connected yet"
          : "Disconnected";
    }
    if (urlEl) {
      urlEl.textContent = formatRelayUrlForDisplay(relay.url);
    }
    if (removeEl) {
      if (relay.is_main) {
        removeEl.hidden = true;
      } else {
        removeEl.addEventListener("click", () => onRemove(relay.url));
      }
    }

    listEl.appendChild(fragment);
  });
};

// Rank relays that friends use but the user does not yet use, by how many
// friends use each (per-friend de-duplicated). This is the popularity signal
// from TIP-003 Phase 2: it helps users converge on overlapping relay sets
// without a central directory. We deliberately keep the floor at 1 (suggest a
// relay seen on a single friend) — the network is small today; the Sybil-
// resistance floor (TIP-003 drawback 3) becomes relevant once relay sets are
// exchanged automatically via `my_relays` rather than only through QR scans.
const computeRelaySuggestions = (data) => {
  const usedRelays = Array.isArray(data?.relays)
    ? data.relays.map((relay) => relay.url)
    : [];
  const isUsed = (url) => usedRelays.some((used) => isSameRelayUrl(used, url));

  const counts = new Map(); // url -> { url, count }
  const friends = Array.isArray(data?.friends) ? data.friends : [];
  friends.forEach((friend) => {
    const seen = new Set(); // de-dupe within a single friend's relay set
    (Array.isArray(friend.relays) ? friend.relays : []).forEach((rawUrl) => {
      const url = normalizeRelayUrl(rawUrl);
      if (!url || isUsed(url) || seen.has(url)) return;
      seen.add(url);
      const entry = counts.get(url) || { url, count: 0 };
      entry.count += 1;
      counts.set(url, entry);
    });
  });

  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.url.localeCompare(b.url)
  );
};

const renderRelaySuggestions = (root, data, { onPick }) => {
  const containerEl = root.querySelector('[data-bind="relay-suggestions"]');
  const listEl = root.querySelector('[data-list="relay-suggestions"]');
  if (!containerEl || !listEl) return;

  const suggestions = computeRelaySuggestions(data);
  listEl.innerHTML = "";
  containerEl.hidden = suggestions.length === 0;

  suggestions.forEach(({ url, count }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "relay-suggestion";
    button.dataset.relayUrl = url;

    const urlSpan = document.createElement("span");
    urlSpan.className = "relay-suggestion-url";
    urlSpan.textContent = formatRelayUrlForDisplay(url);

    const countSpan = document.createElement("span");
    countSpan.className = "relay-suggestion-count";
    countSpan.textContent = String(count);
    countSpan.title = `${count} ${count === 1 ? "friend uses" : "friends use"} this relay`;

    button.append(urlSpan, countSpan);
    button.addEventListener("click", () => onPick(url));
    listEl.appendChild(button);
  });
};

const bindRelaySection = (root, data) => {
  const formEl = root.querySelector('[data-form="add-relay"]');
  const openButtonEl = root.querySelector('[data-action="open-add-relay"]');
  const cancelButtonEl = root.querySelector('[data-action="cancel-add-relay"]');
  const inputEl = root.querySelector('[data-action="relay-url-input"]');
  const errorEl = root.querySelector('[data-bind="add-relay-error"]');
  const signEl = root.querySelector('[data-bind="relay-add-sign"]');

  const showError = (reason) => {
    if (!errorEl) return;
    const message = ADD_RELAY_ERROR_MESSAGES[reason] || "Couldn't add this relay.";
    errorEl.textContent = message;
    errorEl.hidden = false;
  };
  const clearError = () => {
    if (!errorEl) return;
    errorEl.hidden = true;
    errorEl.textContent = "";
  };

  const openForm = () => {
    if (!formEl) return;
    clearError();
    if (inputEl) inputEl.value = "";
    formEl.hidden = false;
    if (signEl) signEl.textContent = "−";
    // Only auto-focus the text input when there are no friend suggestions —
    // if chips are visible the user likely wants to pick one first.
    const hasSuggestions = computeRelaySuggestions(data).length > 0;
    if (!hasSuggestions) inputEl?.focus();
  };

  const closeForm = () => {
    if (!formEl) return;
    clearError();
    formEl.hidden = true;
    if (signEl) signEl.textContent = "+";
  };

  const submitRelay = async (value) => {
    const result = await addRelay(value);
    if (result?.ok) {
      closeForm();
    } else {
      showError(result?.reason || "invalid");
    }
  };

  renderRelaySuggestions(root, data, { onPick: (url) => void submitRelay(url) });

  openButtonEl?.addEventListener("click", () => {
    formEl?.hidden ? openForm() : closeForm();
  });
  cancelButtonEl?.addEventListener("click", closeForm);
  inputEl?.addEventListener("input", clearError);

  formEl?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitRelay(inputEl?.value || "");
  });

  renderRelayList(root, data?.relays, {
    onRemove: (url) => {
      void removeRelay(url);
    },
  });

  // "Tell friends what relays you use" toggle. Persists the flag now; the
  // actual `my_relays` peer-message exchange ships with the relay-pool
  // transport (TIP-003 §10).
  const shareToggleEl = root.querySelector('[data-bind="share-relays-toggle"]');
  if (shareToggleEl) {
    initCheckToggle(shareToggleEl, {
      checked: data?.shareMyRelays !== false,
      onChange: (isChecked) => {
        // Skip the initial sync call from initCheckToggle when the value
        // already matches what's persisted — avoids a redundant view rebuild.
        if (data?.shareMyRelays === isChecked) return;
        void setShareMyRelays(isChecked);
      },
    });
  }
};

// STUN servers are a flat, user-owned list with no live status and no friend
// suggestions — simpler than relays. Each row clones <template
// data-template="stun-item">.
const STUN_ERROR_MESSAGES = {
  invalid: "Enter a valid stun: URL, e.g. stun:host:3478.",
  duplicate: "This STUN server is already in your list.",
  limit: "You've reached the maximum number of STUN servers.",
};

const renderStunList = (root, stunServers, { onRemove }) => {
  const listEl = root.querySelector('[data-list="stun-list"]');
  const template = root.querySelector('[data-template="stun-item"]');
  if (!listEl || !template) return;

  listEl.innerHTML = "";
  (Array.isArray(stunServers) ? stunServers : []).forEach((url) => {
    const fragment = template.content.cloneNode(true);
    const itemEl = fragment.querySelector(".relay-item");
    const urlEl = fragment.querySelector('[data-bind="url"]');
    const removeEl = fragment.querySelector('[data-action="remove-stun"]');

    if (itemEl) itemEl.dataset.stunUrl = url;
    if (urlEl) urlEl.textContent = url;
    if (removeEl) removeEl.addEventListener("click", () => onRemove(url));

    listEl.appendChild(fragment);
  });
};

const bindStunSection = (root, data) => {
  const formEl = root.querySelector('[data-form="add-stun"]');
  const openButtonEl = root.querySelector('[data-action="open-add-stun"]');
  const cancelButtonEl = root.querySelector('[data-action="cancel-add-stun"]');
  const inputEl = root.querySelector('[data-action="stun-url-input"]');
  const errorEl = root.querySelector('[data-bind="add-stun-error"]');
  const signEl = root.querySelector('[data-bind="stun-add-sign"]');

  const showError = (reason) => {
    if (!errorEl) return;
    errorEl.textContent = STUN_ERROR_MESSAGES[reason] || "Couldn't add this STUN server.";
    errorEl.hidden = false;
  };
  const clearError = () => {
    if (!errorEl) return;
    errorEl.hidden = true;
    errorEl.textContent = "";
  };

  const openForm = () => {
    if (!formEl) return;
    clearError();
    if (inputEl) inputEl.value = "";
    formEl.hidden = false;
    if (signEl) signEl.textContent = "−";
    inputEl?.focus();
  };
  const closeForm = () => {
    if (!formEl) return;
    clearError();
    formEl.hidden = true;
    if (signEl) signEl.textContent = "+";
  };

  const submitStun = async (value) => {
    const result = await addStunServer(value);
    if (result?.ok) closeForm();
    else showError(result?.reason || "invalid");
  };

  openButtonEl?.addEventListener("click", () => {
    formEl?.hidden ? openForm() : closeForm();
  });
  cancelButtonEl?.addEventListener("click", closeForm);
  inputEl?.addEventListener("input", clearError);
  formEl?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitStun(inputEl?.value || "");
  });

  renderStunList(root, data?.stunServers, {
    onRemove: (url) => {
      void removeStunServer(url);
    },
  });
};

// Bind the "Notify me on this device" toggle. Push permission and subscription
// are device-local, so the toggle reflects the *current browser's* live state
// (queried via getPushState) rather than anything in the synced app state.
const bindNotifySection = async (root) => {
  const toggleEl = root.querySelector('[data-bind="os-notify-toggle"]');
  const hintEl = root.querySelector('[data-bind="os-notify-hint"]');
  const linkEl = root.querySelector('[data-bind="os-notify-link"]');
  if (!toggleEl) return;

  // The per-event choice only matters once this device can show notifications.
  const setLinkVisible = (visible) => {
    if (linkEl) linkEl.hidden = !visible;
  };

  const setHint = (message) => {
    if (!hintEl) return;
    hintEl.textContent = message || "";
    hintEl.hidden = !message;
  };

  const state = await getPushState();
  if (state === "unsupported") {
    setHint("This browser doesn't support notifications.");
    return;
  }

  toggleEl.hidden = false;
  setLinkVisible(state === "enabled");
  if (state === "denied") {
    setHint("Notifications are blocked in your browser settings.");
  }

  // Guard the initial onChange that initCheckToggle fires during setup, and any
  // programmatic correction we make below, so neither triggers a real opt-in.
  let isSyncing = true;
  const toggle = initCheckToggle(toggleEl, {
    checked: state === "enabled",
    onChange: async (isChecked) => {
      if (isSyncing) return;
      const result = isChecked ? await enablePush() : await disablePush();

      if (result === "denied") {
        setHint("Notifications are blocked in your browser settings.");
      } else if (result === "error") {
        setHint("This browser couldn't register for notifications. Try another browser, or check that push messaging isn't turned off in its settings.");
      } else {
        setHint("");
      }

      // Reconcile the visual state with what actually happened (e.g. the user
      // dismissed the permission prompt, leaving us disabled).
      const shouldBeChecked = result === "enabled";
      setLinkVisible(shouldBeChecked);
      if (shouldBeChecked !== isChecked) {
        isSyncing = true;
        toggle.setChecked(shouldBeChecked);
        isSyncing = false;
      }
    },
  });
  isSyncing = false;
};

export const bindSettings = (root, data, appVersion) => {
  const userNameEl = root.querySelector('[data-bind="user-name"]');
  const editNameButton = root.querySelector('[data-action="edit-user-name"]');
  if (userNameEl) {
    userNameEl.textContent = data?.you?.name || "You";
  }
  const nameView = root.querySelector("[data-name-view]");
  const nameEdit = root.querySelector("[data-name-edit]");
  const nameInput = root.querySelector("[data-action='name-input']");

  const enterEdit = () => {
    nameInput.value = data?.you?.name || "";
    nameView.hidden = true;
    if (editNameButton) editNameButton.hidden = true;
    nameEdit.hidden = false;
    nameInput.focus();
    nameInput.select();
  };

  const exitEdit = () => {
    nameEdit.hidden = true;
    nameView.hidden = false;
    if (editNameButton) editNameButton.hidden = false;
  };

  if (editNameButton) {
    editNameButton.addEventListener("click", enterEdit);
  }

  if (nameEdit) {
    nameEdit.addEventListener("submit", async (e) => {
      e.preventDefault();
      const nextName = nameInput.value.trim();
      if (nextName) await updateUserName(nextName);
      exitEdit();
    });

    const cancelBtn = nameEdit.querySelector("[data-action='cancel-edit-name']");
    if (cancelBtn) cancelBtn.addEventListener("click", exitEdit);
  }

  void bindNotifySection(root);
  bindRelaySection(root, data);
  bindStunSection(root, data);

  // Update banner — only shown once the service worker has a new version
  // waiting. Clicking applies it (the worker activates and the page reloads).
  const updateBanner = root.querySelector('[data-bind="update-banner"]');
  if (updateBanner) {
    updateBanner.hidden = !isUpdateAvailable();
    const applyButton = updateBanner.querySelector('[data-action="apply-update"]');
    if (applyButton) applyButton.addEventListener("click", () => applyUpdate());
  }

  const versionEl = root.querySelector('[data-bind="app-version"]');
  if (versionEl && appVersion) {
    versionEl.textContent = `Version ${appVersion}`;
  }
  const transferButton = root.querySelector('[data-action="transfer-user"]');
  if (transferButton) {
    transferButton.addEventListener("click", () => {
      window.location.hash = "transfer";
    });
  }

  const removeUserButton = root.querySelector('[data-action="remove-user"]');
  if (!removeUserButton) return;
  removeUserButton.addEventListener("click", async () => {
    const friends = Array.isArray(data?.friends) ? data.friends : [];
    const unresolvedTallies = friends.filter(
      (friend) => isAcceptedFriendshipStatus(friend.friendship_status) && friend.debt_eur !== 0
    );
    const negativeTallies = unresolvedTallies.filter((friend) => friend.debt_eur < 0);

    let tallyWarning = "";
    if (unresolvedTallies.length > 0) {
      const lines = unresolvedTallies.map((friend) => {
        const amount = formatCurrency(friend.debt_eur);
        const direction = friend.debt_eur > 0 ? `owes you ${amount}` : `you owe ${amount}`;
        return `• ${friend.person_name}: ${direction}`;
      });
      tallyWarning = `\n\nUnresolved tallies:\n${lines.join("\n")}\n`;
      if (negativeTallies.length > 0) {
        const totalOwed = negativeTallies.reduce(
          (sum, friend) => sum + Math.abs(friend.debt_eur || 0),
          0
        );
        tallyWarning += `\nIf you have not transferred your user to another device, you are in practice defaulting on a tally totalling **${formatCurrency(totalOwed)}**. This can have serious consequences.\n`;
      }
    }

    const body = `This is a serious step. This will permanently remove all local data. Unless you have **transferred your user** to another device, your will not be able to retrieve your user.${tallyWarning}\nDo you still want to remove your user data?`;
    const isConfirmed = await showConfirmModal({
      title: "Remove user data",
      body,
      confirmLabel: "Remove",
    });
    if (!isConfirmed) return;
    await resetState();
    window.location.hash = "welcome";
    window.location.reload();
  });
};
