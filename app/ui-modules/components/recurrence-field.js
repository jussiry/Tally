/*
The "recurring payment" part of the Send and Request forms: a centred
"Once | Recurring" choice (the chosen one in bold) and, for Recurring, how
often the payment recurs and when — the hour for a
daily one, the weekday for weekly, the day of the month for monthly, the month
for yearly. Built here and dropped into the form's `data-slot="recurrence"`, so
both forms share one control. getSchedule() returns a schedule for
js/recurring.js, or null for Once.
@category ui
*/

import { Frequency, MONTH_NAMES, WEEKDAY_NAMES } from "../../js/recurring.js";

const FREQUENCY_LABELS = [
  [Frequency.DAILY, "Daily"],
  [Frequency.WEEKLY, "Weekly"],
  [Frequency.MONTHLY, "Monthly"],
  [Frequency.YEARLY, "Yearly"],
];

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// For each frequency: the word before the start select, its options as
// [value, label], the default (now), and the schedule field it sets.
const START_CHOICES = {
  [Frequency.DAILY]: {
    label: "at",
    options: () => range(0, 23).map((h) => [h, `${String(h).padStart(2, "0")}:00`]),
    initial: (now) => (now.getHours() + 1) % 24,
    field: "hour",
  },
  [Frequency.WEEKLY]: {
    label: "on",
    options: () => [1, 2, 3, 4, 5, 6, 0].map((d) => [d, WEEKDAY_NAMES[d]]),
    initial: (now) => now.getDay(),
    field: "weekday",
  },
  [Frequency.MONTHLY]: {
    label: "on day",
    options: () => range(1, 31).map((d) => [d, String(d)]),
    initial: (now) => now.getDate(),
    field: "day",
  },
  [Frequency.YEARLY]: {
    label: "in",
    options: () => MONTH_NAMES.map((name, m) => [m, name]),
    initial: (now) => now.getMonth(),
    field: "month",
  },
};

const fillSelect = (selectEl, options, value) => {
  selectEl.replaceChildren(
    ...options.map(([optionValue, label]) => {
      const option = document.createElement("option");
      option.value = String(optionValue);
      option.textContent = label;
      return option;
    })
  );
  selectEl.value = String(value);
};

/**
 * @param {Element | null} slotEl
 * @param {{ onChange?: (recurring: boolean) => void }} [options]
 */
export const mountRecurrenceField = (slotEl, { onChange } = {}) => {
  if (!slotEl) return { getSchedule: () => null };

  slotEl.innerHTML = `
    <div class="recurrence-mode" role="radiogroup" aria-label="How many times">
      <button class="recurrence-mode-option" type="button" role="radio" data-mode="once">Once</button>
      <button class="recurrence-mode-option" type="button" role="radio" data-mode="recurring">Recurring</button>
    </div>
    <div class="recurrence-options" data-section="recurrence-options" hidden>
      <select class="form-select recurrence-select" data-bind="recurrence-frequency" aria-label="How often"></select>
      <span class="recurrence-word" data-bind="recurrence-start-label"></span>
      <select class="form-select recurrence-select" data-bind="recurrence-start" aria-label="Starting when"></select>
    </div>
  `;
  const modeEls = slotEl.querySelectorAll("[data-mode]");
  /** @type {HTMLElement} */
  const optionsEl = slotEl.querySelector('[data-section="recurrence-options"]');
  /** @type {HTMLSelectElement} */
  const frequencyEl = slotEl.querySelector('[data-bind="recurrence-frequency"]');
  const startLabelEl = slotEl.querySelector('[data-bind="recurrence-start-label"]');
  /** @type {HTMLSelectElement} */
  const startEl = slotEl.querySelector('[data-bind="recurrence-start"]');

  fillSelect(frequencyEl, FREQUENCY_LABELS, Frequency.MONTHLY);
  const showStartChoices = () => {
    const choice = START_CHOICES[frequencyEl.value];
    startLabelEl.textContent = choice.label;
    fillSelect(startEl, choice.options(), choice.initial(new Date()));
  };
  showStartChoices();

  let isRecurring = false;
  const setRecurring = (recurring) => {
    isRecurring = recurring;
    modeEls.forEach((el) => {
      const chosen = (el.getAttribute("data-mode") === "recurring") === recurring;
      el.classList.toggle("is-chosen", chosen);
      el.setAttribute("aria-checked", String(chosen));
    });
    optionsEl.hidden = !recurring;
  };
  setRecurring(false);

  frequencyEl.addEventListener("change", showStartChoices);
  modeEls.forEach((el) =>
    el.addEventListener("click", () => {
      const recurring = el.getAttribute("data-mode") === "recurring";
      if (recurring === isRecurring) return;
      setRecurring(recurring);
      onChange?.(recurring);
    })
  );

  return {
    getSchedule: () => {
      if (!isRecurring) return null;
      const frequency = frequencyEl.value;
      return { frequency, [START_CHOICES[frequency].field]: Number(startEl.value) };
    },
  };
};
