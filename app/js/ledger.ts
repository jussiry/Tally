/*
Central module for the local ledger — the append-only log of every peer
message the user has produced or received.

Responsibilities live here rather than scattered across app-state.js,
state-utils.js, and the realtime module so the invariants of the ledger
(canonical entry shape, signature coverage, per-peer slicing, sync merge
semantics) can be reasoned about in one place.

Domain callers still decide *when* to append (a transaction, a friend
accept, a trust-limit nudge) and supply the payload — this module only
owns how entries are shaped, how they're filtered for sync, and how
untrusted entries are vetted before they enter the local log.
@category data
*/

import {
  createLedgerEntryModel,
  normalizeCurrencyAmount,
  type AuthorshipProof,
  type LedgerEntryModel,
  type PeerMessageModel,
  type RootState,
} from "./models/data-model.js";
import { verifyTallyAuthorship } from "./peer/authorship.js";
import {
  PEER_MESSAGE_TYPE_FRIEND_ACCEPT,
  PEER_MESSAGE_TYPE_FRIEND_REQUEST,
  PEER_MESSAGE_TYPE_NOTIFICATION_PREFS,
  PEER_MESSAGE_TYPE_PAYMENT_REQUEST,
  PEER_MESSAGE_TYPE_PAYMENT_REQUEST_CANCEL,
  PEER_MESSAGE_TYPE_PAYMENT_REQUEST_RESPONSE,
  PEER_MESSAGE_TYPE_TRANSACTION_CREATED,
  PEER_MESSAGE_TYPE_TRUST_LIMIT_SUGGESTION,
} from "./peer/messages.js";
import { createId } from "./state-utils.js";

// ---------------------------------------------------------------------------
// Local appends
// ---------------------------------------------------------------------------

export interface AppendLedgerEntryOptions {
  id?: string;
  type?: string;
  fromUserId?: string;
  toUserId?: string;
  payload?: Record<string, unknown>;
  signature?: string;
  authorship?: AuthorshipProof | null;
  originatedAt?: string;
}

// Primitive append. Callers pass the domain fields; this normalizes through
// the model factory so shape drift can only happen in one place. The local
// `timestamp` is set here — peer-asserted timing lives in `originated_at`.
export const appendLedgerEntry = (
  state: RootState,
  {
    id,
    type,
    fromUserId,
    toUserId,
    payload = {},
    signature = "",
    authorship = null,
    originatedAt = "",
  }: AppendLedgerEntryOptions = {}
): LedgerEntryModel => {
  state.ledger = Array.isArray(state.ledger) ? state.ledger : [];
  const entry = createLedgerEntryModel({
    id: id || createId("ledger"),
    timestamp: new Date().toISOString(),
    type,
    from_user_id: fromUserId || "",
    to_user_id: toUserId || "",
    signature,
    authorship,
    originated_at: originatedAt,
    payload,
  });
  state.ledger.unshift(entry);
  return entry;
};

