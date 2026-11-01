/*
Versioned migrations for the single persisted RootState blob stored in
IndexedDB. These migrations run before model normalization, so they can reshape
old records while fields that newer factories do not yet know about are still
available.
@category data
*/

import { DATA_MODEL_VERSION } from "../models/data-model.js";
import { AUTHORSHIP_SCHEME_LEGACY_SCHNORR } from "../peer/authorship.js";

type PersistedState = Record<string, unknown>;

interface AppStateMigration {
  version: number;
  migrate: (state: PersistedState) => PersistedState;
}

export interface AppStateMigrationResult {
  state: unknown;
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
}

const toStoredVersion = (state: unknown): number => {
  if (!state || typeof state !== "object") return 0;
  const version = (state as { model_version?: unknown }).model_version;
  return Number.isSafeInteger(version) && (version as number) >= 0
    ? (version as number)
    : 0;
};

const cloneState = (state: PersistedState): PersistedState => {
  if (typeof structuredClone === "function") {
    return structuredClone(state) as PersistedState;
  }
  return JSON.parse(JSON.stringify(state)) as PersistedState;
};

// v4 (TIP-6): wrap each pre-existing bare top-level `signature` in a
// `tally-canonical-schnorr-v1` authorship proof so the new verification path
// (`verifyTallyAuthorship`) accepts already-stored ledger entries and queued
// outbox messages — that path reads `authorship.signature`, never the top-level
// field, once a proof exists.
//
// We intentionally leave the raw top-level `signature` in place rather than
// deleting it. Nothing in the current code reads it anymore, but two older
// readers still verify via it: (1) a rolled-back app build that predates
// `authorship` (it loads a v4 blob but can't run this migration), and (2) an
// un-upgraded peer that receives our pre-migration entries during sync. Note
// this is only partial back-compat — entries we author *after* upgrading carry
// no top-level signature at all, so old readers already can't verify those. A
// later (v5) migration can drop the field once the pre-authorship build and any
// un-upgraded peers are fully retired.
const wrapLegacySignature = (record: unknown): void => {
  if (!record || typeof record !== "object") return;
  const entry = record as {
    signature?: unknown;
    authorship?: unknown;
  };
  if (entry.authorship && typeof entry.authorship === "object") return;
  if (typeof entry.signature !== "string" || !entry.signature) return;
  entry.authorship = {
    scheme: AUTHORSHIP_SCHEME_LEGACY_SCHNORR,
    signature: entry.signature,
  };
};

// Add future migrations here. Each migration's `version` is the DATA_MODEL_VERSION
// it upgrades *to* and must be larger than the stored state's model_version.
const APP_STATE_MIGRATIONS: AppStateMigration[] = [
  {
    version: 4,
    migrate: (state) => {
      for (const key of ["ledger", "outbox"]) {
        const list = (state as Record<string, unknown>)[key];
        if (Array.isArray(list)) {
          list.forEach(wrapLegacySignature);
        }
      }
      return state;
    },
  },
];

export const migrateAppState = (state: unknown): AppStateMigrationResult => {
  const fromVersion = toStoredVersion(state);
  if (!state || typeof state !== "object") {
    return {
      state,
      migrated: false,
      fromVersion,
      toVersion: DATA_MODEL_VERSION,
    };
  }

  const migrationsToRun = APP_STATE_MIGRATIONS
    .filter((migration) => migration.version > fromVersion)
    .filter((migration) => migration.version <= DATA_MODEL_VERSION)
    .sort((left, right) => left.version - right.version);

  if (migrationsToRun.length === 0) {
    return {
      state,
      migrated: false,
      fromVersion,
      toVersion: DATA_MODEL_VERSION,
    };
  }

  let workingState = cloneState(state as PersistedState);
  for (const migration of migrationsToRun) {
    workingState = migration.migrate(workingState);
    workingState.model_version = migration.version;
  }

  return {
    state: workingState,
    migrated: true,
    fromVersion,
    toVersion: DATA_MODEL_VERSION,
  };
};
