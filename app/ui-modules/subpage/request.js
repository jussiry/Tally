/*
This module binds the request subpage. It provides two tabs:

1. "Send request" — select a friend, enter amount and note, and send a payment
   request that appears as an actionable notification on the friend's side.
   Opened from a friend page (`#request/<friendId>`) that friend is preselected
   as the debtor; opened from the Tally page the select starts on "Choose
   friend…" and the submit stays disabled until a friend and a positive amount
   are given (see `bindFriendSelect`).
2. "Create QR code" — generate a QR code encoding the user's public key with
   optional amount and note so a sender can scan it.

Tab state is local to this page visit; switching tabs shows/hides panels.
@category ui
*/

import { isAcceptedFriendshipStatus } from "../../js/utils/friendships.js";
import { loadVendorScript } from "../../js/utils/vendor-loader.js";
import { encodePayUri } from "../../js/utils/qr-uri.js";
import { bindFriendSelect, bindOwesPreview } from "../components/owes-sentence.js";
import { randomNotePlaceholder } from "../../js/utils/note-placeholders.js";
import { mountRecurrenceField } from "../components/recurrence-field.js";

const getFirstName = (fullName) => fullName.split(/\s+/)[0] || fullName;

const QR_UPDATE_DEBOUNCE_MS = 300;

const bindTabs = (root) => {
  const tabs = root.querySelectorAll("[data-tab]");
  const panels = root.querySelectorAll("[data-panel]");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => t.classList.toggle("request-tab--active", t.dataset.tab === target));
      panels.forEach((p) => {
        p.hidden = p.dataset.panel !== target;
      });
    });
  });
};

const bindRequestFriend = (root, data, friendId) => {
  const selectEl = root.querySelector('[data-bind="request-to"]');
  const amountEl = root.querySelector('[data-bind="request-amount"]');
  const messageEl = root.querySelector('[data-bind="request-message"]');
  const submitEl = root.querySelector('[data-bind="request-submit"]');
  const submitLabelEl = submitEl?.querySelector(".primary-button-label");
  const userNameEl = root.querySelector('[data-bind="request-preview-user-name"]');
  const debtorAmountEl = root.querySelector('[data-bind="request-preview-debtor-amount"]');
  const creditorAmountEl = root.querySelector('[data-bind="request-preview-creditor-amount"]');

  // Display the current user on the creditor side of the sentence.
  if (userNameEl) userNameEl.textContent = data?.you?.name || "You";
  if (messageEl) messageEl.placeholder = randomNotePlaceholder();

  bindOwesPreview({ amountEl, debtorAmountEl, creditorAmountEl });

  if (messageEl) {
    const autoGrow = () => {
      messageEl.style.height = "auto";
      messageEl.style.height = messageEl.scrollHeight + "px";
    };
    messageEl.addEventListener("input", autoGrow);
  }

  const allFriends = Array.isArray(data?.friends) ? data.friends : [];
  const acceptedFriends = allFriends
    .filter((friend) => isAcceptedFriendshipStatus(friend.friendship_status))
    .sort((a, b) => {
      const aName = a.person_name || a.person_id || "";
      const bName = b.person_name || b.person_id || "";
      return aName.localeCompare(bName);
    });

  if (!acceptedFriends.length) {
    const panel = root.querySelector('[data-panel="request-friend"]');
    if (panel) {
      const hasAny = allFriends.length > 0;
      panel.innerHTML = hasAny
        ? `<div class="send-empty-state empty">
            No accepted friends yet. Complete a pending friendship or <a class="send-empty-link" href="#add-friend">add a new friend</a>
            before requesting a payment.
          </div>`
        : `<div class="send-empty-state empty">
            No friends exist. <a class="send-empty-link" href="#add-friend">Add a new friend</a> to
            request your first payment.
          </div>`;
    }
    return { submitEl: null, getPayload: () => ({ friendId: "", amount: NaN, message: "" }) };
  }

  let isRecurring = false;
  let currentName = "";
  const updateSubmitLabel = (name = currentName) => {
    currentName = name;
    const who = name ? getFirstName(name) : "friend";
    if (submitLabelEl)
      submitLabelEl.textContent = isRecurring ? `Request recurring payment from ${who}` : `Request payment from ${who}`;
  };
  const recurrence = mountRecurrenceField(root.querySelector('[data-slot="recurrence"]'), {
    onChange: (recurring) => {
      isRecurring = recurring;
      updateSubmitLabel();
    },
  });

  bindFriendSelect({
    selectEl,
    friends: acceptedFriends,
    friendId,
    amountEl,
    submitEl,
    onChange: (friend) => updateSubmitLabel(friend?.person_name || friend?.person_id),
  });

  return {
    submitEl,
    getPayload: () => {
      const amount = amountEl ? parseFloat(amountEl.value) : NaN;
      const message = messageEl ? messageEl.value : "";
      return { friendId: selectEl?.value || "", amount, message, schedule: recurrence.getSchedule() };
    },
  };
};

const bindQrCode = (root, data) => {
  const amountEl = root.querySelector('[data-bind="qr-amount"]');
  const messageEl = root.querySelector('[data-bind="qr-message"]');
  const qrEl = root.querySelector('[data-bind="request-qr"]');
  const userPublicKey = data?.you?.id || "";

  if (messageEl) {
    const autoGrow = () => {
      messageEl.style.height = "auto";
      messageEl.style.height = messageEl.scrollHeight + "px";
    };
    messageEl.addEventListener("input", autoGrow);
  }

  if (!userPublicKey || !qrEl) {
    return;
  }

  let QRCode = null;
  let debounceTimer = null;

  const renderQr = () => {
    if (!QRCode) return;

    const amount = amountEl ? parseFloat(amountEl.value) : 0;
    const note = messageEl ? messageEl.value.trim() : "";
    const uri = encodePayUri(
      userPublicKey,
      Number.isFinite(amount) && amount > 0 ? amount : null,
      note || null,
    );

    qrEl.innerHTML = "";
    const canvas = document.createElement("canvas");
    QRCode.toCanvas(canvas, uri, {
      width: 200,
      margin: 2,
      color: { dark: "#1b1b1b", light: "#ffffff" },
    });
    qrEl.appendChild(canvas);
  };

  const scheduleRender = () => {
    if (debounceTimer) {
      window.clearTimeout(debounceTimer);
    }
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      renderQr();
    }, QR_UPDATE_DEBOUNCE_MS);
  };

  amountEl?.addEventListener("input", scheduleRender);
  messageEl?.addEventListener("input", scheduleRender);

  loadVendorScript("dist/js/vendor/qrcode.js", "QRCode")
    .then((lib) => {
      QRCode = lib;
      renderQr();
    })
    .catch(() => {
      // QR generation failed silently
    });
};

export const bindRequest = (root, data, friendId) => {
  const titleEl = root.querySelector('[data-bind="page-title"]');
  if (titleEl) titleEl.textContent = "Request";

  bindTabs(root);
  const requestResult = bindRequestFriend(root, data, friendId);
  bindQrCode(root, data);

  return requestResult;
};
