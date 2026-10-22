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
  createTransactionModel,
  normalizeCurrencyAmount,
  type AuthorshipProof,
  type LedgerEntryModel,
  type PeerMessageModel,
  type RootState,
  type TransactionModel,
} from "./models/data-model.js";
import { verifyTallyAuthorship } from "./peer/authorship.js";
import {
  PEER_MESSAGE_TYPE_FRIEND_ACCEPT,
  PEER_MESSAGE_TYPE_FRIEND_REQUEST,
  PEER_MESSAGE_TYPE_FRIENDSHIP_DEFAULT,
  PEER_MESSAGE_TYPE_HISTORY_DELETED,
  PEER_MESSAGE_TYPE_NOTIFICATION_PREFS,
  PEER_MESSAGE_TYPE_PAYMENT_REQUEST,
  PEER_MESSAGE_TYPE_PAYMENT_REQUEST_CANCEL,
  PEER_MESSAGE_TYPE_PAYMENT_REQUEST_RESPONSE,
  PEER_MESSAGE_TYPE_REACTIVATION_REQUEST,
  PEER_MESSAGE_TYPE_REACTIVATION_RESPONSE,
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

const originOf = (entry: LedgerEntryModel): string => entry.originated_at || entry.timestamp || "";

// The friend an entry concerns, from `myId`'s point of view ("" for entries
// that don't involve exactly one other user).
const counterpartOf = (entry: LedgerEntryModel, myId: string): string => {
  if (entry.from_user_id === myId && entry.to_user_id !== myId) return entry.to_user_id;
  if (entry.to_user_id === myId && entry.from_user_id !== myId) return entry.from_user_id;
  return "";
};

export interface FriendshipDefault {
  /** `true` when this user defaulted; `false` when the friend did. */
  is_mine: boolean;
  note: string;
  /** The tally at default time, from the author's side (+ = friend owed the author). */
  tally_eur: number;
  created_at: string;
}

// The latest friendship_default between this user and each friend, either
// direction. The friend page shows it while the friendship is disabled.
export const getLatestFriendshipDefaults = (
  ledger: LedgerEntryModel[] | null | undefined,
  myId: string
): Map<string, FriendshipDefault> => {
  const latest = new Map<string, FriendshipDefault>();
  if (!Array.isArray(ledger) || !myId) return latest;
  for (const entry of ledger) {
    if (entry.type !== PEER_MESSAGE_TYPE_FRIENDSHIP_DEFAULT) continue;
    const friendId = counterpartOf(entry, myId);
    if (!friendId) continue;
    const createdAt = originOf(entry);
    const previous = latest.get(friendId);
    if (previous && previous.created_at >= createdAt) continue;
    latest.set(friendId, {
      is_mine: entry.from_user_id === myId,
      note: typeof entry.payload?.note === "string" ? entry.payload.note.trim() : "",
      tally_eur: normalizeCurrencyAmount(entry.payload?.tally_eur, 0),
      created_at: createdAt,
    });
  }
  return latest;
};

export interface OpenReactivationRequest {
  id: string;
  /** `true` when the friend suggested it; `false` when this user did. */
  is_incoming: boolean;
  created_at: string;
}

// Like payment requests, a reactivation suggestion is open until the ledger
// holds a response for its request_id. Keyed by friend; the newest open one.
export const getOpenReactivationRequests = (
  ledger: LedgerEntryModel[] | null | undefined,
  myId: string
): Map<string, OpenReactivationRequest> => {
  const open = new Map<string, OpenReactivationRequest>();
  if (!Array.isArray(ledger) || !myId) return open;

  const answered = new Set<string>();
  for (const entry of ledger) {
    if (entry.type === PEER_MESSAGE_TYPE_REACTIVATION_RESPONSE) {
      answered.add(`${entry.to_user_id}|${requestIdOf(entry)}`);
    }
  }
  for (const entry of ledger) {
    if (entry.type !== PEER_MESSAGE_TYPE_REACTIVATION_REQUEST) continue;
    const requestId = requestIdOf(entry);
    const friendId = counterpartOf(entry, myId);
    if (!requestId || !friendId || answered.has(`${entry.from_user_id}|${requestId}`)) continue;
    const createdAt = originOf(entry);
    const previous = open.get(friendId);
    if (previous && previous.created_at >= createdAt) continue;
    open.set(friendId, { id: requestId, is_incoming: entry.to_user_id === myId, created_at: createdAt });
  }
  return open;
};

// Rebuild a friend's tally and record list from the ledger alone — for a
// friendship whose local record was deleted and came back with a reactivation
// suggestion. Newest record first, like the friend record keeps them.
export const deriveTallyFromLedger = (
  ledger: LedgerEntryModel[] | null | undefined,
  myId: string,
  friendId: string
): { debt_eur: number; recent_transactions: TransactionModel[] } => {
  const transactions: TransactionModel[] = [];
  let debt = 0;
  const seen = new Set<string>();
  const entries = getLedgerEntriesForPeer(ledger, myId, friendId)
    .filter((entry) => entry.type === PEER_MESSAGE_TYPE_TRANSACTION_CREATED)
    .sort((a, b) => (originOf(a) < originOf(b) ? 1 : -1));
  for (const entry of entries) {
    const amount = normalizeCurrencyAmount(entry.payload?.amount_eur, NaN);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const id = (typeof entry.payload?.transaction_id === "string" && entry.payload.transaction_id) || entry.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const signed = entry.from_user_id === myId ? -amount : amount;
    debt += signed;
    transactions.push(
      createTransactionModel({
        id,
        date: typeof entry.payload?.date === "string" ? entry.payload.date : originOf(entry).slice(0, 10),
        amount_eur: signed,
        note: typeof entry.payload?.note === "string" ? entry.payload.note : "",
      })
    );
  }
  return { debt_eur: debt, recent_transactions: transactions };
};

// ---------------------------------------------------------------------------
// Deleted history
// ---------------------------------------------------------------------------

// When the user deletes their history with a disabled friend, a self-addressed
// friendship_history_deleted entry records it, so the user's other devices
// delete their copy too and sync can't bring the old entries back. An entry
// counts as deleted history when it concerns a friend this user has no record
// of and dates from before that friend's latest deletion. A friend that came
// back through a reactivation suggestion has a record again, so their history
// flows normally from then on.
export const isDeletedHistoryEntry = (
  state: RootState,
  entry: Pick<LedgerEntryModel, "from_user_id" | "to_user_id" | "originated_at" | "timestamp"> & {
    created_at?: string;
  }
): boolean => {
  const myId = state?.user?.id;
  if (!myId || !Array.isArray(state.ledger)) return false;
  const friendId = counterpartOf(entry as LedgerEntryModel, myId);
  if (!friendId) return false;
  if (state.user.friends?.some((friend) => friend.person_id === friendId)) return false;
  const origin = entry.originated_at || entry.created_at || entry.timestamp || "";
  return state.ledger.some(
    (deletion) =>
      deletion.type === PEER_MESSAGE_TYPE_HISTORY_DELETED &&
      deletion.from_user_id === myId &&
      deletion.payload?.friend_id === friendId &&
      origin <= originOf(deletion)
  );
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
  [PEER_MESSAGE_TYPE_FRIENDSHIP_DEFAULT]: (p) =>
    Number.isFinite(normalizeCurrencyAmount(p.tally_eur, NaN)) &&
    (p.note === undefined || typeof p.note === "string"),
  // The embedded history is vetted entry by entry on receipt (verifyReactivationHistory).
  [PEER_MESSAGE_TYPE_REACTIVATION_REQUEST]: (p) =>
    Array.isArray(p.history) && isAbsentOrNonNegativeAmount(p.trust_credit_limit_eur),
  [PEER_MESSAGE_TYPE_HISTORY_DELETED]: (p) => typeof p.friend_id === "string" && p.friend_id.length > 0,
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
// Reactivation history
// ---------------------------------------------------------------------------

// A reactivation suggestion carries the requester's copy of the shared
// history, because the recipient may have deleted theirs. The outer message's
// signature only proves the requester sent the list, so every entry must stand
// on its own: between exactly these two users, plausible values, and a valid
// authorship proof by its own author (which may be either of them — the
// recipient's own entries come back signed by the recipient). One bad entry
// rejects the whole list: a partial history would give a wrong tally.
// Returns the normalized entries, or null.
export const verifyReactivationHistory = async (
  history: unknown,
  requesterId: string,
  myId: string
): Promise<LedgerEntryModel[] | null> => {
  if (!Array.isArray(history)) return null;
  const verified: LedgerEntryModel[] = [];
  for (const raw of history) {
    const entry = createLedgerEntryModel(raw);
    const isBetween =
      (entry.from_user_id === requesterId && entry.to_user_id === myId) ||
      (entry.from_user_id === myId && entry.to_user_id === requesterId);
    if (!entry.id || !isBetween) return null;
    // Requests are left out by the sender so histories never nest.
    if (entry.type === PEER_MESSAGE_TYPE_REACTIVATION_REQUEST) return null;
    if (!hasValidLedgerValues(entry)) return null;
    if (!(await verifyLedgerEntryAuthorship(entry))) return null;
    verified.push(entry);
  }
  return verified;
};

// Add verified history entries this ledger lacks, keeping it newest-first.
export const mergeVerifiedEntries = (state: RootState, entries: LedgerEntryModel[]): number => {
  const existingIds = new Set(state.ledger.map((entry) => entry.id));
  const fresh = entries.filter((entry) => !existingIds.has(entry.id));
  if (fresh.length === 0) return 0;
  state.ledger.push(...fresh);
  state.ledger.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return fresh.length;
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
    if (isDeletedHistoryEntry(state, normalized)) continue;
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
