/*
This module defines the core persisted data model for the IOU client. It provides factory helpers for users, contacts, connections, and log entries so IndexedDB state stays structurally consistent.

The same helpers are used for normalization when loading persisted state. Keeping model defaults in one place makes storage migrations safer and prevents repeated shape checks across UI modules.

Factory inputs are intentionally typed loosely (`any`) because these helpers
are defensive normalizers — they accept whatever shape IndexedDB, seed data,
or network payloads hand over and coerce it into a known good structure. The
*output* types are the contract callers rely on.
@category data
*/

import {
  FRIENDSHIP_STATUS_ACCEPTED,
  PENDING_CREDIT_LIMIT_LOWERED,
} from "../utils/friendships.js";
import { DEFAULT_STUN_SERVERS, normalizeStunList } from "../utils/stun-url.js";

export const DATA_MODEL_VERSION = 4;

// ---------------------------------------------------------------------------
// Model types — the canonical shapes the rest of the app consumes.
// ---------------------------------------------------------------------------

export interface TransactionModel {
  id: string;
  date: string;
  amount_eur: number;
  note: string;
}

export interface PendingNameChange {
  oldName: string;
  newName: string;
}

/** `true` = incoming proposal, `false` = outgoing, `"lowered"` = auto-applied lower limit. */
export type PendingCreditLimitDirection = boolean | typeof PENDING_CREDIT_LIMIT_LOWERED | null;

export interface FriendModel {
  person_id: string;
  person_name: string;
  friendship_status: string;
  debt_eur: number;
  trust_credit_limit_eur: number;
  pending_credit_limit_eur: number | null;
  pending_credit_limit_is_incoming: PendingCreditLimitDirection;
  recent_transactions: TransactionModel[];
  last_viewed_transaction_ids: string[];
  last_synced_at: string;
  // Open payment requests are deliberately absent: they are derived from the
  // ledger (getOpenPaymentRequests in ledger.ts) and attached by buildView.
  pending_name_change: PendingNameChange | null;
  /**
   * Relay-server URLs this friend has told us they use, to suggest
   * popular-among-friends relays in the add-relay UI. The `my_relays` exchange
   * that would populate this is TIP-003 phase 2 and is NOT implemented, so in
   * practice this is always empty today; the field exists so the schema is
   * ready and `share_my_relays` has something to gate.
   */
  relays: string[];
}

/** Backwards compatibility alias for FriendModel */
export type ConnectionModel = FriendModel;

export interface PersonModel {
  id: string;
  name: string;
  public_key: string;
  public_key_hex: string;
  /** Always `""` when produced by `createPublicPersonModel`. */
  private_key: string;
  /** Always `""` when produced by `createPublicPersonModel`. */
  private_key_hex: string;
  /**
   * Where this user's signing key lives. `"local"` (default) means the private
   * key is held in `private_key_hex`; `"nip07"` means the key lives in a browser
   * extension (window.nostr) and the private-key fields are empty. Not secret,
   * so it survives `createPublicPersonModel`.
   */
  signer_type: SignerType;
  friends: FriendModel[];
  /** @deprecated Use friends instead */
  connections?: FriendModel[];
}

export const SIGNER_TYPE_LOCAL = "local";
export const SIGNER_TYPE_NIP07 = "nip07";
export type SignerType = typeof SIGNER_TYPE_LOCAL | typeof SIGNER_TYPE_NIP07;

/** A signed Nostr event (NIP-01) used as a Tally authorship proof. */
export interface SignedNostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * Authorship proof attached to durable messages and ledger entries (TIP-006).
 * `tally-nostr-event-v1` carries `event`; the legacy `tally-canonical-schnorr-v1`
 * carries `signature`. One field shape, discriminated by `scheme`.
 */
export interface AuthorshipProof {
  scheme: string;
  event?: SignedNostrEvent;
  signature?: string;
}

export interface LedgerEntryModel {
  id: string;
  timestamp: string;
  type: string;
  from_user_id: string;
  to_user_id: string;
  /** Sender's asserted `created_at` — part of the signed digest. */
  originated_at: string;
  /**
   * Legacy Schnorr (BIP-340) signature hex over the canonical digest. May be
   * `""`. Retained for one release alongside `authorship` for rollback; new
   * code reads `authorship`.
   */
  signature: string;
  /** Authorship proof (TIP-006). `null` for legacy entries not yet migrated. */
  authorship: AuthorshipProof | null;
  payload: Record<string, unknown>;
}

