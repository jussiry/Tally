/*
Owns "install Tally on this device": whether the app already runs installed,
and how to install it from here.

Chromium browsers fire `beforeinstallprompt` once the app is installable, and
a page may keep that event and call `prompt()` on it from a click to open the
browser's own install dialog. The event can fire before the settings page is
open, so this module listens from app start (imported by app.js). Other
browsers (Safari, Firefox) have no install API: for them installInstructions()
says where the browser's own menu item is, based on the user agent.
@category ui
*/

let deferredPrompt = null;
let installed = false;
const listeners = new Set();
const notify = () => listeners.forEach((callback) => callback());

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredPrompt = event;
  notify();
});

window.addEventListener("appinstalled", () => {
  installed = true;
  deferredPrompt = null;
  notify();
});

// True when this page runs as the installed app, not in a browser tab.
export const isRunningInstalled = () =>
  installed ||
  ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"].some(
    (mode) => window.matchMedia?.(`(display-mode: ${mode})`).matches
  ) ||
  /** @type {any} */ (navigator).standalone === true;

export const canPromptInstall = () => !!deferredPrompt;

/** @param {() => void} callback */
export const onInstallChange = (callback) => {
  listeners.add(callback);
  return () => listeners.delete(callback);
};

// Opens the browser's install dialog. Resolves to "accepted", "dismissed",
// or "unavailable" when the browser offers no prompt.
export const promptInstall = async () => {
  const event = deferredPrompt;
  if (!event) return "unavailable";
  deferredPrompt = null; // a prompt event can be used only once
  event.prompt();
  const { outcome } = await event.userChoice;
  notify();
  return outcome;
};

const detectBrowser = () => {
  const ua = navigator.userAgent;
  const isIOS =
    /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (isIOS) return "ios";
  if (/Android/.test(ua)) {
    if (/SamsungBrowser/.test(ua)) return "android-samsung";
    if (/Firefox/.test(ua)) return "android-firefox";
    return "android-chrome";
  }
  if (/Firefox/.test(ua)) return "desktop-firefox";
  if (/Edg\//.test(ua)) return "desktop-edge";
  if (/Chrome|Chromium/.test(ua)) return "desktop-chrome";
  if (/Safari/.test(ua)) return "mac-safari";
  return "other";
};

const INSTRUCTIONS = {
  ios:
    "1. Tap the **Share** button (in Safari it's in the toolbar, or under the **⋯** menu; in Chrome it's next to the address bar).\n" +
    "2. Scroll down and tap **Add to Home Screen**.\n" +
    "3. Tap **Add**.\n\nThen open Tally from its home screen icon.",
  "android-chrome":
    "1. Tap the **⋮** menu in the top right corner.\n" +
    "2. Tap **Add to home screen** (or **Install app**).\n" +
    "3. Tap **Install**.",
  "android-samsung":
    "1. Tap the **☰** menu at the bottom.\n" +
    "2. Tap **Add page to**, then **Home screen**.",
  "android-firefox":
    "1. Tap the **⋮** menu.\n" +
    "2. Tap **Add app to Home screen** (or **Install**).",
  "desktop-chrome":
    "Click the install icon at the right end of the address bar, or open the **⋮** menu and choose **Cast, save and share → Install page as app**.",
  "desktop-edge":
    "Click the install icon at the right end of the address bar, or open the **⋯** menu and choose **Apps → Install this site as an app**.",
  "mac-safari": "In the menu bar, choose **File → Add to Dock**, then click **Add**.",
  "desktop-firefox":
    "Firefox on desktop can't install web apps. Open Tally in Chrome or Edge to install it, or use it on your phone.",
  other:
    "Look in your browser's menu for **Install app** or **Add to Home Screen**. If there isn't one, try Chrome, Edge or Safari.",
};

export const installInstructions = () => INSTRUCTIONS[detectBrowser()];
