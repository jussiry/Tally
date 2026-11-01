/*
Dev-only seed helper. When the URL contains `?seed`, this module writes a
preset app state into IndexedDB so the preview browser can skip the welcome
flow and start with realistic friends, transactions, and pending items.

Usage:
  http://localhost:3000/?seed=alice   — seed (or re-seed) as Alice
  http://localhost:3000/?seed=bob     — seed (or re-seed) as Bob
  http://localhost:3000/?seed=carol   — seed (or re-seed) as Carol
  http://localhost:3000/?seed=reset   — alias for ?seed=alice (backward compat)

All named seeds always force-reset so you always get a clean state for that
user. The param is stripped from the URL after seeding so reloads behave
normally.

Alice is the default preview browser user. Bob and Carol are driven by the
peer-helper (tests/peer-helper/) to test multi-user interactions.
@category util
*/

import { DATA_MODEL_VERSION, createLedgerEntryModel } from "../models/data-model.js";
import { MessageType } from "../peer/messages.js";
import { FriendshipStatus } from "../utils/friendships.js";
import { clearAppState, loadAppState, saveAppState } from "../storage/indexeddb.js";

const SEED_PARAM = "seed";

// ---------------------------------------------------------------------------
// Fixed keypairs — deterministic across restarts so peer messages actually
// route correctly when Alice (preview) and Bob/Carol (peer-helper) connect.
// ---------------------------------------------------------------------------

const ALICE = {
  publicKeyNpub: "npub10c0r3r9u0qfyk5q58r5zm73cgj7p23erlmyyppq2wj26quksp45s5xf43v",
  publicKeyHex: "7e1e388cbc78124b501438e82dfa3844bc154723fec840840a7495a072d00d69",
  privateKeyNsec: "nsec1s9ervmd04ueyp7km3qphq3skaejtsuf546kw47f8yp96mz6qmmxqvpcdde",
  privateKeyHex: "8172366dafaf3240fadb8803704616ee64b87134aeaceaf927204bad8b40decc",
  name: "Alice",
};

const BOB = {
  publicKeyNpub: "npub1l7vvz68z2405e5zfz85z76ecn942vmevzevgcmapdqyd4zlqvmns7zhjhj",
  publicKeyHex: "ff98c168e2555f4cd04911e82f6b38996aa66f2c16588c6fa16808da8be066e7",
  privateKeyNsec: "nsec1rewgmu4zkssflszcz5q230sc5d349kzcrjqg44pdq8nkaudjk9lqhkjyvd",
  privateKeyHex: "1e5c8df2a2b4209fc0581500a8be18a36352d8581c808ad42d01e76ef1b2b17e",
  name: "Bob",
};

const CAROL = {
  publicKeyNpub: "npub1n9890qe5nvt4n3hp6pvdruela4xmtdjda6wqac3ayl2r627feqssxm6cvp",
  publicKeyHex: "994e5783349b1759c6e1d058d1f33fed4db5b64dee9c0ee23d27d43d2bc9c821",
  privateKeyNsec: "nsec1up74jyx7us6ad3efxqejxnx43jhq665ls65k7ku7me2c374dp9gqj28uck",
  privateKeyHex: "e07d5910dee435d6c7293033234cd58cae0d6a9f86a96f5b9ede5588faad0950",
  name: "Carol",
};

// ---------------------------------------------------------------------------
// State builders
// ---------------------------------------------------------------------------

// An open payment request from Bob to Alice. Open requests are derived from
// the ledger, so the fixture is a ledger entry. It is deliberately UNSIGNED:
// a genuine authorship proof would let self-mesh sync carry it to every other
// device signed in as Alice. Unsigned, any peer or device rejects it during
// sync verification, so — like all seed data — it stays on this device.
const buildBobPaymentRequestEntry = (createdAt) =>
  createLedgerEntryModel({
    id: "peer-seed-pr-1",
    type: MessageType.PAYMENT_REQUEST,
    from_user_id: BOB.publicKeyNpub,
    to_user_id: ALICE.publicKeyNpub,
    timestamp: createdAt,
    originated_at: createdAt,
    payload: { request_id: "pr-seed-1", amount_eur: 12, note: "Coffee round" },
  });

const buildAliceState = () => {
  const now = new Date();
  const iso = (d) => new Date(now.getTime() - d * 86400000).toISOString();
  const date = (d) => iso(d).slice(0, 10);

  return {
    model_version: DATA_MODEL_VERSION,
    user: {
      id: ALICE.publicKeyNpub,
      name: ALICE.name,
      public_key: ALICE.publicKeyNpub,
      public_key_hex: ALICE.publicKeyHex,
      private_key: ALICE.privateKeyNsec,
      private_key_hex: ALICE.privateKeyHex,
      friends: [
        {
          person_id: BOB.publicKeyNpub,
          person_name: BOB.name,
          friendship_status: FriendshipStatus.ACCEPTED,
          debt_eur: 42,
          trust_credit_limit_eur: 200,
          recent_transactions: [
            { id: "tx-seed-4", date: date(2), amount_eur: 42, note: "Groceries" },
          ],
          last_synced_at: iso(1),
        },
        {
          person_id: CAROL.publicKeyNpub,
          person_name: CAROL.name,
          friendship_status: FriendshipStatus.PENDING_INCOMING,
          debt_eur: 0,
          trust_credit_limit_eur: 0,
          recent_transactions: [],
          last_synced_at: "",
        },
      ],
    },
    contacts: {
      [BOB.publicKeyNpub]: { id: BOB.publicKeyNpub, public_key: BOB.publicKeyNpub, public_key_hex: BOB.publicKeyHex, name: BOB.name },
      [CAROL.publicKeyNpub]: { id: CAROL.publicKeyNpub, public_key: CAROL.publicKeyNpub, public_key_hex: CAROL.publicKeyHex, name: CAROL.name },
    },
    ledger: [buildBobPaymentRequestEntry(iso(0))],
    outbox: [],
    processed_peer_message_ids: [],
  };
};