export interface PeerMessageModel {
  id: string;
  type: string;
  from_user_id: string;
  to_user_id: string;
  created_at: string;
  /** Legacy raw signature; retained transitionally. New code reads `authorship`. */
  signature: string;
  /** Authorship proof (TIP-006). `null` for transport/non-durable messages. */
  authorship: AuthorshipProof | null;
  payload: Record<string, unknown>;
}

export type ContactsMap = Record<string, PersonModel>;

export interface RootState {
  model_version: number;
  /** Stable per-device identifier generated client-side on first app start. Persists across reconnects and across relay servers. */
  device_id: string;
  /**
   * Secondary relay-server URLs the user has added in settings. The "main"
   * relay (the WebSocket on the host that served the app bundle) is not
   * stored here — it is always available implicitly and prepended at view
   * build time. See `utils/relay-url.js`.
   */
  relays: string[];
  /**
   * Whether to tell friends which relay servers we use, via a `my_relays`
   * peer message exchanged when both sides come online. Defaults to true.
   * The flag is persisted and surfaced in settings, but the exchange itself is
   * not implemented yet — see TIP-003 §10 for the rationale and drawbacks.
   */
  share_my_relays: boolean;
  /**
   * STUN server URLs used during WebRTC ICE gathering to discover each peer's
   * public (reflexive) address. User-editable in settings; defaults to
   * `DEFAULT_STUN_SERVERS` when absent. Unlike relays these hold no persistent
   * connection. See `utils/stun-url.js`. (Tally ships no TURN server — the
   * encrypted-envelope relay covers the fallback when P2P can't form.)
   */
  stun_servers: string[];
  user: PersonModel;
  contacts: ContactsMap;
  ledger: LedgerEntryModel[];
  outbox: PeerMessageModel[];
  processed_peer_message_ids: string[];
}

// ---------------------------------------------------------------------------
// Internal coercion helpers — kept `any` so legacy JS call sites pass through.
// ---------------------------------------------------------------------------

const asNumberOrDefault = (value: any, defaultValue: number = 0): number => {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : defaultValue;
};

export const normalizeCurrencyAmount = (value: any, defaultValue: number = 0): number => {
  return asNumberOrDefault(value, defaultValue);
};

const asStringOrDefault = (value: any, defaultValue: string = ""): string => {
  return typeof value === "string" ? value : defaultValue;
};

const asTrimmedStringOrDefault = (value: any, defaultValue: string = ""): string => {
  return asStringOrDefault(value, defaultValue).trim();
};

const clonePlainObject = (value: any): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
};

// Defensive normalizer for an embedded signed Nostr event. Coerces the NIP-01
// fields into known types; callers verify cryptographically before trusting.
const normalizeSignedEvent = (input: any): SignedNostrEvent | undefined => {
  if (!input || typeof input !== "object") return undefined;
  return {
    id: asTrimmedStringOrDefault(input.id),
    pubkey: asTrimmedStringOrDefault(input.pubkey),
    created_at: asNumberOrDefault(input.created_at, 0),
    kind: asNumberOrDefault(input.kind, 0),
    tags: Array.isArray(input.tags)
      ? input.tags
          .filter((tag: any) => Array.isArray(tag))
          .map((tag: any) => tag.map((part: any) => asStringOrDefault(part)))
      : [],
    content: asStringOrDefault(input.content),
    sig: asTrimmedStringOrDefault(input.sig),
  };
};

// Normalize an authorship proof. Keeps whichever discriminated payload the
// scheme uses (`event` for signed-event proofs, `signature` for legacy). Returns
// null when there is no usable proof so the field has one absent representation.
const normalizeAuthorship = (input: any): AuthorshipProof | null => {
  if (!input || typeof input !== "object") return null;
  const scheme = asTrimmedStringOrDefault(input.scheme);
  if (!scheme) return null;
  const proof: AuthorshipProof = { scheme };
  const event = normalizeSignedEvent(input.event);
  if (event) proof.event = event;
  const signature = asTrimmedStringOrDefault(input.signature);
  if (signature) proof.signature = signature;
  return proof;
};

