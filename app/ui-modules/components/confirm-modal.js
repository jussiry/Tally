/*
This module renders a reusable confirmation modal with a hold-to-confirm primary button.

Unlike window.confirm, it supports a title, multi-line body text, a cancel action, and a confirm action that requires the user to press and hold for a short period before the action is committed. The hold interaction is designed to prevent accidental destructive actions without requiring an unfamiliar multi-click pattern.

Usage:
  const ok = await showConfirmModal({
    title: "Remove user data",
    body: "…multi-line text…",
    confirmLabel: "Remove",
    holdMs: 1500,
  });
  if (ok) doDestructiveThing();

Pass `textInput: { label, placeholder }` to add an optional free-text field
(e.g. a note sent along with the action). The promise then resolves with the
trimmed text (possibly "") on confirm and null on cancel, instead of a boolean.

The modal mounts to document.body, traps the focus on the cancel button by default, closes on Esc / backdrop click (treated as cancel), and resolves with a boolean indicating confirmation.
@category ui
*/

import { formatMarkdownish } from "../../js/utils/markdownish.js";

const DEFAULT_HOLD_MS = 1500;

const createElement = (tag, className, attrs = {}) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === true) el.setAttribute(key, "");
    else if (value !== false && value != null) el.setAttribute(key, value);
  }
  return el;
};

export const showConfirmModal = ({
  title,
  body,
  confirmLabel = "Confirm",
  confirmButtonLabel = null,
  cancelLabel = "Cancel",
  holdMs = DEFAULT_HOLD_MS,
  // 'danger' (default, red) | 'success' (green)
  variant = "danger",
  textInput = null,
} = {}) => {
  return new Promise((resolve) => {
    const backdrop = createElement("div", "confirm-modal-backdrop", {
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "confirm-modal-title",
    });

    const dialog = createElement("div", "confirm-modal");
    backdrop.appendChild(dialog);

    if (title) {
      const titleEl = createElement("h3", "confirm-modal-title", { id: "confirm-modal-title" });
      titleEl.textContent = title;
      dialog.appendChild(titleEl);
    }

    if (body) {
      const bodyEl = createElement("div", "confirm-modal-body");
      bodyEl.innerHTML = formatMarkdownish(body);
      dialog.appendChild(bodyEl);
    }

    let inputEl = null;
    if (textInput) {
      const field = createElement("label", "confirm-modal-field");
      if (textInput.label) {
        const labelEl = createElement("span", "confirm-modal-field-label");
        labelEl.textContent = textInput.label;
        field.appendChild(labelEl);
      }
      inputEl = createElement("textarea", "confirm-modal-input", {
        rows: "3",
        maxlength: "500",
        placeholder: textInput.placeholder || "",
        "data-bind": "confirm-modal-input",
      });
      field.appendChild(inputEl);
      dialog.appendChild(field);
    }

    const actions = createElement("div", "confirm-modal-actions");
    const cancelBtn = createElement("button", "confirm-modal-cancel", { type: "button" });
    cancelBtn.textContent = cancelLabel;

    const confirmBtnClass = variant === "success"
      ? "confirm-modal-confirm confirm-modal-confirm--success"
      : "confirm-modal-confirm";
    const confirmBtn = createElement("button", confirmBtnClass, { type: "button" });
    const confirmFill = createElement("span", "confirm-modal-confirm-fill", { "aria-hidden": "true" });
    const confirmLabelEl = createElement("span", "confirm-modal-confirm-label");
    confirmLabelEl.textContent = confirmButtonLabel || `Hold to ${confirmLabel.toLowerCase()}`;
    confirmBtn.appendChild(confirmFill);
    confirmBtn.appendChild(confirmLabelEl);

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);

    let settled = false;
    let holdStart = 0;
    let rafId = 0;
    let completeTimer = 0;

    const close = (result) => {
      if (settled) return;
      settled = true;
      cancelHold();
      document.removeEventListener("keydown", onKeyDown);
      backdrop.classList.add("confirm-modal-closing");
      setTimeout(() => backdrop.remove(), 150);
      if (inputEl) resolve(result ? inputEl.value.trim() : null);
      else resolve(result);
    };

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      }
    };

    const onBackdropClick = (e) => {
      if (e.target === backdrop) close(false);
    };

    const setFill = (pct) => {
      confirmFill.style.transform = `scaleX(${Math.max(0, Math.min(1, pct))})`;
    };

    const tick = () => {
      if (!holdStart) return;
      const elapsed = performance.now() - holdStart;
      const pct = elapsed / holdMs;
      setFill(pct);
      if (pct < 1) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const cancelHold = () => {
      holdStart = 0;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      if (completeTimer) {
        clearTimeout(completeTimer);
        completeTimer = 0;
      }
      confirmBtn.classList.remove("confirm-modal-confirm-holding");
      setFill(0);
    };

    const startHold = (e) => {
      e.preventDefault();
      if (settled || holdStart) return;
      try { confirmBtn.setPointerCapture?.(e.pointerId); } catch {}
      holdStart = performance.now();
      confirmBtn.classList.add("confirm-modal-confirm-holding");
      rafId = requestAnimationFrame(tick);
      completeTimer = window.setTimeout(() => {
        setFill(1);
        close(true);
      }, holdMs);
    };

    confirmBtn.addEventListener("pointerdown", startHold);
    confirmBtn.addEventListener("pointerup", cancelHold);
    confirmBtn.addEventListener("pointerleave", cancelHold);
    confirmBtn.addEventListener("pointercancel", cancelHold);

    cancelBtn.addEventListener("click", () => close(false));
    backdrop.addEventListener("click", onBackdropClick);
    document.addEventListener("keydown", onKeyDown);

    document.body.appendChild(backdrop);
    // Focus cancel so Enter/Space on it cancels — the destructive action must be deliberate.
    requestAnimationFrame(() => cancelBtn.focus());
  });
};
