/*
This module wraps and unwraps encrypted peer envelopes that carry application
messages between IOU clients. The envelope format keeps routing fields (id,
from, to) in plaintext so the signaling server can deliver messages to offline
peers without learning their contents, while the inner message — the original
peer message model — is encrypted to the recipient's public key.

Durable inner messages (transactions, friend requests, name changes, …) carry a
Tally *authorship proof* (TIP-6) rather than a bare signature. The proof is a
signed Nostr event embedded in the encrypted inner blob; it lets a recipient
verify messages authored by a third party that are forwarded during ledger
sync — transport encryption alone only proves "someone with the ECDH shared
secret produced this," which isn't enough once messages travel transitively.

Transport-only messages (sync_hello/sync_data, receipts, ping/pong) are NOT
durable ledger facts, so they carry no authorship proof and are not
authorship-verified — they are authenticated by the encrypted channel and
their security-critical contents (ledger entries inside a sync batch) carry
their own proofs.

After decryption, callers may trust the returned `inner` only after:
  1. The envelope's plaintext claims match the inner fields.
  2. For durable messages, the authorship proof verifies against `from_user_id`.

Encryption itself is delegated to the caller's KeyProvider, so this module
never touches raw key material. Version 3 encrypts with NIP-44 v2; version 2
used the provider's legacy AES-GCM path and is decrypted, never sent.
@category network
*/

import { isDurablePeerMessageType } from "./messages.js";
import {
  signTallyMessage,
  verifyTallyAuthorship,
  hasAuthorshipProof,
} from "./authorship.js";

export const PEER_ENVELOPE_TYPE = "peer_envelope";
// Current outbound version. v3 encrypts the inner blob with NIP-44 v2; v2 used
// AES-GCM. We still *decrypt* v2 on receipt to drain envelopes queued on the
// signaling server before peers upgraded — see `unwrapPeerEnvelope`.
export const PEER_ENVELOPE_VERSION = 3;
export const PEER_ENVELOPE_VERSION_AES = 2;

export const isPeerEnvelope = (value) => {
  return Boolean(value) && typeof value === "object" && value.type === PEER_ENVELOPE_TYPE;
};

// The semantic inner-message shape, minus transport-only adornments. The legacy
// top-level `signature` field is never emitted by current code.
const innerCoreFromMessage = (message) => ({
  id: message.id,
  type: message.type,
  from_user_id: message.from_user_id,
  to_user_id: message.to_user_id,
  created_at: message.created_at,
  payload: message.payload ?? {},
});

export const wrapPeerMessage = async (message, { keyProvider }) => {
  if (!message || typeof message !== "object") {
    throw new Error("Cannot wrap an empty peer message.");
  }
  if (!message.id || !message.from_user_id || !message.to_user_id) {
    throw new Error("Peer message is missing routing fields required for the envelope.");
  }
  if (!keyProvider) {
    throw new Error("A key provider is required to encrypt a peer envelope.");
  }

  const inner = innerCoreFromMessage(message);

  // Durable messages carry an authorship proof. Reuse the one attached at queue
  // time if present (so the outbox and ledger agree on the exact proof bytes);
  // otherwise produce one now via the key provider.
  if (isDurablePeerMessageType(message.type)) {
    inner.authorship = hasAuthorshipProof(message.authorship)
      ? message.authorship
      : await signTallyMessage(inner, keyProvider);
  }

  const ciphertext = await keyProvider.nip44Encrypt(
    message.to_user_id,
    JSON.stringify(inner)
  );

  return {
    type: PEER_ENVELOPE_TYPE,
    envelope_version: PEER_ENVELOPE_VERSION,
    id: message.id,
    from_user_id: message.from_user_id,
    to_user_id: message.to_user_id,
    ciphertext,
  };
};

export const unwrapPeerEnvelope = async (envelope, { keyProvider, expectedRecipientId }) => {
  if (!isPeerEnvelope(envelope)) {
    throw new Error("Value is not a peer envelope.");
  }
  if (!envelope.id || !envelope.from_user_id || !envelope.to_user_id || !envelope.ciphertext) {
    throw new Error("Peer envelope is missing required fields.");
  }
  if (expectedRecipientId && envelope.to_user_id !== expectedRecipientId) {
    throw new Error("Peer envelope is addressed to a different recipient.");
  }
  if (!keyProvider) {
    throw new Error("A key provider is required to decrypt a peer envelope.");
  }

  // Decrypt by transport version. v3 is NIP-44 v2; v2 is the legacy AES-GCM
  // path, kept only to drain envelopes that were already queued on the
  // signaling server before the sender upgraded. Anything else is unknown.
  // Treat a missing `envelope_version` as v2: pre-versioning envelopes had no
  // field and were always AES-GCM.
  const envelopeVersion = Number.isInteger(envelope.envelope_version)
    ? envelope.envelope_version
    : PEER_ENVELOPE_VERSION_AES;
  let plaintext;
  if (envelopeVersion === PEER_ENVELOPE_VERSION) {
    plaintext = await keyProvider.nip44Decrypt(
      envelope.from_user_id,
      envelope.ciphertext
    );
  } else if (envelopeVersion === PEER_ENVELOPE_VERSION_AES) {
    plaintext = await keyProvider.decryptFromPeer(
      envelope.from_user_id,
      envelope.ciphertext
    );
  } else {
    throw new Error(`Unsupported peer envelope version: ${envelopeVersion}`);
  }

  let inner;
  try {
    inner = JSON.parse(plaintext);
  } catch {
    throw new Error("Peer envelope plaintext is not valid JSON.");
  }
  if (!inner || typeof inner !== "object") {
    throw new Error("Peer envelope plaintext is not an object.");
  }

  // Cross-check the plaintext envelope claims against the authenticated inner
  // fields. The encrypted channel guarantees the inner fields were not tampered
  // with, so any mismatch means the plaintext envelope was modified in transit.
  if (inner.id !== envelope.id) {
    throw new Error("Peer envelope id does not match its inner message.");
  }
  if (inner.from_user_id !== envelope.from_user_id) {
    throw new Error("Peer envelope from_user_id does not match its inner message.");
  }
  if (inner.to_user_id !== envelope.to_user_id) {
    throw new Error("Peer envelope to_user_id does not match its inner message.");
  }

  // Verify authorship for durable messages. This is what lets us trust
  // forwarded messages later — transport encryption alone only proves the ECDH
  // peer produced the ciphertext; the authorship proof binds the content to its
  // original author. Transport-only messages skip this.
  if (isDurablePeerMessageType(inner.type)) {
    const authorshipValid = await verifyTallyAuthorship(inner);
    if (!authorshipValid) {
      throw new Error("Peer envelope inner authorship is invalid.");
    }
  }

  return inner;
};
