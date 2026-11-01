# Tally — Create Your Own Money

A peer-to-peer IOU app that records debts and trust between friends. Debts live
on users' own devices, and trust limits let them extend to strangers — as long
as there is a route of trusted friends in between.

*(The project was formerly called "IOU"; the name survives in package names and
in `iou_` storage keys.)*

## Why

Money, in its essence, is bookkeeping that tracks good deeds owed back. Tally
returns money to that root by basing it on personal loans that can be extended
to strangers along a route of trusted friends. This relatively basic
functionality can become the basis for a whole monetary system — returning the
control, and the responsibility, of money from governments and banks back to
people.

## Try it out

https://tally.earth

Development is at an early stage, so don't use it to transact large amounts yet.
Also back up your data regularly when in active use, to avoid catastrophes.

## How it works

Users create an identity (a Nostr keypair), add friends by exchanging public
keys via QR code or copy-paste, and send IOUs over direct WebRTC data channels.

There is no central ledger. Each client stores its own state in IndexedDB and
reconciles with peers when both are online. Messages that can't be delivered
immediately are queued in an outbox, held by a relay server as encrypted
envelopes, and retried on reconnection.

Routed payments — paying someone you don't know through a route of mutual
friends — are the idea the whole design is aimed at, and are **not implemented
yet**. See [Purpose](design/purpose.html) for how they work and
[TIP-7](design/tip-7-routed-payments.html) for the design in progress.

## Documentation

Everything beyond this page lives in **[Design](design/index.html)** — a
cross-linked, text-first documentation site covering purpose, the glossary, the
UI, the peer-to-peer core, security, and tooling. Open `design/index.html`
straight from disk, or browse it at https://tally.earth/design.

Start with [Overview](design/index.html), or jump to:

| | |
|---|---|
| [Purpose](design/purpose.html) | why Tally exists; the trust economics |
| [Glossary](design/glossary.html) | the shared vocabulary |
| [P2P](design/p2p.html) | the ledger, state, storage |
| [Communication](design/communication.html) | how peers connect and sync |
| [Security](design/security.html) | identity, keys, encryption |
| [Build & runtime](design/build.html) | the build, the service worker, versions |

Non-trivial changes get a **TIP** (Tally Improvement Proposal) under
[Design](design/tips.html); the [TODO](design/tips-todo.html) page ranks the ones not yet built.

## Current features

- Send and receive IOUs between friends
- QR code generation and scanning for adding friends and receiving payments
- Trust limits between friends (credit agreements)
- Payment requests
- Real-time peer status (direct / via relay / offline)
- Multiple user-chosen relay servers
- Transaction history and activity logs
- Optional OS notifications via encrypted Web Push
- External key storage via a NIP-07 browser extension
- Installable PWA that works offline; works on mobile browsers

## Roadmap

- Routed payments ([TIP-7](design/tip-7-routed-payments.html))
- Circular debt cancellation — if A owes B, B owes C, and C owes A, cancel the
  loop ([TIP-2](design/tip-2-circular-cancellation.html))
- Currencies other than euros — anything users agree to transact in
- A "marketplace": personal exchange rates between currencies
- Fees on routed payments (see
  [the original idea notes](design/plan-idea.html))

## Architecture

```
Browser A  <──WebRTC DataChannel──>  Browser B
    \                                    /
     \──WebSocket──> Relay <──WebSocket/
```

- **Client** — vanilla JS/TS progressive web app, transpiled per-file by esbuild
  into `app/dist/`. No framework, no bundle.
- **Server** — Node.js. Serves static files and runs a WebSocket relay. No
  database; it holds presence and a short queue of envelopes it cannot read.
- **Transport** — WebRTC data channels carry encrypted JSON; STUN helps peers
  connect across networks. There is deliberately **no TURN server** — the relay
  already covers the case where a direct connection can't form.
- **Identity** — Nostr keys (npub/nsec). Existing Nostr keys can be imported, or
  kept in a NIP-07 extension.
- **Storage** — IndexedDB on each client, one root state object. All long-term
  data stays on clients.

[Communication](design/communication.html) and
[Peer communication](design/spec-peer-communication.html) go into detail.

## Getting started

### Development

```bash
npm install
npm run dev
```

Starts the client build in watch mode and the server on `http://localhost:3000`.
`npm run devAll` also brings up Design, GraphEditor and the landing site.

### Production

```bash
npm run build && node server/server.js
```

`app/dist/` is build output and is not committed, so the build step is required.
Or with Docker, which does both:

```bash
docker build -t tally .
docker run -p 8080:8080 tally
```

## Tests

```bash
npm run test:e2e:two-client
npm run test:e2e:friend-request-online
npm run test:e2e:reload-reconnect
npm run typecheck
```

The end-to-end tests use Playwright to run two browser instances against a local
server, exercising friend requests, messaging and reconnection. `npm run peer`
drives a headless second user for manual testing — see
[Tooling](design/tooling.html).
