/*
A payment request shared as a link (TIP-4), accepted by someone who isn't the
author's friend yet.

Bug report: the opener accepted, the two became friends, but the requested
record never arrived. The author's link stayed open on the link page and the
friend page showed no record.

Cases (LINK_CASE=existing|new|signer|signer-second-device|accepted-elsewhere|author-offline, default all):
- existing: Bob has an account and opens the link, holding Accept.
- new: someone without an account opens the link and creates one.
- signer: Bob opens it in a browser without his data and logs in with a
  NIP-07 signer from the link's welcome screen.
- signer-second-device: the same, while Bob's usual device is online too.
- accepted-elsewhere (the reported bug): Bob accepts in that browser and
  closes it while Alice's app is closed; afterwards Alice and Bob's usual
  device come online.
- author-offline: as existing, but Alice's app is closed while Bob accepts
  and opened again afterwards.

Assertion: both sides end up accepted friends with the request recorded, and
Alice's link is closed.
*/

const { ALICE, BOB, buildSoloFixtures } = require("../fixtures/paired-friends.cjs");

const AMOUNT = 12;

const readFriend = (client, friendId) =>
  client.page.evaluate(async (id) => {
    const { loadData } = await import("/dist/js/app-state.js");
    const data = await loadData();
    const friend = data?.friends?.find((f) => f.person_id === id);
    return friend ? { status: friend.friendship_status, debt: friend.debt_eur } : null;
  }, friendId);

const readMyId = (client) =>
  client.page.evaluate(async () => {
    const { loadState } = await import("/dist/js/app-state.js");
    return (await loadState()).user.id;
  });

const readOpenClaims = (client) =>
  client.page.evaluate(async () => {
    const { loadState } = await import("/dist/js/app-state.js");
    const { getOpenOfflineClaims } = await import("/dist/js/ledger.js");
    const state = await loadState();
    return getOpenOfflineClaims(state.ledger, state.user.id).length;
  });

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

const createRequestLink = (client) =>
  client.page.evaluate(async (amount) => {
    const { createOfflineClaim } = await import("/dist/js/commands/offline-claim.js");
    const result = await createOfflineClaim({ direction: "request", recipientName: "Bob", amount, note: "Lunch" });
    return result.link;
  }, AMOUNT);

// Seeded clients reseed on every page load; keep this client's state across a reopen.
const keepStateAcrossReopen = async (client) => {
  await client.context.addInitScript(() => {
    if (window.localStorage.getItem("e2e.keepState")) delete window.__IOU_SEED_STATE;
  });
  await client.page.evaluate(() => window.localStorage.setItem("e2e.keepState", "1"));
};

// A new account made from the request's welcome screen has already said yes;
// only an existing account is asked.
const holdConfirmIfShown = async (page) => {
  if (await page.locator(".confirm-modal-confirm").count()) await holdConfirm(page);
};

const holdConfirm = async (page) => {
  const confirm = page.locator(".confirm-modal-confirm");
  await confirm.waitFor({ timeout: 10000 });
  const box = await confirm.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1800);
  await page.mouse.up();
};

const expectRecorded = async ({ alice, opener, openerId, helpers, waitMs }) => {
  const aliceSide = await waitFor(
    async () => {
      const friend = await readFriend(alice, openerId);
      return friend?.status === "accepted" && Math.abs(friend.debt) === AMOUNT ? friend : null;
    },
    `Alice to get ${opener.label}'s record`,
    waitMs
  ).catch(async (error) => {
    console.log("alice sees opener:", JSON.stringify(await readFriend(alice, openerId)));
    console.log("opener sees alice:", JSON.stringify(await readFriend(opener, ALICE.publicKeyNpub)));
    if (process.env.LINK_DEBUG) {
      for (const client of [alice, opener]) {
        const ledger = await client.page.evaluate(async () => {
          const { loadState } = await import("/dist/js/app-state.js");
          const state = await loadState();
          return state.ledger.map((e) => ({ type: e.type, from: e.from_user_id.slice(0, 10), to: e.to_user_id.slice(0, 10), payload: e.payload, id: e.id }));
        });
        console.log(`ledger ${client.label}:`, JSON.stringify(ledger, null, 1));
      }
      for (const client of [alice, opener]) {
        console.log(`--- console ${client.label}`);
        console.log(client.consoleEntries.slice(-60).map((e) => e.text ?? JSON.stringify(e)).join("\n"));
      }
    }
    for (const client of [alice, opener]) {
      const logs = helpers.getTransportLogs(client, /claim|link|Rejected|Failed|error|Ignored/i).map((e) => e.text);
      console.log(`--- ${client.label}\n${logs.slice(-30).join("\n")}`);
    }
    throw error;
  });
  const openerSide = await waitFor(
    async () => {
      const friend = await readFriend(opener, ALICE.publicKeyNpub);
      return friend?.status === "accepted" && friend.debt === -aliceSide.debt ? friend : null;
    },
    `${opener.label} to hold the same record`
  );
  const openClaims = await readOpenClaims(alice);
  if (openClaims !== 0) throw new Error(`Alice still has ${openClaims} open link(s)`);
  return { alice: aliceSide, opener: openerSide };
};

// A NIP-07 extension stand-in: window.nostr backed by a private key.
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

