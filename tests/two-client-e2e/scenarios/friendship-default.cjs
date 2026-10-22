/*
End-to-end test of defaulting on a friendship and bringing it back, through
the friend-page UI:

  1. Alice owes Bob €20 and defaults on it with a note. Both sides end up with
     a disabled friendship: listed under "Disabled connections", out of the
     totals, with the default notice and the note on the friend page.
  2. Bob deletes his history with Alice. His friend record and every ledger
     entry with her are gone.
  3. A reactivation suggestion whose history was tampered with (one record's
     amount changed, so its signature no longer matches) is rejected: Bob gets
     no friend record back.
  4. Alice suggests reactivation for real. Her history comes with it, so Bob,
     who deleted his, sees Alice again as a disabled friend with the €20
     rebuilt from verified records and an incoming suggestion.
  5. Bob accepts. Both friendships are active again, the €20 counts in both
     totals, and a new record moves the tally as usual.

Uses pre-seeded paired fixtures (already friends).
*/

const { ALICE, BOB, buildPairedFriendsFixtures } = require("../fixtures/paired-friends.cjs");

const PAGE = ".page-view.is-active";
const NOTE = "Lost my job, sorry Bob";

const createTransaction = (client, friendId, amount) =>
  client.page.evaluate(
    async ([id, value]) => {
      const { createTransaction } = await import("/dist/js/commands/transaction.js");
      await createTransaction({ friendId: id, amount: value, message: "" });
    },
    [friendId, amount]
  );

const readFriend = (client, friendId) =>
  client.page.evaluate(async (id) => {
    const { loadData } = await import("/dist/js/app-state.js");
    const data = await loadData();
    const friend = data.friends.find((f) => f.person_id === id) || null;
    return { friend, totals: data.totals };
  }, friendId);

const waitForFriend = (client, friendId, predicateSource, timeout) =>
  client.page.waitForFunction(
    async ([id, source]) => {
      const { loadData } = await import("/dist/js/app-state.js");
      const friend = (await loadData())?.friends.find((f) => f.person_id === id) || null;
      // eslint-disable-next-line no-new-func
      return new Function("friend", `return (${source});`)(friend);
    },
    [friendId, predicateSource],
    { timeout, polling: 250 }
  );

// The confirm modal's primary button must be held down.
const holdConfirm = async (client) => {
  const button = client.page.locator(".confirm-modal-confirm");
  await button.waitFor();
  await button.hover();
  await client.page.mouse.down();
  await client.page.waitForTimeout(1800);
  await client.page.mouse.up();
  await client.page.locator(".confirm-modal-backdrop").waitFor({ state: "detached" });
};

// Rendered text (hidden children left out), for boxes.
const activeText = (client, selector) =>
  client.page.locator(`${PAGE} ${selector}`).innerText();

// Source text, for labels styled in uppercase.
const activeLabel = async (client, selector) =>
  (await client.page.locator(`${PAGE} ${selector}`).textContent()).trim();

