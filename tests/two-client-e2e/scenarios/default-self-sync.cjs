/*
Deactivations and reactivations reach the user's other devices, each on the
right friend.

Setup:
  Alice runs on two devices ("alice-laptop" and "alice-phone"), with Bob and
  Carol as accepted friends.

Flow:
  1. The laptop deactivates Bob; the phone deactivates Carol.
  2. Carol suggests reactivation; Alice agrees on the laptop.

Assertions:
  Both devices end with Bob deactivated and Carol active.
  (The order-dependence behind the original bug is covered deterministically
  by tests/friendship-status/run.mjs.)
*/

const { ALICE, BOB, CAROL, buildTrioFixtures } = require("../fixtures/paired-friends.cjs");

// Fire-and-poll, as in self-relay-sync.cjs: awaiting a command inside
// page.evaluate intermittently fails with "Execution context was destroyed".
const runCommand = async (client, modulePath, exportName, args) => {
  await client.page.evaluate(([path, name, commandArgs]) => {
    window.__e2eCommand = { done: false, error: null };
    import(path)
      .then((module) => module[name](...commandArgs))
      .then(() => { window.__e2eCommand.done = true; }, (e) => { window.__e2eCommand.error = String(e); });
  }, [modulePath, exportName, args]);
  await client.page.waitForFunction(() => window.__e2eCommand.done || window.__e2eCommand.error, null, { timeout: 10000 });
  const result = await client.page.evaluate(() => window.__e2eCommand);
  if (result.error) throw new Error(`${client.label} ${exportName} failed: ${result.error}`);
};

const deactivate = (client, friendId) =>
  runCommand(client, "/dist/js/commands/friendship-default.js", "defaultOnFriendship", [friendId, ""]);

const readStatus = (client, friendId) =>
  client.page.evaluate(async (id) => {
    const { loadData } = await import("/dist/js/app-state.js");
    const friend = (await loadData())?.friends.find((f) => f.person_id === id) || null;
    return friend?.friendship_status || null;
  }, friendId);

const waitForStatus = async (harness, client, friendId, status, timeout) => {
  const deadline = Date.now() + timeout;
  let current;
  while (Date.now() < deadline) {
    current = await readStatus(client, friendId);
    if (current === status) return;
    await harness.delay(250);
  }
  throw new Error(`${client.label}: friend ${friendId.slice(0, 12)}… is "${current}", expected "${status}"`);
};

const waitForReactivationSuggestion = async (harness, client, friendId, timeout) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const incoming = await client.page.evaluate(async (id) => {
      const { loadData } = await import("/dist/js/app-state.js");
      const friend = (await loadData())?.friends.find((f) => f.person_id === id);
      return friend?.pending_reactivation?.is_incoming === true;
    }, friendId);
    if (incoming) return;
    await harness.delay(250);
  }
  throw new Error(`${client.label} never got the reactivation suggestion`);
};

const suggest = (client, friendId) =>
  runCommand(client, "/dist/js/commands/friendship-default.js", "suggestReactivation", [friendId]);

module.exports = {
  name: "default-self-sync",
  run: async ({ createSeededClient, harness }) => {
    const timeout = harness.waitMs ?? 20000;
    const aliceId = ALICE.publicKeyNpub;
    const bobId = BOB.publicKeyNpub;
    const carolId = CAROL.publicKeyNpub;
    const fixtures = buildTrioFixtures();

    const laptop = await createSeededClient({ label: "alice-laptop", seed: fixtures.alice });
    const phone = await createSeededClient({ label: "alice-phone", seed: fixtures.alice });
    const bob = await createSeededClient({ label: "bob", seed: fixtures.bob });
    const carol = await createSeededClient({ label: "carol", seed: fixtures.carol });

    await deactivate(laptop, bobId);
    await deactivate(phone, carolId);
    for (const c of [laptop, phone]) {
      await waitForStatus(harness, c, bobId, "disabled", timeout);
      await waitForStatus(harness, c, carolId, "disabled", timeout);
    }

    // Carol suggests reactivation; Alice agrees on the laptop.
    await suggest(carol, aliceId);
    await waitForReactivationSuggestion(harness, laptop, carolId, timeout);
    await suggest(laptop, carolId);
    await waitForStatus(harness, laptop, carolId, "accepted", timeout);
    await waitForStatus(harness, phone, carolId, "accepted", timeout);
    await waitForStatus(harness, phone, bobId, "disabled", timeout);
    await waitForStatus(harness, laptop, bobId, "disabled", timeout);
    return {
      phoneBob: await readStatus(phone, bobId),
      phoneCarol: await readStatus(phone, carolId),
    };
  },
};
