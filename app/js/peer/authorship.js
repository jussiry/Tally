/*
Authorship proofs for durable Tally messages (TIP-6).

Every durable peer message / ledger entry carries an `authorship` proof that
binds its semantic fields (id, type, from, to, created_at, payload) to the
sender's Nostr key. Two schemes are accepted:

  tally-nostr-event-v1        — the proof is a signed Nostr event (kind 177700)
                                whose content embeds the message. Produced for
                                ALL new entries (local and external key users),
                                via the KeyProvider's standard `signEvent`.

  tally-canonical-schnorr-v1  — legacy: a raw Schnorr signature over the
                                canonical message digest. Verify-only, never
                                written by current code. Kept permanently so
                                pre-migration ledger entries still verify when a
                                peer re-sends them during sync.

This module owns both *producing* the new proof (`signTallyMessage`) and
*verifying* either scheme (`verifyTallyAuthorship`). The transport and ledger
layers call these instead of touching signatures directly.
@category network
*/

import { canonicalJsonForSigning } from "../crypto/canonical.js";
import { schnorrVerifyHex, sha256HexOfString } from "../crypto/secp256k1.js";
import { TALLY_EVENT_KIND, verifyNostrEvent } from "../crypto/nostr-event.js";
import { decodeNpubToHex } from "../utils/nostr-keys.js";

export const AUTHORSHIP_SCHEME_NOSTR_EVENT = "tally-nostr-event-v1";
export const AUTHORSHIP_SCHEME_LEGACY_SCHNORR = "tally-canonical-schnorr-v1";
export const TALLY_SIGNED_MESSAGE_SCHEMA = "tally.signed_message.v1";

const TALLY_TAG_VERSION = ["tally:v", "1"];
const TALLY_TAG_PURPOSE = ["tally:purpose", "inner_message"];

// The semantic core of a message — the fields covered by the authorship proof.
// `authorship` and the legacy `signature` field are deliberately excluded.
const messageCore = (message) => ({
  id: message?.id || "",
  type: message?.type || "",
  from_user_id: message?.from_user_id || "",
  to_user_id: message?.to_user_id || "",
  created_at: message?.created_at || message?.originated_at || "",
  payload: message?.payload ?? {},
});

// Resolve a from_user_id (npub or hex) to a lowercase x-only hex pubkey.
const toPublicKeyHex = (userId) => {
  if (typeof userId !== "string" || !userId) return "";
  try {
    return userId.startsWith("npub1") ? decodeNpubToHex(userId) : userId.toLowerCase();
  } catch {
    return "";
  }
};

// The unsigned Nostr event handed to a signer for a durable message. The event
// `created_at` is derived from the message timestamp so it stays stable (we
// never re-sign), falling back to "now" only if the timestamp is unparseable.
export const buildUnsignedTallyEvent = (message) => {
  const parsedMs = new Date(message?.created_at || "").getTime();
  const createdAtSeconds = Number.isFinite(parsedMs)
    ? Math.floor(parsedMs / 1000)
    : Math.floor(Date.now() / 1000);
  return {
    kind: TALLY_EVENT_KIND,
    created_at: createdAtSeconds,
    tags: [TALLY_TAG_VERSION, TALLY_TAG_PURPOSE],
    content: JSON.stringify({
      schema: TALLY_SIGNED_MESSAGE_SCHEMA,
      message: messageCore(message),
    }),
  };
};

// Produce a `tally-nostr-event-v1` authorship proof for a durable message by
// asking the key provider to sign the Tally event.
export const signTallyMessage = async (message, keyProvider) => {
  if (!keyProvider) {
    throw new Error("A key provider is required to sign a Tally message.");
  }
  const event = await keyProvider.signEvent(buildUnsignedTallyEvent(message));
  return { scheme: AUTHORSHIP_SCHEME_NOSTR_EVENT, event };
};

// True when `value` is a usable authorship proof object (has a scheme string).
export const hasAuthorshipProof = (value) =>
  Boolean(value) && typeof value === "object" && typeof value.scheme === "string" && value.scheme;

const hasTag = (tags, key, val) =>
  Array.isArray(tags) && tags.some((t) => Array.isArray(t) && t[0] === key && t[1] === val);

// Verify rules 6–11 of TIP-6 for the signed-event scheme.
const verifyNostrEventAuthorship = async (message, event) => {
  if (!event || typeof event !== "object") return false;
  if (event.kind !== TALLY_EVENT_KIND) return false;
  if (!hasTag(event.tags, "tally:v", "1")) return false;
  if (!hasTag(event.tags, "tally:purpose", "inner_message")) return false;

  // Event id correct + signature valid for event.pubkey.
  if (!(await verifyNostrEvent(event))) return false;

  // event.pubkey must be the message's claimed author.
  const expectedPubkey = toPublicKeyHex(message?.from_user_id);
  if (!expectedPubkey || event.pubkey.toLowerCase() !== expectedPubkey) return false;

  // content schema + the embedded message must match the outer message exactly.
  let parsed;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return false;
  }
  if (!parsed || parsed.schema !== TALLY_SIGNED_MESSAGE_SCHEMA) return false;
  return canonicalJsonForSigning(parsed.message) === canonicalJsonForSigning(message);
};

// Verify the legacy raw-Schnorr signature over the canonical message digest.
const verifyLegacySignature = async (message, signature) => {
  if (typeof signature !== "string" || !signature) return false;
  const publicKeyHex = toPublicKeyHex(message?.from_user_id);
  if (!publicKeyHex) return false;
  const digestHex = await sha256HexOfString(canonicalJsonForSigning(message));
  return schnorrVerifyHex(signature, digestHex, publicKeyHex);
};

// Verify whichever authorship scheme a durable message/entry carries. Falls
// back to a bare top-level `signature` (pre-migration shape) so entries that
// have not yet been normalized still verify.
export const verifyTallyAuthorship = async (message) => {
  if (!message || typeof message !== "object") return false;

  const authorship = message.authorship;
  if (hasAuthorshipProof(authorship)) {
    if (authorship.scheme === AUTHORSHIP_SCHEME_NOSTR_EVENT) {
      return verifyNostrEventAuthorship(message, authorship.event);
    }
    if (authorship.scheme === AUTHORSHIP_SCHEME_LEGACY_SCHNORR) {
      return verifyLegacySignature(message, authorship.signature);
    }
    return false;
  }

  // No authorship object — accept a legacy top-level signature.
  return verifyLegacySignature(message, message.signature);
};
