/*
A user with an external signer (NIP-07) opens Tally in a new browser.

Bug report: the friend connected over WebRTC ("Peer connections: 1" on both
sides, friend shown online), but the new browser never got the history — the
friend didn't even appear on its friends page.

Setup: Alice and Bob pair live and Bob records 70 × €1 to Alice, so both ledgers
hold signed history. The history is long enough that the sync reply has to be
split. Bob's browser is then closed, and Bob logs in on a fresh
browser whose key lives only in a fake NIP-07 extension (window.nostr backed by
Bob's key). Alice stays online.

Assertion: Bob's new browser recovers Alice as an accepted friend with the
€70 tally, through sync_hello / sync_data with Alice alone.
*/

const { ALICE, BOB, buildSoloFixtures } = require("../fixtures/paired-friends.cjs");

const RECORD_COUNT = 70;

// Fire-and-poll rather than awaiting the command inside page.evaluate:
// Chromium intermittently reports an awaited promise as "Execution context was
// destroyed" although the command completes (see friendship-fresh-start.cjs).
const callCommand = async (client, name, ...args) => {
  await client.page.evaluate(
    ({ fn, params }) => {
      window.__e2eCommand = { done: false, error: null };
      import("/dist/js/commands/index.js")
        .then((mod) => mod[fn](...params))
        .then(
          () => { window.__e2eCommand.done = true; },
          (error) => { window.__e2eCommand.error = String(error); }
        );
    },
    { fn: name, params: args }
  );
  await client.page.waitForFunction(() => window.__e2eCommand.done || window.__e2eCommand.error, null, {
    timeout: 10000,
  });
  const result = await client.page.evaluate(() => window.__e2eCommand);
  if (result.error) throw new Error(`${client.label} ${name} failed: ${result.error}`);
};

const readFriend = (client, friendId) =>
  client.page.evaluate(async (id) => {
    const { loadData } = await import("/dist/js/app-state.js");
    const data = await loadData();
    const friend = data?.friends?.find((f) => f.person_id === id);
    return friend ? { status: friend.friendship_status, debt: friend.debt_eur } : null;
  }, friendId);

const waitFor = async (predicate, label, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(last)}`);
};

// A NIP-07 extension stand-in: window.nostr backed by a private key, using the
// app's own crypto modules (loaded lazily, since init scripts run before them).
const fakeSignerScript = ({ privateKeyHex, publicKeyHex }) => {
  window.nostr = {
    getPublicKey: async () => publicKeyHex,
    signEvent: async (event) => {
      const { signNostrEvent } = await import("/dist/js/crypto/nostr-event.js");
      return signNostrEvent(event, { privateKeyHex, publicKeyHex });
    },
    nip44: {
      encrypt: async (peer, plaintext) => {
        const nip44 = await import("/dist/js/crypto/nip44.js");
        return nip44.encrypt(plaintext, { privateKeyHex, peerPublicKeyHex: peer });
      },
      decrypt: async (peer, ciphertext) => {
        const nip44 = await import("/dist/js/crypto/nip44.js");
        return nip44.decrypt(ciphertext, { privateKeyHex, peerPublicKeyHex: peer });
      },
    },
  };
};

module.exports = {
  name: "signer-new-device",
  run: async ({ assert, createSeededClient, createClient, helpers, harness }) => {
    const fixtures = buildSoloFixtures();
    const alice = await createSeededClient({ label: "alice", seed: fixtures.alice });
    const bob = await createSeededClient({ label: "bob", seed: fixtures.bob });

    await callCommand(alice, "createFriend", { friendId: BOB.publicKeyNpub, trustLimit: 50 });
    await waitFor(async () => (await readFriend(bob, ALICE.publicKeyNpub))?.status === "pending_incoming", "Bob to see the request");
    await callCommand(bob, "acceptFriend", ALICE.publicKeyNpub);
    await waitFor(async () => (await readFriend(alice, BOB.publicKeyNpub))?.status === "accepted", "Alice to see Bob accepted");
    // A long history: one sync reply for all of it would exceed NIP-44's
    // 64 KiB plaintext limit, so it must go out in parts.
    for (let index = 0; index < RECORD_COUNT; index += 1) {
      await callCommand(bob, "createTransaction", { friendId: ALICE.publicKeyNpub, amount: 1, message: `Coffee ${index + 1}` });
    }
    await waitFor(async () => (await readFriend(alice, BOB.publicKeyNpub))?.debt === RECORD_COUNT, `Alice to get €${RECORD_COUNT}`, 60000);

    // Bob's old browser goes away; only the signer still knows his key.
    await bob.context.close();

    const bobNew = await createClient({
      label: "bob-signer",
      initScripts: [
        `(${fakeSignerScript})(${JSON.stringify({ privateKeyHex: BOB.privateKeyHex, publicKeyHex: BOB.publicKeyHex })});`,
      ],
    });
    await bobNew.page.evaluate(async () => {
      const { createUser } = await import("/dist/js/app-state.js");
      await createUser("Bob", { useNip07: true });
    });
    await bobNew.page.goto(bobNew.page.url().replace(/#.*$/, "#friends"));

    const recovered = await waitFor(
      async () => {
        const friend = await readFriend(bobNew, ALICE.publicKeyNpub);
        return friend?.status === "accepted" && friend.debt === -RECORD_COUNT ? friend : null;
      },
      "Bob's new browser to recover Alice",
      harness.waitMs ?? 20000
    ).catch(async (error) => {
      const logs = helpers.getTransportLogs(bobNew, /sync|Sync|Rejected|Failed|unwrap|error/i).map((e) => e.text);
      console.log(logs.slice(-40).join("\n"));
      throw error;
    });

    assert.equal(recovered.status, "accepted");
    return recovered;
  },
};
