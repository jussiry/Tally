/*
Record links (TIP-4): the URL a user shares with someone not on Tally yet, to
invite them as a friend ("friend"), give them a record ("send") or ask them
for one ("request").

  https://app.tally.earth/#claim?x=send&c=<claim id>&k=npub1…&s=<secret>&n=Alice&t=Bob&a=20&m=lunch&r=wss://…

Everything sits in the URL fragment, which browsers never send to a server, so
the secret stays out of server logs. `k` (the author's key) and `s` (the
secret) let the opener prove the link was for them. For a request, `a` and
`m` are what the opener agrees to sign, and `c` names the request so the
author's client can close it; for a record sent, they only let the welcome
screen say what is coming before the author's client sends it.
@category util
*/

export const CLAIM_HASH_PREFIX = "claim?";

/**
 * @param {string} origin  the app's own origin, e.g. https://app.tally.earth
 * @param {{ direction: string, claimId: string, key: string, secret: string, senderName?: string,
 *   recipientName?: string, amount?: number, note?: string, relays?: string[] }} claim
 */
export const encodeClaimLink = (
  origin,
  { direction, claimId, key, secret, senderName, recipientName, amount, note, relays = [] }
) => {
  const params = new URLSearchParams({ x: direction, c: claimId, k: key, s: secret });
  if (senderName) params.set("n", senderName);
  if (recipientName) params.set("t", recipientName);
  if (amount > 0) params.set("a", String(amount));
  if (note) params.set("m", note);
  relays.forEach((url) => params.append("r", url));
  return `${origin}/#${CLAIM_HASH_PREFIX}${params}`;
};

/** Parses a location hash ("#claim?…" or "claim?…"); null when it isn't a claim link. */
export const parseClaimHash = (hash) => {
  const trimmed = typeof hash === "string" ? hash.replace(/^#/, "") : "";
  if (!trimmed.startsWith(CLAIM_HASH_PREFIX)) return null;
  const params = new URLSearchParams(trimmed.slice(CLAIM_HASH_PREFIX.length));
  const key = params.get("k") || "";
  const secret = params.get("s") || "";
  if (!key.startsWith("npub1") || secret.length < 32) return null;
  const amount = parseFloat(params.get("a") || "");
  const isRequest = params.get("x") === "request";
  const isFriend = params.get("x") === "friend";
  const claimId = params.get("c") || "";
  if (isRequest && (!claimId || !(amount > 0))) return null;
  return {
    isRequest,
    isFriend,
    claimId,
    key,
    secret,
    senderName: params.get("n") || "",
    recipientName: params.get("t") || "",
    amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    note: params.get("m") || "",
    relays: params.getAll("r").filter(Boolean),
  };
};

// 32 random bytes, base64url: short enough for a link, far too long to guess.
export const createClaimSecret = () => {
  const bytes = window.crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

