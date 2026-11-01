/*
Commands for managing the user's secondary relay-server list.

The "main" relay is implicit (derived from `window.location` at runtime) and
is never stored or removable. Only user-added secondary relays live in
`state.relays`. The relay-pool transport (forthcoming) reads this list plus
the implicit main relay.

These commands intentionally mutate only `state.relays` — no peer messages
are emitted, because relay choice is private device-level configuration and
should not be announced to friends. (A future TIP may add an opt-in
`relay_hint` for friend discovery, but that is out of scope here.)
@category command
*/

import { loadData, loadState, persistAndBuildView } from "../app-state.js";
import { getMainRelayUrl, isSameRelayUrl, normalizeRelayUrl } from "../utils/relay-url.js";

const MAX_SECONDARY_RELAYS = 10;

export const addRelay = async (rawUrl) => {
  const url = normalizeRelayUrl(rawUrl);
  if (!url) return { ok: false, reason: "invalid" };

  if (isSameRelayUrl(url, getMainRelayUrl())) {
    return { ok: false, reason: "is_main" };
  }

  const state = await loadState();
  if (!state) return { ok: false, reason: "no_state" };

  const existing = Array.isArray(state.relays) ? state.relays : [];
  if (existing.some((entry) => isSameRelayUrl(entry, url))) {
    return { ok: false, reason: "duplicate" };
  }

  if (existing.length >= MAX_SECONDARY_RELAYS) {
    return { ok: false, reason: "limit" };
  }

  state.relays = [...existing, url];
  await persistAndBuildView(state);
  return { ok: true, url };
};

// Toggle whether to share our relay list with friends. Currently this only
// persists the flag — the actual `my_relays` peer message exchange is
// deferred to when the relay-pool transport ships (TIP-3 §10).
export const setShareMyRelays = async (value) => {
  const state = await loadState();
  if (!state) return null;

  const next = Boolean(value);
  if (state.share_my_relays === next) {
    return loadData();
  }

  state.share_my_relays = next;
  return persistAndBuildView(state);
};

export const removeRelay = async (rawUrl) => {
  const url = normalizeRelayUrl(rawUrl);
  if (!url) return loadData();

  const state = await loadState();
  if (!state) return null;

  const existing = Array.isArray(state.relays) ? state.relays : [];
  const next = existing.filter((entry) => !isSameRelayUrl(entry, url));
  if (next.length === existing.length) {
    return loadData();
  }

  state.relays = next;
  return persistAndBuildView(state);
};
