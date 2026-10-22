/*
The interface between the persisted app state and the realtime transport.

`peer/client.js` is the only caller. It needs a snapshot of who to
connect to and what to deliver (`getRealtimeSnapshot`), a way to merge ledger
batches received during sync (`addLedgerEntries`), receipts of its own
deliveries (`markPeerMessageReceived`, `updateLastSyncedAt`), and a handler
for verified inbound peer messages (`applyInboundPeerMessage`).

Keeping this surface in its own file makes the transport dependency on app
state explicit — command modules don't reach for these functions, and
transport code doesn't reach into command modules.
@category network
*/

import {
  createLedgerEntryModel,
  createPeerMessageModel,
} from "../models/data-model.js";
import {
  isDisabledFriendshipStatus,
  isPeerEligibleFriendshipStatus,
} from "../utils/friendships.js";
import { asTrimmedString, hasUser } from "../state-utils.js";
import { buildView } from "../ui/view-model.js";
import {
  loadData,
  loadState,
  persistAndBuildView,
  persistState,
} from "../app-state.js";
import {
  hasProcessedPeerMessage,
  markProcessedPeerMessage,
  removeQueuedPeerMessage,
} from "./outbox.js";
import {
  deleteFriendHistory,
  findFriend,
  getFriend,
  syncUserNameAcrossContacts,
} from "../friends-helpers.js";
import { createKeyProviderFromState } from "../crypto/key-provider.js";
import { getMainRelayUrl } from "../utils/relay-url.js";
import {
  createInboundProcessingResult,
  routeInboundEntry,
  routeOutboundEntry,
} from "./handlers.js";
import {
  appendLedgerEntryFromMessage,
  hasValidLedgerValues,
  isDeletedHistoryEntry,
  mergeSyncedLedgerEntries,
} from "../ledger.js";
import {
  PEER_MESSAGE_TYPE_HISTORY_DELETED,
  PEER_MESSAGE_TYPE_RECEIVED,
  PEER_RECEIPT_RESULT_IGNORED,
  PEER_RECEIPT_RESULT_PROCESSED,
} from "./messages.js";
import { showNotification } from "../ui/notifications.js";
import { collectOsNotifyTypesByAuthor } from "../notify/notification-policy.js";
import { showLocalOsNotification } from "../notify/local-os-notification.js";

// Everything the realtime client needs to decide who to connect to and what
// to re-deliver after a reconnect. The ledger is included so sync_hello can
// send the `known_ids` list without taking another round-trip to the store.
export const getRealtimeSnapshot = async () => {
  const state = await loadState();
  if (!hasUser(state)) {
    return null;
  }

  const friends = Array.isArray(state.user.friends) ? state.user.friends : [];
  const eligibleFriends = friends.filter((friend) => isPeerEligibleFriendshipStatus(friend.friendship_status));
  const relationshipPeerIds = eligibleFriends
    .map((friend) => friend.person_id)
    .filter(Boolean);
  const queuedPeerIds = (Array.isArray(state.outbox) ? state.outbox : [])
    .map((message) => message.to_user_id)
    .filter(Boolean);

  const peerNames = {};
  eligibleFriends.forEach((friend) => {
    if (friend.person_id && friend.person_name) {
      peerNames[friend.person_id] = friend.person_name;
    }
  });

  // Build the relay URL set the realtime pool should connect to. The main
  // relay (the server that served this app bundle) is always included;
  // user-added secondaries from `state.relays` follow. Deduped so the user
  // adding their own main URL by hand doesn't cause a duplicate connection.
  const secondaryRelays = Array.isArray(state.relays) ? state.relays : [];
  const relays = Array.from(new Set([getMainRelayUrl(), ...secondaryRelays].filter(Boolean)));

  return {
    userId: state.user.id,
    deviceId: state.device_id || "",
    userName: state.user.name,
    // The signing/encryption seam for the transport layer. Held in memory only
    // (never persisted) — client.js routes every wrap/unwrap through it instead
    // of touching raw key material.
    keyProvider: createKeyProviderFromState(state),
    peerIds: Array.from(new Set([...relationshipPeerIds, ...queuedPeerIds])),
    peerNames,
    // Each peer's latest OS-notification choice (absent → defaults). The
    // outbox flush attaches a push hint only for types the recipient enabled.
    peerOsNotifyTypes: collectOsNotifyTypesByAuthor(state.ledger),
    outbox: Array.isArray(state.outbox) ? state.outbox.map((entry) => createPeerMessageModel(entry)) : [],
    ledger: Array.isArray(state.ledger) ? state.ledger.map((entry) => createLedgerEntryModel(entry)) : [],
    relays,
    // STUN servers for WebRTC ICE gathering. normalizeAppState seeds the
    // default when absent, so this is already a clean list.
    stunServers: Array.isArray(state.stun_servers) ? state.stun_servers : [],
  };
};

