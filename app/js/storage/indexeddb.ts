/*
This module provides a minimal IndexedDB wrapper for the IOU app state. It centralizes database opening, object store setup, and basic get/put/delete operations under one stable API.

By isolating IndexedDB transaction boilerplate here, data modules can focus on business logic and state shape instead of browser storage wiring details.
@category data
*/

import type { RootState } from "../models/data-model.js";

const DATABASE_NAME = "iou_client_db";
const DATABASE_VERSION = 1;
const STORE_NAME = "app_state";
const APP_STATE_KEY = "root_state";
const APP_STATE_LOAD_TIMEOUT_MS = 2000;
const APP_STATE_WRITE_TIMEOUT_MS = 4000;

let databasePromise: Promise<IDBDatabase> | null = null;

const ensureIndexedDb = (): void => {
  if (!window.indexedDB) {
    throw new Error("IndexedDB is not available in this browser.");
  }
};

const waitForRequest = <T = unknown>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("IndexedDB request failed."));
  });

const waitForTransaction = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error("IndexedDB transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error || new Error("IndexedDB transaction aborted."));
  });

const withTimeoutFallback = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallbackValue: T,
  onTimeout: (() => void) | null = null
): Promise<T> =>
  new Promise((resolve, reject) => {
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      callback();
    };

    const timer = window.setTimeout(() => {
      settle(() => {
        if (typeof onTimeout === "function") {
          onTimeout();
        }
        resolve(fallbackValue);
      });
    }, timeoutMs);

    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    );
  });

const withTimeoutError = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorFactory: () => Error,
  onTimeout: (() => void) | null = null
): Promise<T> =>
  new Promise((resolve, reject) => {
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      callback();
    };

    const timer = window.setTimeout(() => {
      settle(() => {
        if (typeof onTimeout === "function") {
          onTimeout();
        }
        reject(errorFactory());
      });
    }, timeoutMs);

    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    );
  });

const openDatabase = (): Promise<IDBDatabase> => {
  ensureIndexedDb();

  return new Promise((resolve, reject) => {
    const openRequest = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    openRequest.onupgradeneeded = () => {
      const database = openRequest.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    openRequest.onblocked = () => {
      reject(new Error("Opening IndexedDB database was blocked."));
    };

    openRequest.onsuccess = () => {
      const database = openRequest.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };

    openRequest.onerror = () => {
      reject(openRequest.error || new Error("Failed to open IndexedDB database."));
    };
  });
};

const getDatabase = (): Promise<IDBDatabase> => {
  if (!databasePromise) {
    databasePromise = openDatabase().catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
};

type StoreOperation<T> = (store: IDBObjectStore) => IDBRequest<T>;

interface WithStoreOptions<T> {
  timeoutMs?: number | null;
  timeoutFallback?: T | null;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  runOperation: StoreOperation<T>,
  { timeoutMs = null, timeoutFallback = null }: WithStoreOptions<T> = {}
): Promise<T | null> {
  const currentDatabasePromise = getDatabase();
  const resetStalledPromise = () => {
    if (databasePromise === currentDatabasePromise) {
      databasePromise = null;
    }
  };

  const database: IDBDatabase | null =
    timeoutMs == null
      ? await currentDatabasePromise
      : timeoutFallback !== null
      ? await withTimeoutFallback<IDBDatabase | null>(
          currentDatabasePromise,
          timeoutMs,
          timeoutFallback as unknown as IDBDatabase | null,
          resetStalledPromise
        )
      : await withTimeoutError<IDBDatabase>(
          currentDatabasePromise,
          timeoutMs,
          () => new Error("Timed out while opening IndexedDB database."),
          resetStalledPromise
        );

  if (!database) {
    return timeoutFallback ?? null;
  }

  const transaction = database.transaction(STORE_NAME, mode);
  const transactionDone = waitForTransaction(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const request = runOperation(store);
  const requestResult = await waitForRequest(request);
  await transactionDone;
  return requestResult;
}

export const loadAppState = async (): Promise<RootState | null> => {
  try {
    const result = await withStore<RootState | undefined>(
      "readonly",
      (store) => store.get(APP_STATE_KEY) as IDBRequest<RootState | undefined>,
      {
        timeoutMs: APP_STATE_LOAD_TIMEOUT_MS,
        timeoutFallback: null,
      }
    );
    return result ?? null;
  } catch (error) {
    return null;
  }
};

export const saveAppState = async (state: RootState): Promise<RootState> => {
  await withStore<IDBValidKey>(
    "readwrite",
    (store) => store.put(state, APP_STATE_KEY),
    { timeoutMs: APP_STATE_WRITE_TIMEOUT_MS }
  );
  return state;
};

// The number on the installed app's icon, kept beside the state so the
// service worker can add to it when a push arrives (sw.js reads the same key;
// browsers can set the badge but not read it back).
export const APP_BADGE_COUNT_KEY = "app_badge_count";

export const saveAppBadgeCount = async (count: number): Promise<void> => {
  await withStore<IDBValidKey>(
    "readwrite",
    (store) => store.put(count, APP_BADGE_COUNT_KEY),
    { timeoutMs: APP_STATE_WRITE_TIMEOUT_MS }
  );
};

export const clearAppState = async (): Promise<void> => {
  await withStore<undefined>(
    "readwrite",
    (store) => store.delete(APP_STATE_KEY) as IDBRequest<undefined>,
    { timeoutMs: APP_STATE_WRITE_TIMEOUT_MS }
  );
};

// Drops the entire database. Use this for "remove user" flows so no residual
// data can be written back by another tab before the page reloads.
export const deleteDatabase = (): Promise<void> =>
  new Promise((resolve) => {
    // Close any cached connection first so the delete request is not blocked
    // by our own open handle. Other tabs may still block it briefly; we resolve
    // on onblocked too because the page is about to reload anyway.
    if (databasePromise) {
      databasePromise
        .then((db) => {
          try {
            db?.close();
          } catch {
            /* ignore */
          }
        })
        .catch(() => {})
        .finally(() => {
          databasePromise = null;
        });
    }

    const request = window.indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve(); // non-fatal — reload handles it
    request.onblocked = () => resolve(); // another tab open; reload handles it
  });

// Dev-console escape hatch — keep the global the legacy JS code exposed.
(window as unknown as { clearAppState: () => Promise<void> }).clearAppState =
  clearAppState;
