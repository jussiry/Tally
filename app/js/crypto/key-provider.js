/*
The KeyProvider abstraction — the single seam through which all signing and
peer encryption flows.

Today the only implementation is the *local* provider, which holds the user's
secp256k1 private key in memory and performs operations directly (canonical
Schnorr signatures + AES-GCM peer encryption, exactly as before). The point of
funnelling every call site through this interface is forward-looking: once the
private key can live outside the app (a NIP-07 browser extension, a NIP-46
remote signer), those providers slot in here without the rest of the codebase
ever touching raw key material again.

The interface a provider exposes:

  type                              "local" | "nip07" | "nip46" | ...
  getPublicKeyHex()        -> hex   the provider's own x-only public key
  signCanonicalDigest(hex) -> hex   Schnorr signature over a 32-byte digest
  signEvent(unsignedEvent) -> event  full signed Nostr event (authorship)
  encryptForPeer(peerHex, plaintext)   -> ciphertext string  (AES-GCM, envelope v2)
  decryptFromPeer(peerHex, ciphertext) -> plaintext string   (AES-GCM, envelope v2)
  nip44Encrypt(peerHex, plaintext)     -> ciphertext string  (NIP-44 v2, envelope v3)
  nip44Decrypt(peerHex, ciphertext)    -> plaintext string   (NIP-44 v2, envelope v3)

All methods are async-friendly (return values may be promises) so remote
providers that round-trip to an extension or signer fit the same shape. Layer 1
keeps behaviour identical to the pre-abstraction code — this is a pure
plumbing change.
@category crypto
*/

import {
  encryptForPeer as aesEncryptForPeer,
  decryptFromPeer as aesDecryptFromPeer,
} from "./peer-crypto.js";
import { schnorrSignHex, derivePublicKeyHex } from "./secp256k1.js";
import { signNostrEvent } from "./nostr-event.js";
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from "./nip44.js";
import { normalizePublicKeyHex } from "../utils/nostr-keys.js";
import { SignerType } from "../models/data-model.js";

// A provider backed by an in-memory private key. This is the original
// behaviour, just behind the interface: canonical Schnorr signing and AES-GCM
// peer encryption, both keyed by the local secret.
/** @param {{ privateKeyHex?: string, publicKeyHex?: string }} [keys] */
export const createLocalKeyProvider = ({ privateKeyHex, publicKeyHex } = {}) => {
  if (!privateKeyHex) {
    throw new Error("A local key provider requires a private key.");
  }
  // Derive the canonical x-only public key from the secret unless the caller
  // supplied a hex one. Deriving is safest — `state.user.id` may be an npub.
  const resolvedPublicKeyHex = publicKeyHex || derivePublicKeyHex(privateKeyHex);

  return {
    type: SignerType.LOCAL,
    getPublicKeyHex: () => resolvedPublicKeyHex,
    signCanonicalDigest: async (digestHex) => schnorrSignHex(digestHex, privateKeyHex),
    // Sign a Tally authorship event ({ kind, created_at, tags, content }) with
    // the local key, returning the full signed Nostr event.
    signEvent: (unsignedEvent) =>
      signNostrEvent(unsignedEvent, { privateKeyHex, publicKeyHex: resolvedPublicKeyHex }),
    encryptForPeer: (peerPublicKeyHex, plaintext) =>
      aesEncryptForPeer(plaintext, { privateKeyHex, peerPublicKey: peerPublicKeyHex }),
    decryptFromPeer: (peerPublicKeyHex, ciphertext) =>
      aesDecryptFromPeer(ciphertext, { privateKeyHex, peerPublicKey: peerPublicKeyHex }),
    // NIP-44 v2 peer encryption — the envelope v3 transport. The peer id may be
    // an npub (`user.id`), so normalize to x-only hex before deriving the
    // conversation key. Synchronous primitives wrapped in a resolved promise so
    // the interface stays uniformly async-friendly for remote providers.
    nip44Encrypt: async (peerPublicKeyHex, plaintext) =>
      nip44Encrypt(plaintext, {
        privateKeyHex,
        peerPublicKeyHex: normalizePublicKeyHex(peerPublicKeyHex),
      }),
    nip44Decrypt: async (peerPublicKeyHex, ciphertext) =>
      nip44Decrypt(ciphertext, {
        privateKeyHex,
        peerPublicKeyHex: normalizePublicKeyHex(peerPublicKeyHex),
      }),
  };
};

// True when a NIP-07 signer extension (window.nostr) is present. Used by the
// onboarding flow to decide whether to offer the external-signer option, and as
// a guard before building a nip07 provider.
export const isNip07Available = () =>
  typeof window !== "undefined" &&
  Boolean(window.nostr) &&
  typeof window.nostr.signEvent === "function";

// A provider backed by a NIP-07 browser extension (window.nostr). The private
// key never enters the app: signing and NIP-44 encryption round-trip to the
// extension. The user's own public key is captured at account creation and
// passed back in here so `getPublicKeyHex` stays synchronous.
//
// Only the operations TIP-006 actually needs are supported: signEvent (Nostr
// authorship proofs) and NIP-44 v2 peer encryption. The legacy AES-GCM
// transport (envelope v2) and bare canonical-digest signing have no NIP-07
// equivalent, so they throw — a NIP-07 account never produced v2 envelopes and
// always signs via events.
/** @param {{ publicKeyHex?: string }} [keys] */
export const createNip07KeyProvider = ({ publicKeyHex } = {}) => {
  if (!publicKeyHex) {
    throw new Error("A NIP-07 key provider requires the user's public key.");
  }
  const nostr = () => {
    if (!isNip07Available()) {
      throw new Error("No NIP-07 signer extension is available.");
    }
    return window.nostr;
  };

  return {
    type: SignerType.NIP07,
    getPublicKeyHex: () => publicKeyHex,
    signCanonicalDigest: async () => {
      throw new Error("A NIP-07 signer cannot sign a bare digest; use signEvent.");
    },
    // The extension fills in pubkey/id/sig and returns the complete signed event.
    signEvent: async (unsignedEvent) => nostr().signEvent(unsignedEvent),
    encryptForPeer: async () => {
      throw new Error("A NIP-07 signer does not support legacy AES-GCM envelopes.");
    },
    decryptFromPeer: async () => {
      throw new Error("A NIP-07 signer does not support legacy AES-GCM envelopes.");
    },
    nip44Encrypt: async (peerPublicKeyHex, plaintext) =>
      nostr().nip44.encrypt(normalizePublicKeyHex(peerPublicKeyHex), plaintext),
    nip44Decrypt: async (peerPublicKeyHex, ciphertext) =>
      nostr().nip44.decrypt(normalizePublicKeyHex(peerPublicKeyHex), ciphertext),
  };
};

// Build the provider that matches the persisted user. Returns null when there
// is no usable key material (no user, or a NIP-07 account whose extension is
// not currently available — callers treat null as "cannot sign/encrypt now").
export const createKeyProviderFromState = (state) => {
  const user = state?.user;
  if (!user) return null;

  if (user.signer_type === SignerType.NIP07) {
    if (!user.public_key_hex || !isNip07Available()) {
      return null;
    }
    return createNip07KeyProvider({ publicKeyHex: user.public_key_hex });
  }

  const privateKeyHex = user.private_key_hex || "";
  if (!privateKeyHex) {
    return null;
  }
  return createLocalKeyProvider({ privateKeyHex });
};