const buildBobState = () => {
  const now = new Date();
  const iso = (d) => new Date(now.getTime() - d * 86400000).toISOString();
  const date = (d) => iso(d).slice(0, 10);

  return {
    model_version: DATA_MODEL_VERSION,
    user: {
      id: BOB.publicKeyNpub,
      name: BOB.name,
      public_key: BOB.publicKeyNpub,
      public_key_hex: BOB.publicKeyHex,
      private_key: BOB.privateKeyNsec,
      private_key_hex: BOB.privateKeyHex,
      friends: [
        {
          person_id: ALICE.publicKeyNpub,
          person_name: ALICE.name,
          friendship_status: FriendshipStatus.ACCEPTED,
          debt_eur: -42,
          trust_credit_limit_eur: 200,
          recent_transactions: [
            { id: "tx-seed-4", date: date(2), amount_eur: -42, note: "Groceries" },
          ],
          last_synced_at: iso(1),
        },
        {
          person_id: CAROL.publicKeyNpub,
          person_name: CAROL.name,
          friendship_status: FriendshipStatus.ACCEPTED,
          debt_eur: 0,
          trust_credit_limit_eur: 100,
          recent_transactions: [],
          last_synced_at: iso(3),
        },
      ],
    },
    contacts: {
      [ALICE.publicKeyNpub]: { id: ALICE.publicKeyNpub, public_key: ALICE.publicKeyNpub, public_key_hex: ALICE.publicKeyHex, name: ALICE.name },
      [CAROL.publicKeyNpub]: { id: CAROL.publicKeyNpub, public_key: CAROL.publicKeyNpub, public_key_hex: CAROL.publicKeyHex, name: CAROL.name },
    },
    ledger: [],
    outbox: [],
    processed_peer_message_ids: [],
  };
};

const buildCarolState = () => {
  const now = new Date();
  const iso = (d) => new Date(now.getTime() - d * 86400000).toISOString();

  return {
    model_version: DATA_MODEL_VERSION,
    user: {
      id: CAROL.publicKeyNpub,
      name: CAROL.name,
      public_key: CAROL.publicKeyNpub,
      public_key_hex: CAROL.publicKeyHex,
      private_key: CAROL.privateKeyNsec,
      private_key_hex: CAROL.privateKeyHex,
      friends: [
        {
          person_id: ALICE.publicKeyNpub,
          person_name: ALICE.name,
          friendship_status: FriendshipStatus.PENDING_OUTGOING,
          debt_eur: 0,
          trust_credit_limit_eur: 0,
          recent_transactions: [],
          last_synced_at: "",
        },
        {
          person_id: BOB.publicKeyNpub,
          person_name: BOB.name,
          friendship_status: FriendshipStatus.ACCEPTED,
          debt_eur: 0,
          trust_credit_limit_eur: 100,
          recent_transactions: [],
          last_synced_at: iso(3),
        },
      ],
    },
    contacts: {
      [ALICE.publicKeyNpub]: { id: ALICE.publicKeyNpub, public_key: ALICE.publicKeyNpub, public_key_hex: ALICE.publicKeyHex, name: ALICE.name },
      [BOB.publicKeyNpub]: { id: BOB.publicKeyNpub, public_key: BOB.publicKeyNpub, public_key_hex: BOB.publicKeyHex, name: BOB.name },
    },
    ledger: [],
    outbox: [],
    processed_peer_message_ids: [],
  };
};

const SEED_BUILDERS = {
  alice: buildAliceState,
  bob: buildBobState,
  carol: buildCarolState,
};

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const stripParam = (name) => {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(name)) return;
  url.searchParams.delete(name);
  window.history.replaceState(null, "", url.toString() + window.location.hash);
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const applyDevSeedIfRequested = async () => {
  // Test/harness hook: an init-script may inject a full app state on
  // window.__IOU_SEED_STATE so the app boots directly into that state
  // without going through the welcome flow.
  if (window.__IOU_SEED_STATE && typeof window.__IOU_SEED_STATE === "object") {
    try {
      await clearAppState();
      await saveAppState(window.__IOU_SEED_STATE);
    } catch {
      // best-effort
    }
    try {
      delete window.__IOU_SEED_STATE;
    } catch {
      window.__IOU_SEED_STATE = null;
    }
    return;
  }

  const params = new URLSearchParams(window.location.search);

  // ?removeUser — clear state so the next ?seed=<name> can apply
  if (params.has("removeUser")) {
    try {
      await clearAppState();
    } catch {
      // best-effort
    }
    stripParam("removeUser");
    return;
  }

  if (!params.has(SEED_PARAM)) return;

  const mode = params.get(SEED_PARAM);
  // "reset" is a backward-compat alias for "alice"
  const userName = mode === "reset" || mode === "" || mode === null ? "alice" : mode.toLowerCase();
  const builder = SEED_BUILDERS[userName];

  if (!builder) {
    // Unknown seed name — strip param and do nothing
    stripParam(SEED_PARAM);
    return;
  }

  // Only seed if no user exists — the preview browser starts empty so this
  // is the normal case. Use ?removeUser first if you need to switch users.
  try {
    const existing = await loadAppState();
    if (existing && existing.user) {
      stripParam(SEED_PARAM);
      return;
    }
    await saveAppState(builder());
  } catch {
    // seeding is best-effort; fall through to normal flow
  }

  stripParam(SEED_PARAM);
};