/**
 * Thin persistence wrapper around `mergeSyncedLedgerEntries` — the signature
 * verification and de-duplication live there. Returns the count added so the
 * caller can decide whether to re-emit a view.
 */
export const addLedgerEntries = async (entries) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return 0;
  }
  const state = await loadState();
  if (!hasUser(state)) return 0;

  const knownIds = new Set(state.ledger.map((entry) => entry.id));
  const added = await mergeSyncedLedgerEntries(state, entries);
  if (added > 0) {
    applyHistoryDeletions(
      state,
      state.ledger.filter((entry) => !knownIds.has(entry.id))
    );
    await persistAndBuildView(state);
  }
  return added;
};

// History deletions made on another device of this user arrive as
// self-addressed entries; repeat them here. A friend reactivated since then
// keeps their history.
const applyHistoryDeletions = (state, entries) => {
  entries.forEach((entry) => {
    if (entry.type !== PEER_MESSAGE_TYPE_HISTORY_DELETED) return;
    if (entry.from_user_id !== state.user.id) return;
    const friendId = entry.payload?.friend_id;
    const friend = getFriend(state, friendId);
    if (friend && !isDisabledFriendshipStatus(friend.friendship_status)) return;
    deleteFriendHistory(state, friendId, { upTo: entry.originated_at || entry.timestamp });
  });
};

// Like addLedgerEntries, but also applies outbound entries to user-connection
// state via routeOutboundEntry. This is the unified pipeline: the same state
// transition runs whether the entry was created by a local command or received
// via self-mesh sync from another device.
//
// Entries must be pre-sorted chronologically by the caller so causal
// dependencies (e.g. friend_request before friend_accept) are honoured.
export const addOutboundLedgerEntries = async (entries) => {
  if (!Array.isArray(entries) || entries.length === 0) return 0;

  const state = await loadState();
  if (!hasUser(state)) return 0;

  // Drop entries with impossible values up front, so they are neither stored
  // nor applied. The merge re-checks this; the filter also guards the replay
  // loop below, which runs over entries the merge skipped as already stored.
  const validEntries = entries.filter(
    (entry) => hasValidLedgerValues(entry) && !isDeletedHistoryEntry(state, entry)
  );
  const added = await mergeSyncedLedgerEntries(state, validEntries);

  // Apply every entry regardless of whether it was newly added — the
  // connection record may be missing even if the ledger entry was already
  // stored (e.g. a previous sync that crashed before persisting contacts).
  let stateChanged = added;
  for (const entry of validEntries) {
    if (routeOutboundEntry(state, entry)) stateChanged += 1;
  }

  if (stateChanged > 0) {
    await persistAndBuildView(state);
  }
  return added;
};

// The localStorage key and version that tracks whether the one-time ledger
// migration has been run on this device. Bump LEDGER_MIGRATION_VERSION
// whenever a future change requires a full ledger replay.
const LEDGER_MIGRATION_KEY = "iou_ledger_migration_v";
const LEDGER_MIGRATION_VERSION = 1;

// Run the full ledger repair exactly once per device, the first time this
// version of the app starts. On all subsequent starts the localStorage flag
// is set and this is a cheap no-op. Bump LEDGER_MIGRATION_VERSION to
// re-trigger for future migrations.
export const runLedgerMigrationIfNeeded = async () => {
  try {
    const stored = parseInt(localStorage.getItem(LEDGER_MIGRATION_KEY) || "0", 10);
    if (stored >= LEDGER_MIGRATION_VERSION) return;
    await repairConnectionsFromLedger();
    localStorage.setItem(LEDGER_MIGRATION_KEY, String(LEDGER_MIGRATION_VERSION));
  } catch {
    // Non-fatal — if localStorage is unavailable the repair still ran; the
    // flag just won't persist, so it will run again next startup (acceptable).
  }
};

// Scans the full persisted ledger for outbound entries and re-applies them
// via routeOutboundEntry. Normally called only via runLedgerMigrationIfNeeded.
// Can also be triggered explicitly for corrupted-state recovery.
export const repairConnectionsFromLedger = async () => {
  const state = await loadState();
  if (!hasUser(state)) return;

  const myId = state.user.id;
  const ledger = Array.isArray(state.ledger) ? state.ledger : [];

  // Sort ascending so causal dependencies are processed first.
  const outboundEntries = ledger
    .filter((e) => e.from_user_id === myId && e.to_user_id && e.to_user_id !== myId)
    .sort((a, b) => {
      const aTs = a.originated_at || a.timestamp || "";
      const bTs = b.originated_at || b.timestamp || "";
      return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
    });

  let changed = 0;
  for (const entry of outboundEntries) {
    if (routeOutboundEntry(state, entry)) changed += 1;
  }

  if (changed > 0) {
    await persistAndBuildView(state);
  }
};

