/*
Relay push reminders (server/signaling/websocket-server.js): an app registers
when its recurring payments next fall due, and at that time the relay pushes
the reminder only if none of the user's devices is connected — a connected app
sends the payment itself.

Runs the real signaling server on a free port with the push service swapped
for a stub that records what it would push (Web Push itself needs a browser
push service). The relay checks reminders every 30 s, so this takes ~35 s.

Usage: node tests/push-reminders/run.cjs   (or: npm run test:push-reminders)
*/

const http = require("http");
const path = require("path");
const WebSocket = require("ws");

// Stub the push service before the signaling server loads it.
const pushed = [];
const pushServicePath = require.resolve(path.join(__dirname, "../../server/push/push-service.js"));
require.cache[pushServicePath] = {
  id: pushServicePath,
  filename: pushServicePath,
  loaded: true,
  exports: {
    createPushService: () => ({
      publicKey: "stub",
      addSubscription: () => {},
      removeSubscription: () => {},
      sendToUser: async (userId, payload) => {
        pushed.push({ userId, payload });
        return 1;
      },
    }),
  },
};
const { createSignalingServer } = require("../../server/signaling/websocket-server.js");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` ${detail}`}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const connect = (port, userId, reminders) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "register", user_id: userId, device_id: `${userId}-device` }));
      socket.send(JSON.stringify({ type: "push_reminders", reminders }));
      resolve(socket);
    });
    socket.on("error", reject);
  });

const run = async () => {
  const server = http.createServer();
  createSignalingServer(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const soon = new Date(Date.now() + 1000).toISOString();
  const later = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // Closed app: registers, then disconnects before the time.
  const closed = await connect(port, "user-closed", [
    { id: "due-soon", at: soon, hint: "cipher-1" },
    { id: "due-later", at: later, hint: "cipher-2" },
  ]);
  // Open app: stays connected.
  const open = await connect(port, "user-open", [{ id: "open-soon", at: soon, hint: "cipher-3" }]);
  // Replaced list: the second registration drops the first's reminder.
  const replaced = await connect(port, "user-replaced", [{ id: "old", at: soon, hint: "cipher-4" }]);
  replaced.send(JSON.stringify({ type: "push_reminders", reminders: [] }));
  // Junk is ignored, not stored.
  const junk = await connect(port, "user-junk", [
    { id: "no-time", at: "whenever", hint: "x" },
    { id: "too-far", at: new Date(Date.now() + 500 * 86400e3).toISOString(), hint: "x" },
    { id: "", at: soon, hint: "x" },
  ]);
  await sleep(200);
  closed.close();
  replaced.close();
  junk.close();

  console.log("waiting for the relay's 30 s reminder check…");
  await sleep(35_000);

  const forUser = (userId) => pushed.filter((p) => p.userId === userId);
  const closedPushes = forUser("user-closed");
  check("closed app: due reminder pushed", closedPushes.some((p) => p.payload.message_id === "due-soon"));
  check("closed app: hint passed through untouched", closedPushes[0]?.payload.hint === "cipher-1");
  check("closed app: pushed as the user to themself", closedPushes[0]?.payload.from_user_id === "user-closed");
  check("closed app: later reminder not yet pushed", !closedPushes.some((p) => p.payload.message_id === "due-later"));
  check("open app: nothing pushed", forUser("user-open").length === 0, JSON.stringify(forUser("user-open")));
  check("replaced list: old reminder gone", forUser("user-replaced").length === 0);
  check("junk reminders ignored", forUser("user-junk").length === 0);

  open.close();
  server.close();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll push-reminder checks passed");
  process.exit(failures ? 1 : 0);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