const normalizeStringList = (values: any): string[] => {
  if (!Array.isArray(values)) return [];

  const normalizedValues = new Set<string>();
  values.forEach((value) => {
    const normalizedValue = asTrimmedStringOrDefault(value);
    if (!normalizedValue) return;
    normalizedValues.add(normalizedValue);
  });

  return Array.from(normalizedValues);
};

const normalizeFriendList = (friends: any): FriendModel[] => {
  if (!Array.isArray(friends)) return [];

  const normalizedFriends = new Map<string, FriendModel>();
  friends.forEach((friend) => {
    const normalizedFriend = createFriendModel(friend);
    if (!normalizedFriend.person_id) return;
    normalizedFriends.set(normalizedFriend.person_id, normalizedFriend);
  });

  return Array.from(normalizedFriends.values());
};

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export const createTransactionModel = (input: any = {}): TransactionModel => {
  return {
    id: asTrimmedStringOrDefault(input.id),
    date: asTrimmedStringOrDefault(input.date),
    amount_eur: asNumberOrDefault(input.amount_eur, 0),
    note: asTrimmedStringOrDefault(input.note),
  };
};

export const createFriendModel = (input: any = {}): FriendModel => {
  const transactions: TransactionModel[] = Array.isArray(input.recent_transactions)
    ? input.recent_transactions.map((transaction: any) => createTransactionModel(transaction))
    : [];
  const lastViewedTransactionIds = normalizeStringList(input.last_viewed_transaction_ids);

  const pendingCreditLimitIsIncoming: PendingCreditLimitDirection =
    input.pending_credit_limit_is_incoming === true
      ? true
      : input.pending_credit_limit_is_incoming === false
      ? false
      : input.pending_credit_limit_is_incoming === PENDING_CREDIT_LIMIT_LOWERED
      ? PENDING_CREDIT_LIMIT_LOWERED
      : null;

  return {
    person_id: asTrimmedStringOrDefault(input.person_id),
    person_name: asTrimmedStringOrDefault(input.person_name),
    friendship_status: asTrimmedStringOrDefault(
      input.friendship_status,
      FRIENDSHIP_STATUS_ACCEPTED
    ),
    debt_eur: asNumberOrDefault(input.debt_eur, 0),
    trust_credit_limit_eur: asNumberOrDefault(input.trust_credit_limit_eur, 0),
    pending_credit_limit_eur:
      Number.isFinite(input.pending_credit_limit_eur) && input.pending_credit_limit_eur >= 0
        ? input.pending_credit_limit_eur
        : null,
    pending_credit_limit_is_incoming: pendingCreditLimitIsIncoming,
    recent_transactions: transactions,
    last_viewed_transaction_ids: lastViewedTransactionIds,
    last_synced_at: asTrimmedStringOrDefault(input.last_synced_at),
    pending_name_change:
      input.pending_name_change &&
      typeof input.pending_name_change.oldName === "string" &&
      typeof input.pending_name_change.newName === "string"
        ? { oldName: input.pending_name_change.oldName, newName: input.pending_name_change.newName }
        : null,
    relays: normalizeStringList(input.relays),
  };
};

/** Backwards compatibility alias for createFriendModel */
export const createConnectionModel = createFriendModel;

export interface CreatePersonModelOptions {
  includePrivateKeys?: boolean;
}

export const createPersonModel = (
  input: any = {},
  options: CreatePersonModelOptions = {}
): PersonModel => {
  const { includePrivateKeys = true } = options;
  const normalizedName = asTrimmedStringOrDefault(input.name);
  const normalizedId = asTrimmedStringOrDefault(input.id);
  const normalizedPublicKey = asTrimmedStringOrDefault(input.public_key);
  const personId = normalizedPublicKey || normalizedId;
  const friends = normalizeFriendList(input.friends || input.connections);

  return {
    id: personId,
    name: normalizedName || "Anonymous",
    public_key: personId,
    public_key_hex: asTrimmedStringOrDefault(input.public_key_hex),
    private_key: includePrivateKeys ? asTrimmedStringOrDefault(input.private_key) : "",
    private_key_hex: includePrivateKeys ? asTrimmedStringOrDefault(input.private_key_hex) : "",
    signer_type: input.signer_type === SIGNER_TYPE_NIP07 ? SIGNER_TYPE_NIP07 : SIGNER_TYPE_LOCAL,
    friends,
  };
};

