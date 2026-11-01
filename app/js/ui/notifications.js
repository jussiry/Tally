/*
Lightweight toast notification system.

Notifications appear above the nav bar, auto-dismiss after 4 seconds,
and can be clicked to navigate somewhere. The module exposes a simple
show() function — callers don't need to know about DOM or timers.
@category ui
*/

const NOTIFICATION_DURATION_MS = 9000;

let containerEl = null;
let hideAllEl = null;
const activeToasts = new Set();

const updateHideAllVisibility = () => {
  if (!hideAllEl) return;
  hideAllEl.hidden = activeToasts.size === 0;
};

const ensureContainer = () => {
  if (containerEl) return containerEl;
  containerEl = document.createElement("div");
  containerEl.className = "notification-container";
  containerEl.setAttribute("aria-live", "polite");

  hideAllEl = document.createElement("button");
  hideAllEl.className = "notification-hide-all";
  hideAllEl.type = "button";
  hideAllEl.textContent = "Hide";
  hideAllEl.hidden = true;
  hideAllEl.addEventListener("click", () => {
    activeToasts.forEach((dismiss) => dismiss());
  });

  containerEl.appendChild(hideAllEl);
  document.body.appendChild(containerEl);
  return containerEl;
};

/** @param {{ text?: string, hash?: string, friendId?: string }} [notification] */
export const showNotification = ({ text, hash = "" } = {}) => {
  if (!text) return;

  const container = ensureContainer();
  const el = document.createElement("button");
  el.className = "notification-toast";
  el.type = "button";
  el.textContent = text;

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    activeToasts.delete(dismiss);
    updateHideAllVisibility();
    el.classList.add("notification-toast--out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };

  if (hash) {
    el.addEventListener("click", () => {
      dismiss();
      window.location.hash = hash;
    });
  } else {
    el.addEventListener("click", dismiss);
  }

  container.appendChild(el);
  activeToasts.add(dismiss);
  updateHideAllVisibility();

  setTimeout(dismiss, NOTIFICATION_DURATION_MS);
};
