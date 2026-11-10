/*
One place to report "something went wrong" so the user notices it.

reportError() logs with console.error, adds the error to this device's error
list (shown in red on the Logs page), and, unless `toast: false`, shows a red
toast that opens the Logs page. The same text toasts at most once a minute, so
a failure that repeats for every message doesn't flood the screen.

The list is local and not part of the ledger: errors are this device's own
observations, not agreements between friends. It lives in localStorage (last
MAX_ERRORS), so it survives a reload; if storage is unavailable, it is kept
for this session only.
@category ui
*/

import { showNotification } from "./notifications.js";

const STORAGE_KEY = "tally.errorLog";
const MAX_ERRORS = 50;
const TOAST_REPEAT_MS = 60 * 1000;

let memoryLog = [];
const lastToastAt = new Map();

const readLog = () => {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(stored) ? stored : memoryLog;
  } catch {
    return memoryLog;
  }
};

const writeLog = (log) => {
  memoryLog = log;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(log));
  } catch {
    // Storage unavailable: the in-memory list still serves this session.
  }
};

/** @returns {{ id: string, timestamp: string, text: string, detail: string }[]} newest first */
export const getErrorLog = () => readLog();

/**
 * @param {string} text what went wrong, in words the user understands
 * @param {{ detail?: unknown, toast?: boolean }} [options] detail: the error or technical context
 */
export const reportError = (text, { detail, toast = true } = {}) => {
  const detailText =
    detail instanceof Error ? detail.message : detail == null ? "" : String(detail);
  console.error(`[Tally] ${text}${detailText ? `: ${detailText}` : ""}`, detail ?? "");

  const timestamp = new Date().toISOString();
  const entry = {
    id: `error_${timestamp}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp,
    text,
    detail: detailText,
  };
  writeLog([entry, ...readLog()].slice(0, MAX_ERRORS));

  if (!toast || typeof document === "undefined") return;
  const now = Date.now();
  if (now - (lastToastAt.get(text) || 0) < TOAST_REPEAT_MS) return;
  lastToastAt.set(text, now);
  showNotification({ text, hash: "logs", variant: "error" });
};
