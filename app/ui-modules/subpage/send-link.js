/*
Binds the "Record by link" subpage (TIP-4): invite someone who isn't on Tally
yet as a friend, give them a record, or ask them for one, and share the link any way the user likes,
with their own words. Lists the user's links still waiting, each with share,
copy and withdraw. The commands live in js/commands/offline-claim.js; this
module is only DOM.
@category ui
*/

import { loadState } from "../../js/app-state.js";
import { createOfflineClaim, getClaimLink, revokeOfflineClaim } from "../../js/commands/offline-claim.js";
import { ClaimDirection } from "../../js/ledger.js";
import { formatCurrency, formatSigned } from "../../js/ui/format.js";
import { showConfirmModal, ConfirmVariant } from "../components/confirm-modal.js";

const COPY = {
  [ClaimDirection.FRIEND]: {
    hint: "Invite someone who isn't on Tally yet. They get a link; when they open it, you become friends.",
    amountLabel: "",
    submit: "Create invitation link",
    shareText: () => "Let's keep track of favours on Tally. Open the link to become friends:",
  },
  [ClaimDirection.SEND]: {
    hint: "Record a favour to someone who isn't on Tally yet. They get a link; when they open it, the record is sent to them and you become friends.",
    amountLabel: "You owe them (€)",
    submit: "Sign and create link",
    shareText: (amount) => `I recorded ${amount} to you on Tally. Open the link to claim it:`,
  },
  [ClaimDirection.REQUEST]: {
    hint: "Ask someone who isn't on Tally yet to record a favour they owe you. They get a link; if they accept, they sign the record and you become friends.",
    amountLabel: "They owe you (€)",
    submit: "Create request link",
    shareText: (amount) => `Could you record ${amount} to me on Tally? Open the link to accept:`,
  },
};

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

const linkFor = async (claim) => {
  const state = await loadState();
  return state ? getClaimLink(state, claim) : "";
};

const bindClaimItem = (itemEl, claim) => {
  const isRequest = claim.direction === ClaimDirection.REQUEST;
  const isInvitation = claim.direction === ClaimDirection.FRIEND;
  const amountText = formatCurrency(claim.amount_eur);
  const statusEl = itemEl.querySelector('[data-bind="status"]');
  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };
  itemEl.querySelector('[data-bind="name"]').textContent = claim.recipient_name;
  const amountEl = itemEl.querySelector('[data-bind="amount"]');
  amountEl.textContent = isInvitation ? "" : formatSigned(isRequest ? claim.amount_eur : -claim.amount_eur);
  amountEl.className = isRequest ? "pos" : "neg";
  itemEl.querySelector('[data-bind="note"]').textContent = isInvitation
    ? "Friend invitation"
    : isRequest
    ? ["Request", claim.note].filter(Boolean).join(" · ")
    : claim.note;

  const shareEl = itemEl.querySelector('[data-action="share"]');
  if (typeof navigator.share !== "function") shareEl.hidden = true;
  shareEl.addEventListener("click", async () => {
    try {
      await navigator.share({ text: COPY[claim.direction].shareText(amountText), url: await linkFor(claim) });
    } catch {
      // Cancelled by the user.
    }
  });

  itemEl.querySelector('[data-action="copy"]').addEventListener("click", async () => {
    setStatus((await copyText(await linkFor(claim))) ? "Link copied - now share it with your friend." : "Couldn't copy the link.");
  });

  itemEl.querySelector('[data-action="withdraw"]').addEventListener("click", async () => {
    const confirmed = await showConfirmModal({
      title: isInvitation
        ? `Withdraw the invitation to ${claim.recipient_name}?`
        : isRequest
        ? `Withdraw the ${amountText} request to ${claim.recipient_name}?`
        : `Withdraw the ${amountText} record to ${claim.recipient_name}?`,
      body: "The link stops working.",
      confirmLabel: "Withdraw",
      variant: ConfirmVariant.DANGER,
    });
    if (confirmed) await revokeOfflineClaim(claim.claim_id);
  });
};

/**
 * @param {any} root
 * @param {any} data
 * @param {string} [initialDirection]
 */
export const bindSendLink = (root, data, initialDirection = ClaimDirection.SEND) => {
  const titleEl = root.querySelector('[data-bind="page-title"]');
  if (titleEl) titleEl.textContent = "Record by link";

  const formEl = root.querySelector('[data-form="send-link"]');
  const hintEl = root.querySelector('[data-bind="link-hint"]');
  const amountLabelEl = root.querySelector('[data-bind="amount-label"]');
  const submitLabelEl = root.querySelector('[data-bind="submit-label"]');
  const nameEl = root.querySelector('[data-bind="claim-name"]');
  const amountEl = root.querySelector('[data-bind="claim-amount"]');
  const noteEl = root.querySelector('[data-bind="claim-note"]');
  const errorEl = root.querySelector('[data-bind="claim-error"]');
  const submitEl = root.querySelector('[data-bind="claim-submit"]');
  const tabEls = root.querySelectorAll("[data-direction]");
  const recordFieldEls = root.querySelectorAll('[data-section="record-fields"]');
  const openSectionEl = root.querySelector('[data-section="open-claims"]');
  const listEl = root.querySelector('[data-list="open-claims"]');
  const template = root.querySelector('[data-template="open-claim"]');

  let direction = COPY[initialDirection] ? initialDirection : ClaimDirection.SEND;
  const setDirection = (next) => {
    direction = next;
    // Keep the choice in the URL, so the re-render after creating a link
    // (and Back) returns to the same tab.
    history.replaceState(null, "", `#send-link/${next}`);
    tabEls.forEach((tabEl) => tabEl.classList.toggle("request-tab--active", tabEl.dataset.direction === next));
    hintEl.textContent = COPY[next].hint;
    amountLabelEl.textContent = COPY[next].amountLabel;
    submitLabelEl.textContent = COPY[next].submit;
    recordFieldEls.forEach((fieldEl) => {
      fieldEl.hidden = next === ClaimDirection.FRIEND;
    });
  };
  tabEls.forEach((tabEl) => tabEl.addEventListener("click", () => setDirection(tabEl.dataset.direction)));
  setDirection(direction);

  const claims = Array.isArray(data?.offlineClaims) ? data.offlineClaims : [];
  if (openSectionEl) openSectionEl.hidden = claims.length === 0;
  claims.forEach((claim) => {
    const fragment = template.content.cloneNode(true);
    bindClaimItem(fragment.querySelector(".send-link-item"), claim);
    listEl.append(fragment);
  });

  const setError = (text) => {
    errorEl.textContent = text;
    errorEl.hidden = !text;
  };

  formEl?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = nameEl.value.trim();
    const amount = parseFloat(amountEl.value);
    if (!name) return setError("Add their name.");
    if (direction !== ClaimDirection.FRIEND && !(amount > 0)) return setError("Add the amount.");
    setError("");
    submitEl.disabled = true;
    const created = await createOfflineClaim({ direction, recipientName: name, amount, note: noteEl.value });
    submitEl.disabled = false;
    // On success the data change re-renders this page with the new link on top.
    if (!created) setError("Couldn't create the link.");
  });
};