// Bob opens the link in a browser without his data and logs in with his
// signer from the link's welcome screen.
const openLinkWithSigner = async ({ createClient, link, label }) => {
  const client = await createClient({
    label,
    initScripts: [
      `(${fakeSignerScript})(${JSON.stringify({ privateKeyHex: BOB.privateKeyHex, publicKeyHex: BOB.publicKeyHex })});`,
    ],
  });
  await client.page.goto(link.replace(/^https?:\/\/[^/]+/, new URL(client.page.url()).origin));
  await client.page.waitForSelector('[data-action="create-user-nip07"]', { state: "visible" });
  await client.page.evaluate(() => document.querySelector('[data-action="create-user-nip07"]').click());
  await client.page.waitForSelector('nav [data-page="friends"]', { timeout: 15000 });
  return client;
};

const CASES = {
  existing: async ({ createSeededClient, helpers, harness }) => {
    const fixtures = buildSoloFixtures();
    const alice = await createSeededClient({ label: "alice", seed: fixtures.alice });
    const bob = await createSeededClient({ label: "bob", seed: fixtures.bob });
    const link = await createRequestLink(alice);
    await bob.page.goto(link.replace(/^https?:\/\/[^/]+/, new URL(bob.page.url()).origin));
    await holdConfirm(bob.page);
    return expectRecorded({ alice, opener: bob, openerId: BOB.publicKeyNpub, helpers, waitMs: harness.waitMs });
  },

  new: async ({ createSeededClient, createClient, helpers, harness }) => {
    const fixtures = buildSoloFixtures();
    const alice = await createSeededClient({ label: "alice-2", seed: fixtures.alice });
    const link = await createRequestLink(alice);
    const newcomer = await createClient({ label: "newcomer" });
    await newcomer.page.goto(link.replace(/^https?:\/\/[^/]+/, new URL(newcomer.page.url()).origin));
    await newcomer.page.waitForSelector('[data-bind="welcome-name"]');
    await newcomer.page.waitForFunction(() => document.querySelector('[data-bind="welcome-name"]').value === "Bob");
    await newcomer.page.evaluate(() => document.querySelector('[data-action="create-user"]').click());
    await newcomer.page.waitForSelector('nav [data-page="friends"]', { timeout: 15000 });
    const newcomerId = await readMyId(newcomer);
    return expectRecorded({ alice, opener: newcomer, openerId: newcomerId, helpers, waitMs: harness.waitMs });
  },

  signer: async ({ createSeededClient, createClient, helpers, harness }) => {
    const fixtures = buildSoloFixtures();
    const alice = await createSeededClient({ label: "alice-4", seed: fixtures.alice });
    const link = await createRequestLink(alice);
    const bob = await openLinkWithSigner({ createClient, link, label: "bob-signer" });
    return expectRecorded({ alice, opener: bob, openerId: BOB.publicKeyNpub, helpers, waitMs: harness.waitMs });
  },

  // Bob's usual device is online too while he logs in on the new browser.
  "signer-second-device": async ({ createSeededClient, createClient, helpers, harness }) => {
    const fixtures = buildSoloFixtures();
    const alice = await createSeededClient({ label: "alice-5", seed: fixtures.alice });
    const bobHome = await createSeededClient({ label: "bob-home", seed: fixtures.bob });
    const link = await createRequestLink(alice);
    const bob = await openLinkWithSigner({ createClient, link, label: "bob-signer-2" });
    const result = await expectRecorded({ alice, opener: bob, openerId: BOB.publicKeyNpub, helpers, waitMs: harness.waitMs });
    void bobHome;
    return result;
  },

  // The reported bug: Bob accepts in a browser he then closes, while Alice's
  // app is closed. Alice's accept reaches Bob's usual device, which never saw
  // the link — so the record must not wait on the browser where he accepted.
  "accepted-elsewhere": async ({ createSeededClient, createClient, helpers, harness }) => {
    const fixtures = buildSoloFixtures();
    const alice = await createSeededClient({ label: "alice-6", seed: fixtures.alice });
    await keepStateAcrossReopen(alice);
    const link = await createRequestLink(alice);
    await alice.page.close();

    const bobBrowser = await openLinkWithSigner({ createClient, link, label: "bob-browser" });
    await holdConfirmIfShown(bobBrowser.page);
    await bobBrowser.page.waitForTimeout(3000);
    await bobBrowser.context.close();

    await helpers.reopenClient(alice, { hash: "friends" });
    const bobHome = await createSeededClient({ label: "bob-home-6", seed: fixtures.bob });
    return expectRecorded({ alice, opener: bobHome, openerId: BOB.publicKeyNpub, helpers, waitMs: harness.waitMs });
  },

  "author-offline": async ({ createSeededClient, helpers, harness }) => {
    const fixtures = buildSoloFixtures();
    const alice = await createSeededClient({ label: "alice-3", seed: fixtures.alice });
    const bob = await createSeededClient({ label: "bob-3", seed: fixtures.bob });
    await keepStateAcrossReopen(alice);
    const link = await createRequestLink(alice);
    await alice.page.close();
    await bob.page.goto(link.replace(/^https?:\/\/[^/]+/, new URL(bob.page.url()).origin));
    await holdConfirm(bob.page);
    await bob.page.waitForTimeout(3000);
    await helpers.reopenClient(alice, { hash: "friends" });
    return expectRecorded({ alice, opener: bob, openerId: BOB.publicKeyNpub, helpers, waitMs: harness.waitMs });
  },
};

module.exports = {
  name: "link-request",
  run: async (context) => {
    const only = process.env.LINK_CASE;
    const results = {};
    for (const [name, runCase] of Object.entries(CASES)) {
      if (only && only !== name) continue;
      console.log(`case: ${name}`);
      results[name] = await runCase(context);
    }
    return results;
  },
};
