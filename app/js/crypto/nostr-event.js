/*
Minimal NIP-01 Nostr event helpers — id computation, signing, and verification.

Tally never publishes these events to a public relay (see TIP-6): they exist
only as *authorship proofs* embedded inside the encrypted peer-message payload.
But the proof must be a standard, signer-compatible Nostr event so external
signers (NIP-07/46/55) can produce it with their normal `sign_event` API.

The event id is the NIP-01 canonical hash: sha256 of the JSON array
  [0, pubkey, created_at, kind, tags, content]
and the signature is BIP-340 Schnorr over that 32-byte id. The local provider
signs here directly; external providers return an already-signed event that we
verify with the same `verifyNostrEvent`.
@category crypto
*/

import {
  schnorrSignHex,
  schnorrVerifyHex,
  sha256HexOfString,
} from "./secp256k1.js";

// Tally's private signing-event kind. Application-specific; never relayed.
export const TALLY_EVENT_KIND = 177700;

// NIP-01 id pre-image: a JSON array with a fixed field order. Only these six
// positions are hashed, so the order of keys on the event object is irrelevant.
const serializeForId = (event) =>
  JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);

export const computeEventId = async (event) => sha256HexOfString(serializeForId(event));

// Sign an unsigned event ({ kind, created_at, tags, content }) with a raw
// private key. Fills in `pubkey`, computes the id, and Schnorr-signs it.
export const signNostrEvent = async (unsignedEvent, { privateKeyHex, publicKeyHex }) => {
  const event = {
    pubkey: publicKeyHex,
    created_at: unsignedEvent.created_at,
    kind: unsignedEvent.kind,
    tags: unsignedEvent.tags,
    content: unsignedEvent.content,
  };
  const id = await computeEventId(event);
  const sig = schnorrSignHex(id, privateKeyHex);
  return { id, ...event, sig };
};

// Verify a full signed event: the id must match the recomputed hash and the
// signature must verify against the event's own pubkey. (Whether that pubkey is
// the *expected* author is checked one layer up, against the Tally message.)
export const verifyNostrEvent = async (event) => {
  if (!event || typeof event !== "object") return false;
  if (
    typeof event.id !== "string" ||
    typeof event.sig !== "string" ||
    typeof event.pubkey !== "string"
  ) {
    return false;
  }
  let expectedId;
  try {
    expectedId = await computeEventId(event);
  } catch {
    return false;
  }
  if (expectedId !== event.id) return false;
  return schnorrVerifyHex(event.sig, event.id, event.pubkey);
};