// Convenience wrapper: mirror an outbound or verified inbound peer message
// into the ledger. The message's `created_at` becomes `originated_at` so the
// Schnorr digest remains reproducible from the stored entry. Returns the
// appended entry so callers can derive state directly from the ledger
// representation (the same shape replay and sync will see).
export const appendLedgerEntryFromMessage = (
  state: RootState,
  message: PeerMessageModel | null | undefined
): LedgerEntryModel | null => {
  if (!message) return null;
  return appendLedgerEntry(state, {
    id: message.id,
    type: message.type,
    fromUserId: message.from_user_id,
    toUserId: message.to_user_id,
    payload: message.payload,
    signature: message.signature,
    authorship: message.authorship,
    originatedAt: message.created_at,
  });
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

// Entries that belong to the conversation between `myId` and `peerId` — the
// slice we offer during sync. Entries involving third parties never flow to
// this peer.
export const getLedgerEntriesForPeer = (
  ledger: LedgerEntryModel[] | null | undefined,
  myId: string,
  peerId: string
): LedgerEntryModel[] => {
  if (!Array.isArray(ledger)) return [];
  return ledger.filter(
    (entry) =>
      (entry.from_user_id === myId && entry.to_user_id === peerId) ||
      (entry.from_user_id === peerId && entry.to_user_id === myId)
  );
};

// The full ledger as-is — used for same-user (device-to-device) sync where
// every entry is in-scope because every entry was authored or received by
// *this* user regardless of which friend it concerned.
export const getAllLedgerEntries = (
  ledger: LedgerEntryModel[] | null | undefined
): LedgerEntryModel[] => {
  if (!Array.isArray(ledger)) return [];
  return ledger.slice();
};

// ---------------------------------------------------------------------------
// Derived queries
// ---------------------------------------------------------------------------

export interface OpenPaymentRequest {
  /** The request's `request_id` — what a response or cancel refers to. */
  id: string;
  amount_eur: number;
  note: string;
  /** `true` when the friend asked us; `false` when we asked them. */
  is_incoming: boolean;
  created_at: string;
}

const requestIdOf = (entry: LedgerEntryModel): string =>
  typeof entry.payload?.request_id === "string" ? entry.payload.request_id.trim() : "";

// Payment requests are not stored on the friend record — they are read off the
// ledger. A request stays open until the ledger holds a closing entry for its
// request_id: a response authored by the recipient, or a cancel authored by the
// requester. Any number can be open at once, and the result does not depend on
// arrival order (sync can deliver a response before the request it answers).
//
// Keyed by the friend's user id; each list is newest-first, like the ledger.
export const getOpenPaymentRequests = (
  ledger: LedgerEntryModel[] | null | undefined,
  myId: string
): Map<string, OpenPaymentRequest[]> => {
  const open = new Map<string, OpenPaymentRequest[]>();
  if (!Array.isArray(ledger) || !myId) return open;

  // `requester|recipient|request_id` for every request something has closed.
  const closed = new Set<string>();
  for (const entry of ledger) {
    const requestId = requestIdOf(entry);
    if (!requestId) continue;
    if (entry.type === PEER_MESSAGE_TYPE_PAYMENT_REQUEST_RESPONSE) {
      closed.add(`${entry.to_user_id}|${entry.from_user_id}|${requestId}`);
    } else if (entry.type === PEER_MESSAGE_TYPE_PAYMENT_REQUEST_CANCEL) {
      closed.add(`${entry.from_user_id}|${entry.to_user_id}|${requestId}`);
    }
  }

  for (const entry of ledger) {
    if (entry.type !== PEER_MESSAGE_TYPE_PAYMENT_REQUEST) continue;
    const isIncoming = entry.to_user_id === myId;
    if (!isIncoming && entry.from_user_id !== myId) continue;
    // Requests predating request_id fall back to the message id, as the
    // inbound handler always has.
    const requestId = requestIdOf(entry) || entry.id;
    if (closed.has(`${entry.from_user_id}|${entry.to_user_id}|${requestId}`)) continue;
    const amount = normalizeCurrencyAmount(entry.payload?.amount_eur, NaN);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const friendId = isIncoming ? entry.from_user_id : entry.to_user_id;
    const list = open.get(friendId) ?? [];
    list.push({
      id: requestId,
      amount_eur: amount,
      note: typeof entry.payload?.note === "string" ? entry.payload.note.trim() : "",
      is_incoming: isIncoming,
      created_at: entry.originated_at || entry.timestamp,
    });
    open.set(friendId, list);
  }
  return open;
};

// ---------------------------------------------------------------------------
// Signature verification for untrusted entries
// ---------------------------------------------------------------------------

// Reconstructs the original inner-message shape from a stored ledger entry and
// runs the same authorship verification that `peer-envelope` uses for live
// messages. AES-GCM on the sync envelope only proves the *transport* peer
// produced the batch — for forwarded or third-party entries we also need this
// authorship check to trust who actually authored the entry.
//
// Accepts either a TIP-006 authorship proof (`tally-nostr-event-v1` /
// `tally-canonical-schnorr-v1`) or, for pre-migration entries, a bare
// top-level `signature` — `verifyTallyAuthorship` handles both.
export const verifyLedgerEntryAuthorship = async (
  entry: LedgerEntryModel | null | undefined
): Promise<boolean> => {
  if (!entry || typeof entry !== "object") return false;
  const innerShape = {
    id: entry.id,
    type: entry.type,
    from_user_id: entry.from_user_id,
    to_user_id: entry.to_user_id,
    created_at: entry.originated_at || entry.timestamp || "",
    payload: entry.payload || {},
    signature: entry.signature,
    authorship: entry.authorship || null,
  };
  return verifyTallyAuthorship(innerShape);
};

// ---------------------------------------------------------------------------
// Value validation for untrusted entries
// ---------------------------------------------------------------------------

// A valid signature proves who wrote an entry, not that its values make sense.
// These rules reject entries whose money values could never have come from a
// command: a non-positive IOU or payment request, or a negative trust limit.
// They are state-independent (no friend lookup), so they can run before an
// entry is stored. Types without a money value always pass.
const isPositiveAmount = (value: unknown): boolean =>
  normalizeCurrencyAmount(value, NaN) > 0;

const isNonNegativeAmount = (value: unknown): boolean =>
  normalizeCurrencyAmount(value, NaN) >= 0;

// Optional limits: commands sometimes omit them, and handlers then leave the
// stored limit untouched.
const isAbsentOrNonNegativeAmount = (value: unknown): boolean =>
  value === undefined || value === null || isNonNegativeAmount(value);

const VALUE_RULES: Record<string, (payload: Record<string, unknown>) => boolean> = {
  [PEER_MESSAGE_TYPE_TRANSACTION_CREATED]: (p) => isPositiveAmount(p.amount_eur),
  [PEER_MESSAGE_TYPE_PAYMENT_REQUEST]: (p) => isPositiveAmount(p.amount_eur),
  [PEER_MESSAGE_TYPE_TRUST_LIMIT_SUGGESTION]: (p) => isNonNegativeAmount(p.credit_limit_eur),
  [PEER_MESSAGE_TYPE_FRIEND_ACCEPT]: (p) => isAbsentOrNonNegativeAmount(p.trust_credit_limit_eur),
  [PEER_MESSAGE_TYPE_FRIEND_REQUEST]: (p) =>
    isAbsentOrNonNegativeAmount(p.suggested_credit_limit_eur),
  // Not a money value, but readers trust the shape: a list of type names.
  [PEER_MESSAGE_TYPE_NOTIFICATION_PREFS]: (p) =>
    Array.isArray(p.enabled) && p.enabled.every((type) => typeof type === "string"),
};

export const hasValidLedgerValues = (
  entry: Pick<LedgerEntryModel, "type" | "payload"> | null | undefined
): boolean => {
  if (!entry) return false;
  const rule = VALUE_RULES[entry.type];
  return !rule || rule((entry.payload || {}) as Record<string, unknown>);
};

// ---------------------------------------------------------------------------
// Sync merge
// ---------------------------------------------------------------------------

// Merge a batch of entries received from a sync peer into the local ledger.
// Entries without a valid Schnorr signature by their claimed `from_user_id`
// are rejected — this is what blocks a compromised peer from backfilling
// forged history during recovery. Entries with impossible money values
// (see hasValidLedgerValues) are rejected too, so they never reach storage.
// Returns the count actually added.
//
// Does not persist; callers own persistence so a single save can cover
// whatever else changed in the same tick.
export const mergeSyncedLedgerEntries = async (
  state: RootState,
  entries: unknown
): Promise<number> => {
  if (!Array.isArray(entries) || entries.length === 0) return 0;

  state.ledger = Array.isArray(state.ledger) ? state.ledger : [];
  const existingIds = new Set(state.ledger.map((entry) => entry.id));
  let added = 0;

  for (const entry of entries) {
    const normalized = createLedgerEntryModel(entry);
    if (!normalized.id || existingIds.has(normalized.id)) continue;
    if (!hasValidLedgerValues(normalized)) {
      console.warn("[Ledger] Rejected synced entry with invalid values:", normalized.id);
      continue;
    }
    const authorshipValid = await verifyLedgerEntryAuthorship(normalized);
    if (!authorshipValid) {
      console.warn(
        "[Ledger] Rejected synced entry with missing or invalid authorship:",
        normalized.id
      );
      continue;
    }
    state.ledger.unshift(normalized);
    existingIds.add(normalized.id);
    added += 1;
  }

  if (added > 0) {
    state.ledger.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  }
  return added;
};
