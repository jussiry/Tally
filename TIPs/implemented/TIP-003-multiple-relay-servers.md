# TIP-003: Multiple Relay Servers

| Field   | Value |
|---------|-------|
| Number  | TIP-003 |
| Title   | Multiple Relay Servers |
| Status  | Implemented |
| Author  | Jussi Rytkönen |
| Created | 2026-05-21 |

> **Note:** Phase 2 (my_relays peer message exchange) and Phase 3 refinements are tracked in the root TIPs folder as TIP-003-relay-sharing.md.

---

## Summary

Tally clients today connect to a single hardcoded relay (`/ws` on the server that also serves the app). This TIP describes how a client maintains simultaneous WebSocket connections to **1–5 user-chosen relays**, treats them as interchangeable transports for presence, WebRTC signalling, and offline envelope queueing, and falls back gracefully when one is down. Other Tally clients are not aware of which relays a given user is on — relays are picked locally and overlap with friends' relays opportunistically.

The goal is decentralisation: no single operator can take the network offline, and any party can run a relay that conforms to the Tally signalling protocol.

---

## Motivation

A single relay is a single point of failure. The operator can:

- Take the network offline (intentionally or otherwise).
- Censor specific users by refusing their registrations.
- Drop specific envelope routes silently.
- Be subpoenaed for connection metadata covering every user.

End-to-end signature and ciphertext protect message **contents**, but not **availability** and not **metadata**. Multiple independent relays mitigate availability and dilute metadata exposure across operators the user has individually chosen to trust at the metadata level.

The current server still hosts the app bundle. Secondary relays serve only `/ws` — they need none of the static asset or build pipeline. A relay is therefore very small: a single Node process running `server/signaling/websocket-server.js` (or any other server that speaks the same protocol).

---

## Trust Model

Each relay is **semi-trusted by the user who added it**:

- **What a relay can see**: which `(userId, deviceId)` pairs are online, which `peer_candidates` a user has declared, the SDP / ICE blobs of every WebRTC handshake passing through it, and the ciphertext + addressing of any queued envelope.
- **What a relay cannot do**: forge a signed envelope (signature check at recipient), read envelope plaintext (E2E encryption), or invent a friendship — a `peer_connect` it manufactures will be ignored by the receiving client if the peer is not in its own candidate list.
- **What multiple relays mitigate**: dropped messages (other relays still deliver), forced offline (other relays still register the user), single-operator metadata aggregation.
- **What multiple relays do not mitigate**: each individual relay still sees what it always saw. Adding a malicious relay does not weaken the others, but it does hand a new copy of metadata to a new operator. The user is responsible for choosing which operators to trust.

A relay cannot MITM the WebRTC data channel for free: the DTLS fingerprint travels inside the signed SDP, and once the data channel is up the ciphertext inside it is also signed and encrypted at the application layer. A malicious relay would need to break the application-layer signatures to inject content, which the friend's public key prevents.

---

## Protocol Property This Builds On

The server's existing routing keys remain unchanged:

- `register` carries `(user_id, device_id)`. Same `device_id` on different relays is the design — no cross-relay coordination is required.
- `peer_candidates` is per-user opt-in eligibility; sent identically to every relay.
- `webrtc_signal` routes by `(peer_user_id, peer_device_id)`. Two relays both routing for the same `(userId, deviceId)` pair converge on the same WebRTC state because the keys are identical.
- `queue_peer_envelope` deduplicates by `envelope.id` per recipient (PER_RECIPIENT_ENVELOPE_LIMIT keeps it bounded), and the receiver's `processed_peer_message_ids` deduplicates again at the app layer.

In short: the server protocol is already **idempotent on `(userId, deviceId, envelopeId)` triples**, so any operation is safe to run through multiple relays simultaneously. This is what makes the design tractable.

---

## Design

### 1. Relay pool, not single client

`signaling/socket-client.js` exports `createSignalingClient(callbacks)`. A new module — `signaling/relay-pool.js` — wraps N instances of it and exposes the same callback surface to `peer/client.js`. The pool:

- Holds an array of `{ url, signalingClient, status, lastConnectedAt }`.
- Multiplexes outbound calls (`setSession`, `requestPeerConnection`, `sendPeerSignal`, `queuePeerEnvelopeOnServer`) to every connected relay.
- Funnels inbound callbacks (`onPeerConnect`, `onPeerDisconnect`, `onPeerSignal`, `onPeerEnvelopeFromServer`, `onSessionReady`, `onQueueDrained`) into a single callback per event after de-duplication.
- Exposes a `getRelayStatuses()` accessor for the settings UI.