export const updateLastSyncedAt = async (peerId) => {
  const normalizedPeerId = asTrimmedString(peerId);
  if (!normalizedPeerId) return;

  const state = await loadState();
  if (!hasUser(state)) return;

  const friend = findFriend(state.user, normalizedPeerId);
  if (!friend) return;

  friend.last_synced_at = new Date().toISOString();
  await persistState(state);
};

export const markPeerMessageReceived = async (messageId) => {
  const normalizedMessageId = asTrimmedString(messageId);
  if (!normalizedMessageId) {
    return loadData();
  }

  const state = await loadState();
  if (!hasUser(state)) {
    return null;
  }

  const removedMessage = removeQueuedPeerMessage(state, normalizedMessageId);
  if (!removedMessage) {
    return buildView(state);
  }

  const peerId = removedMessage.to_user_id;
  if (peerId) {
    const friend = findFriend(state.user, peerId);
    if (friend) {
      friend.last_synced_at = new Date().toISOString();
    }
  }

  return persistAndBuildView(state);
};

// Scans the full persisted ledger for name_changed entries authored by the
// local user and applies the most recently-originated one as the display name.
// Called after any self-mesh sync so both devices converge on the same name
// without relying on in-flight entry classification being perfect.
export const applyOwnNameFromLedger = async () => {
  const state = await loadState();
  if (!hasUser(state)) return;

  const myId = state.user.id;
  const nameEntries = (Array.isArray(state.ledger) ? state.ledger : []).filter(
    (e) =>
      e.type === "name_changed" &&
      e.from_user_id === myId &&
      typeof e.payload?.name === "string" &&
      e.payload.name.trim()
  );
  if (nameEntries.length === 0) return;

  nameEntries.sort((a, b) => {
    const aTs = a.originated_at || a.timestamp || "";
    const bTs = b.originated_at || b.timestamp || "";
    return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
  });
  const latestName = nameEntries[nameEntries.length - 1].payload.name.trim();

  if (!latestName || state.user.name === latestName) return;

  state.user.name = latestName;
  syncUserNameAcrossContacts(state);
  await persistAndBuildView(state);
};

// Ledger-first inbound pipeline. A verified peer message becomes a ledger
// entry BEFORE any state mutation; the resulting state is then derived from
// that entry via routeInboundEntry. Replays (sync, startup rehydration) run
// through the same derivation path, so the UI state is always a function of
// the ledger — the single source of truth.
export const applyInboundPeerMessage = async (incomingMessage) => {
  const message = createPeerMessageModel(incomingMessage);
  if (!message.id || !message.from_user_id || !message.type) {
    return createInboundProcessingResult(await loadData());
  }

  const state = await loadState();
  if (!hasUser(state)) {
    return createInboundProcessingResult(null);
  }

  // Filter: the message isn't addressed to us. Nothing to do and no receipt
  // semantics to report. A missing recipient counts as "not us": every
  // durable message is queued with one (queuePeerMessage refuses otherwise),
  // and transport messages (ping, receipts, sync) never reach this function.
  if (message.to_user_id !== state.user.id) {
    return createInboundProcessingResult(buildView(state));
  }

  // Receipts are transport-layer acks, not ledger events — handled elsewhere.
  if (message.type === PEER_MESSAGE_TYPE_RECEIVED) {
    return createInboundProcessingResult(buildView(state));
  }

  // Dedupe: the sender wants to know we already have this one, and we must
  // not re-run the state derivation or re-append to the ledger.
  if (hasProcessedPeerMessage(state, message.id)) {
    return createInboundProcessingResult(
      buildView(state),
      PEER_RECEIPT_RESULT_PROCESSED
    );
  }

  // History the user deleted stays deleted, even when another device or the
  // friend replays it (see isDeletedHistoryEntry).
  if (isDeletedHistoryEntry(state, message)) {
    return createInboundProcessingResult(buildView(state), PEER_RECEIPT_RESULT_IGNORED);
  }

  // Append the ledger entry first. From this point on, state changes are a
  // pure function of this entry — routeInboundEntry reads from it.
  const entry = appendLedgerEntryFromMessage(state, message);
  if (!entry) {
    return createInboundProcessingResult(buildView(state));
  }

  const notification = await routeInboundEntry(state, entry);

  if (!notification) {
    // The entry was well-formed but not applicable to current state (e.g. a
    // friend_request from someone already accepted). Roll back the ledger
    // append so the log doesn't accumulate no-ops, and tell the sender we
    // ignored it.
    state.ledger.shift();
    return createInboundProcessingResult(
      buildView(state),
      PEER_RECEIPT_RESULT_IGNORED
    );
  }

  markProcessedPeerMessage(state, message.id);
  const friend = getFriend(state, message.from_user_id);
  if (friend) {
    friend.last_synced_at = new Date().toISOString();
  }

  showNotification(notification);
  void showLocalOsNotification(state, entry, notification);

  return createInboundProcessingResult(
    await persistAndBuildView(state),
    PEER_RECEIPT_RESULT_PROCESSED
  );
};