export const createPublicPersonModel = (input: any = {}): PersonModel => {
  return createPersonModel(input, { includePrivateKeys: false });
};

export const createLedgerEntryModel = (input: any = {}): LedgerEntryModel => {
  return {
    id: asTrimmedStringOrDefault(input.id),
    timestamp: asTrimmedStringOrDefault(input.timestamp),
    type: asTrimmedStringOrDefault(input.type),
    from_user_id: asTrimmedStringOrDefault(input.from_user_id),
    to_user_id: asTrimmedStringOrDefault(input.to_user_id),
    // Sender's asserted timestamp from the peer message's created_at. Kept
    // alongside the locally-authoritative `timestamp` so the signed digest can
    // be reconstructed and verified after the fact.
    originated_at: asTrimmedStringOrDefault(input.originated_at),
    // Legacy Schnorr signature (hex) over the canonical inner-message digest.
    // Retained transitionally; `authorship` is the field new code reads.
    signature: asTrimmedStringOrDefault(input.signature),
    authorship: normalizeAuthorship(input.authorship),
    payload: clonePlainObject(input.payload),
  };
};

export const createPeerMessageModel = (input: any = {}): PeerMessageModel => {
  return {
    id: asTrimmedStringOrDefault(input.id),
    type: asTrimmedStringOrDefault(input.type),
    from_user_id: asTrimmedStringOrDefault(input.from_user_id),
    to_user_id: asTrimmedStringOrDefault(input.to_user_id),
    created_at: asTrimmedStringOrDefault(input.created_at),
    signature: asTrimmedStringOrDefault(input.signature),
    authorship: normalizeAuthorship(input.authorship),
    payload: clonePlainObject(input.payload),
  };
};

export const createEmptyAppState = (userPerson: any): RootState => {
  return {
    model_version: DATA_MODEL_VERSION,
    device_id: "",
    relays: [],
    share_my_relays: true,
    stun_servers: [...DEFAULT_STUN_SERVERS],
    user: createPersonModel(userPerson),
    contacts: {},
    ledger: [],
    outbox: [],
    processed_peer_message_ids: [],
  };
};

export const normalizeContactsMap = (contacts: any): ContactsMap => {
  if (!contacts || typeof contacts !== "object") return {};

  return Object.entries(contacts).reduce<ContactsMap>(
    (normalizedContacts, [contactKey, contactValue]: [string, any]) => {
      const normalizedContact = createPublicPersonModel({
        ...contactValue,
        id: contactValue?.id || contactKey,
        public_key: contactValue?.public_key || contactKey,
      });
      if (!normalizedContact.id) return normalizedContacts;
      normalizedContacts[normalizedContact.id] = normalizedContact;
      return normalizedContacts;
    },
    {}
  );
};

export const normalizeAppState = (state: any): RootState | null => {
  if (!state || typeof state !== "object") return null;
  if (!state.user) return null;

  return {
    model_version: DATA_MODEL_VERSION,
    device_id: asTrimmedStringOrDefault(state.device_id),
    relays: normalizeStringList(state.relays),
    // Default-on for new state; preserved when explicitly stored as boolean.
    share_my_relays: typeof state.share_my_relays === "boolean" ? state.share_my_relays : true,
    // Seed the Cloudflare default only when the field is entirely absent
    // (pre-existing users); an explicit empty array is the user's choice and
    // is preserved.
    stun_servers:
      state.stun_servers === undefined
        ? [...DEFAULT_STUN_SERVERS]
        : normalizeStunList(state.stun_servers),
    user: createPersonModel(state.user),
    contacts: normalizeContactsMap(state.contacts),
    ledger: Array.isArray(state.ledger)
      ? state.ledger.map((entry: any) => createLedgerEntryModel(entry))
      : [],
    outbox: Array.isArray(state.outbox)
      ? state.outbox.map((entry: any) => createPeerMessageModel(entry))
      : [],
    processed_peer_message_ids: normalizeStringList(state.processed_peer_message_ids),
  };
};