`peer/client.js` continues to talk to a single object — the pool replaces the singleton client and otherwise no changes are needed there.

### 2. Connect to all relays in parallel at startup

Serial connection cascades (try A, then ask B for the gaps) sound bandwidth-efficient but create more problems than they solve:

- Friend goes offline on A → client must now query B, C, D. The cascade becomes stateful and rebuilds on every disconnect.
- WebRTC signalling is bidirectional. Cascade order on the sender does not match cascade order on the receiver. The two halves of the handshake can race over different relays.
- Startup latency is `sum(connect_time)` instead of `max(connect_time)`.

Parallel is simpler and the bandwidth cost is trivial:

- 5 WebSockets × a few KB of `peer_candidates` + handshake = ~tens of KB at startup.
- Once connected, ongoing traffic is dominated by application envelopes — and those go through one relay (offline) or zero (online via WebRTC), not all five.

**Recommendation: parallel connect, full registration on every relay.**

### 3. Ask all relays for all friends

Same reasoning as §2. Each relay independently fires `peer_connect` for whichever friends it sees online. The pool passes every `peer_connect` through and lets the mesh collapse duplicates via its composite key `(peerUserId, peerDeviceId)`, which already exists for multi-device support (TIP-001 era work).

If a friend is online on relays {A, C} and not B, the pool receives two `peer_connect` events for the same `(userId, deviceId)` pair. The mesh's `ensurePeer` short-circuits on the second call. No race, no duplicate WebRTC handshake. The pool must **not** swallow a `peer_connect` just because the peer is already present: relays re-send one when a client asks to re-pair after a dropped WebRTC connection (e.g. wake from suspend), and that is the only way the pair reconnects while both stay registered.

If a friend disconnects on A, the pool receives a `peer_disconnect` from A — but only counts the peer as truly offline once **all** relays that previously announced them have reported the disconnect (or have themselves gone down). This requires the pool to track, per `(userId, deviceId)`, the set of relays that currently report the peer online.

**Recommendation: ask every relay, track per-relay presence, treat the union as truth.**

### 4. Queue offline envelopes on every relay

For an offline recipient: send `queue_peer_envelope` to every connected relay. Cost: `N × envelope_size` extra storage across N relays; envelopes are ~1–2 KB and already capped at 500 per recipient per relay. Benefit: delivery survives the recipient choosing any one of the queued relays first.

The recipient receives the same envelope from each of their relays that happens to overlap with a sender relay. `processed_peer_message_ids` dedupes. Receipts (`MessageType.RECEIVED`) are themselves envelopes, so the same multi-relay path applies.

Cleanup after delivery: each relay independently drops its copy once the recipient connects to that relay. Relays the recipient never connects to hold the envelope until the 500-cap evicts it. Acceptable.

**Recommendation: queue on every connected relay.**

### 5. WebRTC signalling

`sendPeerSignal(peerUserId, peerDeviceId, signal)` is broadcast to every relay. The receiving client may get the same ICE candidate or SDP offer through multiple relays:

- Duplicate offer / answer: perfect-negotiation already handles redundant signals — the second is a no-op.
- Duplicate ICE candidate: WebRTC accepts and silently de-dupes.

For the initial offer, the initiator is chosen by `getInitiatorClient` — deterministic by `(userId, deviceId)` ordering. Every relay computes the same initiator, so both endpoints agree regardless of which relay triggered the handshake first.

### 6. Same-user multi-device across relays

