/*
Regression test for "Update now" doing nothing after two deploys in a row.

The first new version installs and waits; the app remembers that worker. A
second deploy installs a newer worker, and the browser discards the first one.
"Update now" used to message the discarded worker, so nothing happened until a
manual reload. It must now activate the newest waiting worker, and fall back to
a reload if no worker takes over.

Runs app-update.js against fake browser globals (no browser needed):
  node tests/app-update/run.mjs [path to app-update.js]
Defaults to the built app/dist/js/ui/app-update.js (run `npm run build` first).
*/

import { pathToFileURL } from "node:url";
import path from "node:path";

const modulePath = path.resolve(process.argv[2] || "app/dist/js/ui/app-update.js");

class FakeTarget {
  constructor() {
    this.listeners = {};
  }
  addEventListener(type, callback) {
    (this.listeners[type] ||= []).push(callback);
  }
  dispatch(type) {
    (this.listeners[type] || []).forEach((callback) => callback());
  }
}

class FakeWorker extends FakeTarget {
  constructor(name) {
    super();
    this.name = name;
    this.state = "installing";
    this.messages = [];
  }
  postMessage(message) {
    this.messages.push(message);
  }
  setState(state) {
    this.state = state;
    this.dispatch("statechange");
  }
}

const registration = new FakeTarget();
registration.installing = null;
registration.waiting = null;
registration.update = async () => {};

// Installs a new version the way the browser does: a newer worker installing
// while another one waits makes the older one redundant.
const deploy = (name) => {
  const worker = new FakeWorker(name);
  registration.installing = worker;
  registration.dispatch("updatefound");
  const previous = registration.waiting;
  registration.installing = null;
  registration.waiting = worker;
  if (previous) previous.setState("redundant");
  worker.setState("installed");
  return worker;
};

let reloads = 0;
const timers = [];
const serviceWorker = new FakeTarget();
serviceWorker.controller = new FakeWorker("current");
serviceWorker.register = async () => registration;

Object.defineProperty(globalThis, "navigator", { value: { serviceWorker }, configurable: true });
globalThis.document = new FakeTarget();
globalThis.window = Object.assign(new FakeTarget(), {
  location: { reload: () => (reloads += 1) },
  setInterval: () => 0,
  setTimeout: (callback) => timers.push(callback),
});

const { registerServiceWorker, applyUpdate, isUpdateAvailable } = await import(pathToFileURL(modulePath).href);

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures += 1;
};

await registerServiceWorker();
const first = deploy("first");
check(isUpdateAvailable(), "first deploy surfaces an update");
const second = deploy("second");
check(first.state === "redundant", "second deploy discards the first worker");

applyUpdate();
check(
  second.messages.some((message) => message.type === "SKIP_WAITING"),
  "Update now activates the newest waiting worker",
);

timers.forEach((callback) => callback());
check(reloads === 1, "a worker that never takes over still ends in a reload");

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
