/*
Asks the browser to keep Tally's storage (IndexedDB: the key and the ledger)
when it clears space or old site data. Without it, browsers may evict data of
sites not visited often. Browsers decide by engagement: an installed app, or
one with notification permission, is likely to be granted, so this is asked
right after those happen (and on start-up of the installed app). Repeating it
is harmless.
@category util
*/

export const requestPersistentStorage = async () => {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
};