Each device has a stable `device_id`. Device A on relays {X, Y} and device B on relays {Y, Z} share Y → their self-mesh works through Y (signaling, plus the relay fallback for self-sync when WebRTC can't connect — see [spec-peer-communication](../../design/spec-peer-communication.html) §13.8). If they have no relay in common they cannot signal at all and cannot sync ledger state. This is a configuration concern, not a protocol failure: the UI should warn the user when a device's relay set has no overlap with another device's relay set.

### 7. Settings UI

A new section on the settings page: **Relays**.

- Default list (1–3 entries) seeded on first run from a constants file shipped with the app.
- Add: text field for a `wss://host/ws` URL → connection attempt → result indicator.
- Remove: trash icon per row. Disabled if it is the last remaining relay.
- Status per relay: green (connected), amber (reconnecting), grey (manually disabled), red (failed handshake).
- Each row shows `last_connected_at`.

Persistence: `state.user.relays` as an array of `{ url, enabled }` objects, normalised in `data-model.ts`.

### 8. Default relay set

On first launch the app populates `state.user.relays` from a small hardcoded list in the bundle (e.g. `["wss://iou-ui.up.railway.app/ws"]` plus future additions). This is the bootstrap network effect — every fresh install joins the default mesh and is discoverable by anyone else on the same default. Power users can prune the defaults later.

### 9. Friend's relay set is private

Clients do not exchange relay lists with friends. Discoverability is purely a function of "do our chosen relays happen to overlap." This keeps the relay choice a private metadata-routing decision. The cost is the asymmetric-relay-set failure mode (see §6 and Open Questions).

---

## Performance Summary

| Concern | Cost at N=5 relays | Mitigation |
|---------|--------------------|------------|
| Startup latency | `max(connect_time)` ≈ same as today | Parallel connect |
| Memory (client) | 5 × WebSocket state ≈ negligible | — |
| Memory (relay) | Unchanged per relay (each thinks it's the only one) | — |
| Network on relay register | 5 × (tens of KB) ≈ low | — |
| Envelope storage | 5 × per relay × cap of 500 | Existing eviction |
| WebRTC handshake | Duplicate signals → no-op | Perfect negotiation already idempotent |
| Steady-state | Heartbeat / reconnect only | Dominant traffic stays on WebRTC |

Performance is not the bottleneck of this design. The bottlenecks are configuration (asymmetric relay sets, §6) and operator trust (Trust Model).

---

## Complexity Summary

What is easy in the current code base:

- **Friend mesh** is already keyed by `(peerUserId, peerDeviceId)` — handles N relays "for free."
- **Envelope dedup** already exists (`processed_peer_message_ids`) — handles N relays.
- **Outbox** in `peer/outbox.js` already deals with retry — fan-out to N relays is a one-line change in `queuePeerEnvelopeOnServer`.
- **Signaling client** is a closure with a clean callback surface — instantiating N of them is straightforward.

What was new:

- `relay-pool.js` (~150 LOC).
- Settings UI for relay list.
- Schema field on `state.user.relays` + normaliser entry in `data-model.ts`.
- Presence union: per-relay tracking of which relay reports each peer online.

What did not need to change:

- Server code (`websocket-server.js`) — already idempotent per the protocol property.
- `peer/client.js` — same singleton-shaped interface, just behind a pool.
- WebRTC negotiation logic.
- Ledger / commands.

---

## Security Analysis

### Adding a malicious relay

The biggest user-facing risk is the user adding a relay that is hostile. That relay sees:

- The user's `npub` and `device_id`.
- The `peer_candidates` list (who the user is willing to peer with).
- Every SDP / ICE blob — i.e. WebRTC connection partners and times.
- Every queued envelope's `from_user_id`, `to_user_id`, `id`, and ciphertext size.

It cannot forge content, read plaintext, or impersonate, but it can:

- Drop messages — other relays still deliver.
- Refuse to register the user — other relays still register them.
- Aggregate metadata indefinitely.

A malicious relay controls the signalling channel and can substitute its own DTLS fingerprint into SDP offers and answers, technically allowing it to terminate both DTLS sessions. However, what it then sees inside the data channel is still useless: every envelope is encrypted to the recipient's public key and signed with the sender's private key. The relay gets ciphertext it cannot read and cannot forge without the private keys. DTLS MITM provides no capability beyond what the relay can already do as a message-drop proxy. The application-layer crypto completely nullifies it. The security boundary is: **relay is trusted for availability and metadata, not for confidentiality or authenticity.**

Mitigation: explicit per-relay confirmation in the UI when adding ("This relay will see your device ID and friend list. Continue?"), and labelling defaults as "recommended" rather than mandatory.

### Relay fingerprinting / pinning

Out of scope for v1. A future TIP could add a signed relay identity (server publishes a stable pubkey, client pins on first add). For now, the URL is the identity.

### Same envelope through multiple relays

Already handled by `processed_peer_message_ids`. No new attack surface.

### Receipts and outbox cleanup

`MessageType.RECEIVED` receipts flow back through every relay too. Sender's outbox removal triggers on first valid receipt and is idempotent.

### Origin restriction on `/ws`

Currently absent (any origin can open the WebSocket). Secondary relays may want to apply origin restrictions to mitigate CSRF-style abuse from third-party pages. Worth noting but orthogonal to this TIP.

---

## Open Questions

1. **Asymmetric relay sets between friends.** If user A is on {X, Y} and friend B is on {Z}, they cannot signal each other at all. Possible mitigations:
   - Defaults remain large enough that "no overlap" is rare in practice.
   - Out-of-band relay-set exchange during friend-add (paste a small relay-hint block into the QR code / link). Leaks relay choice but only to chosen friends.
   - A "discovery relay" that publishes relay lists per `userId`. Reintroduces a central point.
   The cleanest answer in v1 is probably: large overlapping defaults + UI warning when no overlap with a specific friend is detected.

2. **TURN / STUN servers.** WebRTC needs ICE servers for NAT traversal. TURN config is independent of relay list — tying them together would force every relay operator to also run a TURN server, which is a much higher bar. TURN servers should be a separate list in settings (defaulting to a few well-known public STUN servers and optionally a self-hosted TURN). This is a separate settings section from relays.

   > **Resolved since.** ICE servers did become their own settings section, but TURN was dropped entirely rather than made configurable: the encrypted-envelope relay already store-and-forwards for peers that cannot form a direct connection, which is the need TURN would have covered. Settings now holds a STUN-only list defaulting to Cloudflare. See [Communication](../../design/communication.html).

3. **Relay reputation / discovery.** Beyond defaults shipped in the bundle, how does a user learn about new relays? A list page? A friend recommending one? Out of scope for v1; ship with curated defaults.

4. **Backwards compatibility.** Old single-relay clients will continue to work as long as they are connected to a relay also in the new client's set. Otherwise they are invisible. No protocol change is needed; this is a population-overlap issue.

5. **Cost of a failing relay.** If a relay is reachable but malfunctioning (accepts connection, drops messages silently), the pool currently has no health probe beyond ping. A periodic round-trip test (send an addressed self-envelope and check delivery time) could surface this. Defer to v2.

6. **App bundle distribution.** The user mentioned the current server also serves the app files. Should the bundle be served from a CDN independent of the relay list? This is desirable long-term (the app then has no privileged origin) but doesn't block this TIP.

7. **Same-user multi-device convergence.** §6 — should the app refuse to be added as a second device unless the new device shares at least one relay with the existing device's relay set? Probably yes, with a clear error message.

8. **Settings-page ordering.** When the user has 5 relays, is there a priority order? For envelope queue and signal broadcast we treat all relays equally. For `requestPeerConnection` we also broadcast. So priority is cosmetic only, and the UI can leave it as insertion order.

9. **Per-friend relay scoping.** Should a user be able to say "use relay X only for friend group A"? Adds significant complexity and runs against the simpler "all relays are interchangeable" model. Defer indefinitely unless there's a clear use case.

---

## §10 — Telling Friends What Relays You Use (Phase 1)

### What shipped

- `state.share_my_relays: boolean` — defaults to `true`. User toggles it in settings.
- `friends[].relays: string[]` — schema field in place, ready to receive data from Phase 2.
- Settings toggle bound to the flag: "Tell friends what relays you use".

Phase 2 (the actual `my_relays` message exchange) and Phase 3 (refinements) are tracked separately in TIP-003-relay-sharing.md.

---

## Implementation Notes

**Schema (`data-model.ts`)**
- Added `state.user.relays: Array<{ url: string, enabled: boolean }>` with default seeded from `constants.RELAY_DEFAULTS`.
- Normaliser: trim URLs, deduplicate, drop entries that don't parse as `wss://…/ws`.

**New module: `app/js/signaling/relay-pool.js`**
- `createRelayPool({ relays, callbacks }) → { setSession, requestPeerConnection, sendPeerSignal, queuePeerEnvelopeOnServer, getStatuses, destroy }`.
- Internally: N × `createSignalingClient`, presence union tracked as `Map<peerKey, Set<relayUrl>>`.
- Emits `onPeerDisconnect` only when the last relay reporting that peer disconnects.

**`peer/client.js`**
- Replaced `createSignalingClient(…)` with `createRelayPool({ relays: snapshot.relays, callbacks: … })`.
- `setSession` now also passes the relay list; pool reconciles add/remove against current connections.

**Settings UI (`app/ui-modules/settings-page`)**
- New row group for relays. Reuses existing settings row styling.
- Live status read from relay-status-registry on data change.

**Defaults**
- `app/js/constants/relay-defaults.js` exports the default list.

---

## Out of Scope

- Signed relay identity / TOFU pinning (future TIP).
- Cross-relay envelope ordering guarantees beyond what the recipient's local `processed_peer_message_ids` provides.
- A directory or discovery service for new relays.
