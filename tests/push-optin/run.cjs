/*
Regression test for the settings "Notify me on this device" toggle when the
browser's push service rejects the subscription (Chrome's "AbortError:
Registration failed - push service error"). The error used to escape as an
unhandled rejection and leave the toggle on; it must now reset the toggle and
show a hint.

The push service failure is simulated by stubbing PushManager in the page, so
the test doesn't depend on the browser actually reaching FCM.

Usage:
  node tests/push-optin/run.cjs [--port 3000] [--headed]

Runs against an already-running dev server (default port 3000, or TEST_PORT).
Uses a fresh browser context, so the preview's IndexedDB is untouched.
*/

const { chromium } = require("playwright");

const argv = process.argv.slice(2);
const portIndex = argv.indexOf("--port");
const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : Number(process.env.TEST_PORT) || 3000;
const headed = argv.includes("--headed");
const baseUrl = `http://localhost:${port}`;

const stubPushFailure = () => {
  Object.defineProperty(Notification, "permission", { get: () => "granted", configurable: true });
  Notification.requestPermission = async () => "granted";
  PushManager.prototype.getSubscription = async () => null;
  PushManager.prototype.subscribe = async () => {
    throw new DOMException("Registration failed - push service error", "AbortError");
  };
};

const run = async () => {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext();
  await context.addInitScript(stubPushFailure);
  const page = await context.newPage();

  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(`${baseUrl}/?seed=alice`);
    await page.getByRole("button", { name: "Settings" }).click();
    const toggle = page.locator('[data-bind="os-notify-toggle"]');
    const hint = page.locator('[data-bind="os-notify-hint"]');
    // The route transition briefly keeps the outgoing page in the DOM; wait for
    // the settings page to be the only one before touching the toggle.
    await page.waitForFunction(
      () => document.querySelectorAll('[data-bind="os-notify-toggle"]').length === 1,
      null,
      { timeout: 5000 },
    );
    await toggle.waitFor({ state: "visible" });

    await toggle.click();
    await page.waitForFunction(
      () => document.querySelector('[data-bind="os-notify-hint"]')?.textContent.includes("couldn't register"),
      null,
      { timeout: 5000 },
    );

    const pressed = await toggle.getAttribute("aria-pressed");
    const failures = [];
    if (pressed !== "false") failures.push(`toggle should be off, aria-pressed=${pressed}`);
    if (!(await hint.isVisible())) failures.push("hint should be visible");
    if (pageErrors.length) failures.push(`uncaught page errors: ${pageErrors.join("; ")}`);

    if (failures.length) {
      console.error(`FAIL push-optin:\n  ${failures.join("\n  ")}`);
      process.exitCode = 1;
    } else {
      console.log("PASS push-optin: push service failure resets the toggle and shows a hint");
    }
  } finally {
    await browser.close();
  }
};

run().catch((error) => {
  console.error("FAIL push-optin:", error.message);
  process.exitCode = 1;
});