module.exports = {
  name: "friendship-default",
  run: async ({ assert, createSeededClient, helpers, harness }) => {
    const fixtures = buildPairedFriendsFixtures();
    const alice = await createSeededClient({ label: "alice", seed: fixtures.alice });
    const bob = await createSeededClient({ label: "bob", seed: fixtures.bob });
    const timeout = harness.waitMs ?? 20000;
    const aliceId = ALICE.publicKeyNpub;
    const bobId = BOB.publicKeyNpub;

    await helpers.waitForPeerConnectionCount(alice, "1");
    await createTransaction(alice, bobId, 20);
    await waitForFriend(bob, aliceId, "friend && friend.debt_eur === 20", timeout);

    // 1. Alice defaults through the danger button, with a note.
    await helpers.navigateHash(alice, `friend/${bobId}`, `${PAGE} [data-action="friend-danger-action"]`);
    assert.equal(await activeLabel(alice, '[data-bind="friend-danger-label"]'), "Default on tally");
    await alice.page.click(`${PAGE} [data-action="friend-danger-action"]`);
    const modalBody = await alice.page.locator(".confirm-modal-body").innerText();
    assert.ok(modalBody.includes("owe Bob €20.00"), `Modal names the friend: ${modalBody}`);
    assert.ok(!modalBody.includes("{friendName}"), "No raw placeholder in the modal");
    await alice.page.fill('[data-bind="confirm-modal-input"]', NOTE);
    await holdConfirm(alice);

    await waitForFriend(alice, bobId, 'friend && friend.friendship_status === "disabled"', timeout);
    await waitForFriend(bob, aliceId, 'friend && friend.friendship_status === "disabled"', timeout);

    const bobAfterDefault = await readFriend(bob, aliceId);
    assert.equal(bobAfterDefault.friend.default_info.note, NOTE);
    assert.equal(bobAfterDefault.friend.default_info.is_mine, false);
    assert.equal(bobAfterDefault.totals.totalTally, 0, "A disabled friend counts in no total");

    // Bob's friend page: history only, with the notice on top.
    await helpers.navigateHash(bob, `friend/${aliceId}`, `${PAGE} [data-section="default-info"]:not([hidden])`);
    const infoText = await activeText(bob, '[data-section="default-info"]');
    assert.ok(infoText.includes("Alice defaulted on €20.00 on "), `Default notice: ${infoText}`);
    assert.ok(infoText.includes(NOTE), `Default note shown: ${infoText}`);
    assert.equal(await activeLabel(bob, '[data-bind="friend-label"]'), "Historic records with Alice");
    assert.equal(await bob.page.locator(`${PAGE} [data-action="send"]`).count(), 0, "No send button");
    assert.equal(await activeLabel(bob, '[data-bind="friend-danger-label"]'), "Delete history");

    // Bob's friends page lists Alice under "Disabled connections".
    await helpers.navigateHash(bob, "friends", `${PAGE} [data-section="disabled-friends"]:not([hidden])`);
    assert.equal(await bob.page.locator(`${PAGE} [data-list="friends"] .friend-row`).count(), 0);
    assert.equal(await bob.page.locator(`${PAGE} [data-list="disabled-friends"] .friend-row`).count(), 1);

    // 2. Bob deletes the history.
    await helpers.navigateHash(bob, `friend/${aliceId}`, `${PAGE} [data-action="friend-danger-action"]`);
    await bob.page.click(`${PAGE} [data-action="friend-danger-action"]`);
    await holdConfirm(bob);
    await waitForFriend(bob, aliceId, "friend === null", timeout);
    const bobLedgerWithAlice = await bob.page.evaluate(async (id) => {
      const { loadData } = await import("/dist/js/app-state.js");
      return (await loadData()).ledger.filter((e) => e.from_user_id === id || e.to_user_id === id).length;
    }, aliceId);
    assert.equal(bobLedgerWithAlice, 0, "No ledger entries with Alice remain");

    // 3. A tampered history is rejected. Take Alice's real history, raise one
    // record's amount, and hand it to Bob's inbound pipeline.
    const aliceHistory = await alice.page.evaluate(async ([me, peer]) => {
      const { loadState } = await import("/dist/js/app-state.js");
      const { getLedgerEntriesForPeer } = await import("/dist/js/ledger.js");
      return getLedgerEntriesForPeer((await loadState()).ledger, me, peer);
    }, [aliceId, bobId]);
    const tampered = aliceHistory.map((entry) =>
      entry.type === "transaction_created"
        ? { ...entry, payload: { ...entry.payload, amount_eur: 2 } }
        : entry
    );
    assert.ok(tampered.some((e) => e.type === "transaction_created"), "History has the record");
    const forgedResult = await bob.page.evaluate(async ([from, to, history]) => {
      const { applyInboundPeerMessage } = await import("/dist/js/peer/bridge.js");
      const { verifyReactivationHistory } = await import("/dist/js/ledger.js");
      const result = await applyInboundPeerMessage({
        id: "peer_forged_reactivation",
        type: "reactivation_request",
        from_user_id: from,
        to_user_id: to,
        created_at: new Date().toISOString(),
        payload: { request_id: "react_forged", requester_name: "Alice", history },
      });
      return {
        receipt: result.acknowledgeResult,
        verified: await verifyReactivationHistory(history, from, to),
      };
    }, [aliceId, bobId, tampered]);
    assert.equal(forgedResult.verified, null, "Tampered history fails verification");
    assert.equal(forgedResult.receipt, "peer_ignored");
    assert.equal((await readFriend(bob, aliceId)).friend, null, "Forged suggestion restores nothing");

    // 4. Alice suggests reactivation through the UI.
    await helpers.navigateHash(alice, `friend/${bobId}`, `${PAGE} [data-action="suggest-reactivation"]:not([hidden])`);
    await alice.page.click(`${PAGE} [data-action="suggest-reactivation"]`);
    const suggestBody = await alice.page.locator(".confirm-modal-body").innerText();
    assert.ok(suggestBody.includes("count in your total tally again"), `Suggest popup: ${suggestBody}`);
    await holdConfirm(alice);
    await waitForFriend(alice, bobId, "friend && friend.pending_reactivation && !friend.pending_reactivation.is_incoming", timeout);

    await waitForFriend(
      bob,
      aliceId,
      'friend && friend.friendship_status === "disabled" && friend.pending_reactivation && friend.pending_reactivation.is_incoming',
      timeout
    );
    const bobRestored = (await readFriend(bob, aliceId)).friend;
    assert.equal(bobRestored.debt_eur, 20, "Tally rebuilt from Alice's history");
    assert.equal(bobRestored.recent_transactions.length, 1);
    assert.equal(bobRestored.default_info.note, NOTE, "The default notice came back with the history");

    // 5. Bob accepts.
    await helpers.navigateHash(bob, `friend/${aliceId}`, `${PAGE} [data-section="reactivation-request"]:not([hidden])`);
    await bob.page.click(`${PAGE} [data-action="accept-reactivation"]`);
    await holdConfirm(bob);

    await waitForFriend(bob, aliceId, 'friend && friend.friendship_status === "accepted"', timeout);
    await waitForFriend(alice, bobId, 'friend && friend.friendship_status === "accepted"', timeout);
    const bobTotals = (await readFriend(bob, aliceId)).totals;
    const aliceTotals = (await readFriend(alice, bobId)).totals;
    assert.equal(bobTotals.totalTally, 20, "The €20 counts for Bob again");
    assert.equal(aliceTotals.totalTally, -20, "The €20 counts for Alice again");

    await createTransaction(alice, bobId, 5);
    await waitForFriend(bob, aliceId, "friend && friend.debt_eur === 25", timeout);

    return { bobTotals, aliceTotals };
  },
};
