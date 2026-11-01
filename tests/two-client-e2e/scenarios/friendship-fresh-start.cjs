/*
After a default, a friend request only works once neither side keeps the old
history:

  1. Alice owes Bob €10 and defaults. Both friendships are deactivated.
  2. Bob deletes his history and sends Alice a friend request. Alice still
     has the history, so she ignores it: the old tally must come back only
     through a reactivation suggestion.
  3. Alice deletes her history too and sends Bob a friend request. Nothing
     is left on either side, so it works as between strangers. Bob's earlier
     request is still pending on his side, so the two requests meet and the
     friendship is accepted.
  4. The new friendship starts from zero, and records move it as usual.

Uses pre-seeded paired fixtures (already friends).
*/

const { ALICE, BOB, buildPairedFriendsFixtures } = require("../fixtures/paired-friends.cjs");

const inPage = (client, source, args) =>
  client.page.evaluate(
    // eslint-disable-next-line no-new-func
    ([code, values]) => new Function("args", `return (async () => { ${code} })();`)(values),
    [source, args]
  );

const readFriend = (client, friendId) =>
  inPage(
    client,
    `const { loadData } = await import("/dist/js/app-state.js");
     return (await loadData()).friends.find((f) => f.person_id === args.id) || null;`,
    { id: friendId }
  );

const waitForFriend = (client, friendId, predicateSource, timeout) =>
  client.page.waitForFunction(
    async ([id, source]) => {
      const { loadData } = await import("/dist/js/app-state.js");
      const friend = (await loadData())?.friends.find((f) => f.person_id === id) || null;
      // Predicates compare against the app's own status constants (S).
      const S = await import("/dist/js/utils/friendships.js");
      // eslint-disable-next-line no-new-func
      return new Function("friend", "S", `return (${source});`)(friend, S);
    },
    [friendId, predicateSource],
    { timeout, polling: 250 }
  );

// Fire-and-poll rather than awaiting the command inside page.evaluate:
// Chromium intermittently reports an awaited promise as "Execution context was
// destroyed" although the command completes (see self-relay-sync.cjs).
const command = async (client, file, name, args) => {
  await client.page.evaluate(
    ([path, fn, values]) => {
      window.__e2eCommand = { done: false, error: null };
      window.__e2eCommandPromise = import(path)
        .then((module) => module[fn](...values))
        .then(
          () => { window.__e2eCommand.done = true; },
          (error) => { window.__e2eCommand.error = String(error); }
        );
    },
    [`/dist/js/commands/${file}`, name, args]
  );
  await client.page.waitForFunction(() => window.__e2eCommand.done || window.__e2eCommand.error, null, {
    timeout: 10000,
  });
  const result = await client.page.evaluate(() => window.__e2eCommand);
  if (result.error) throw new Error(`${client.label} ${name} failed: ${result.error}`);
};

module.exports = {
  name: "friendship-fresh-start",
  run: async ({ assert, createSeededClient, helpers, harness }) => {
    const fixtures = buildPairedFriendsFixtures();
    const alice = await createSeededClient({ label: "alice", seed: fixtures.alice });
    const bob = await createSeededClient({ label: "bob", seed: fixtures.bob });
    const timeout = harness.waitMs ?? 20000;
    const aliceId = ALICE.publicKeyNpub;
    const bobId = BOB.publicKeyNpub;

    await helpers.waitForPeerConnectionCount(alice, "1");
    await command(alice, "transaction.js", "createTransaction", [{ friendId: bobId, amount: 10, message: "" }]);
    await waitForFriend(bob, aliceId, "friend && friend.debt_eur === 10", timeout);

    // 1. Default.
    await command(alice, "friendship-default.js", "defaultOnFriendship", [bobId, ""]);
    await waitForFriend(bob, aliceId, 'friend && friend.friendship_status === S.FRIENDSHIP_STATUS_DEACTIVATED', timeout);

    // 2. Bob deletes and asks again; Alice still has the history and ignores it.
    await command(bob, "friendship-default.js", "deleteDeactivatedFriendHistory", [aliceId]);
    await waitForFriend(bob, aliceId, "friend === null", timeout);
    await command(bob, "friendship.js", "createFriend", [{ friendId: aliceId, trustLimit: 50, name: "Alice" }]);
    await waitForFriend(bob, aliceId, 'friend && friend.friendship_status === S.FRIENDSHIP_STATUS_PENDING_OUTGOING', timeout);
    await harness.delay(4000);
    const aliceMeanwhile = await readFriend(alice, bobId);
    assert.ok(
      await alice.page.evaluate(async (status) => (await import("/dist/js/utils/friendships.js")).isDeactivatedFriendshipStatus(status), aliceMeanwhile.friendship_status),
      "Alice keeps the deactivated friendship"
    );
    assert.equal(aliceMeanwhile.debt_eur, -10, "Alice keeps the old tally");

    // 3. Alice deletes too; now a friend request works normally.
    await command(alice, "friendship-default.js", "deleteDeactivatedFriendHistory", [bobId]);
    await waitForFriend(alice, bobId, "friend === null", timeout);
    await command(alice, "friendship.js", "createFriend", [{ friendId: bobId, trustLimit: 50, name: "Bob" }]);

    await waitForFriend(alice, bobId, 'friend && friend.friendship_status === S.FRIENDSHIP_STATUS_ACCEPTED', timeout);
    await waitForFriend(bob, aliceId, 'friend && friend.friendship_status === S.FRIENDSHIP_STATUS_ACCEPTED', timeout);

    // 4. A fresh start.
    const aliceFresh = await readFriend(alice, bobId);
    const bobFresh = await readFriend(bob, aliceId);
    assert.equal(aliceFresh.debt_eur, 0);
    assert.equal(bobFresh.debt_eur, 0);
    assert.equal(aliceFresh.recent_transactions.length, 0, "No old records for Alice");
    assert.equal(bobFresh.recent_transactions.length, 0, "No old records for Bob");

    await command(alice, "transaction.js", "createTransaction", [{ friendId: bobId, amount: 3, message: "" }]);
    await waitForFriend(bob, aliceId, "friend && friend.debt_eur === 3", timeout);

    return { alice: aliceFresh.friendship_status, bob: bobFresh.friendship_status };
  },
};
