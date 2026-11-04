/*
 * pages.js — the ordered index of every page in the Design site.
 *
 * This is the one piece of shared state across the standalone HTML pages: it
 * lets design.js build the same sidebar table of contents on every page without
 * each page having to list its siblings. Defined as a plain global (not fetched)
 * so the site works when opened directly from disk (file://) as well as served.
 *
 * Each entry: { href, title, status, group }. `status` uses the site
 * convention — implemented | planned | proposal | reference. An entry with no
 * `group` (Overview) sits at the very top, always visible. Groups are the
 * project's anatomy; the first page in each is its authored intro, followed by
 * the pages that fill it in.
 *
 * Every page, the TIPs included, is authored HTML edited directly in design/.
 * TIP entries also carry a one-line `summary`, shown on the TODO page; their
 * order there lives in assets/tip-order.js.
 */

window.DESIGN_PAGES = [
  { href: "index.html", title: "Overview", status: "reference" },

  { group: "Purpose", href: "purpose.html", title: "Purpose", status: "reference" },
  { group: "Purpose", href: "related-work.html", title: "Related work", status: "reference" },
  { group: "Purpose", href: "plan-idea.html", title: "Original idea notes", status: "reference" },

  { group: "Glossary", href: "glossary.html", title: "Glossary", status: "reference" },

  { group: "UI", href: "ui.html", title: "UI", status: "reference" },
  { group: "UI", href: "render-flow.html", title: "Render flow", status: "reference" },

  { group: "P2P", href: "p2p.html", title: "P2P", status: "reference" },
  { group: "P2P", href: "spec-ledger.html", title: "Ledger", status: "reference" },
  { group: "P2P", href: "friendship-default.html", title: "Defaulting", status: "implemented" },
  { group: "P2P", href: "recurring-payments.html", title: "Recurring payments", status: "implemented" },
  { group: "P2P", href: "spec-data-storage.html", title: "Data storage", status: "reference" },
  { group: "P2P", href: "communication.html", title: "Communication", status: "reference" },
  { group: "P2P", href: "spec-peer-communication.html", title: "Peer communication", status: "reference" },

  { group: "Security", href: "security.html", title: "Security", status: "reference" },
  { group: "Security", href: "plan-performance.html", title: "Performance", status: "reference" },

  { group: "TIPs", href: "tips.html", title: "TIPs", status: "reference" },
  { group: "TIPs", href: "tips-todo.html", title: "TODO", status: "reference" },
  { group: "TIPs", href: "ordered-ledgers.html", title: "Should ledgers be ordered?", status: "reference" },
  { group: "TIPs", href: "tip-1-user-merge.html", title: "TIP-1 User merge", status: "proposal",
    summary: "Merge two of your identities into one; friends move over to the new key." },
  { group: "TIPs", href: "tip-2-circular-cancellation.html", title: "TIP-2 Circular cancellation", status: "proposal",
    summary: "Cancel a cycle of debts (A→B→C→A) without any money changing hands." },
  { group: "TIPs", href: "tip-3-multiple-relay-servers.html", title: "TIP-3 Multiple relay servers", status: "implemented",
    summary: "Use several relay servers at once, so no single relay is needed." },
  { group: "TIPs", href: "tip-3-relay-sharing.html", title: "TIP-3 Relay sharing (cont.)", status: "proposal",
    summary: "Friends share their relay lists, so you can pick ones popular among them." },
  { group: "TIPs", href: "tip-4-offline-friend-claims.html", title: "TIP-4 Offline friend claims", status: "proposal",
    summary: "Record a debt to someone not yet on Tally; they claim it with an emailed link." },
  { group: "TIPs", href: "tip-5-os-notifications.html", title: "TIP-5 OS notifications", status: "implemented",
    summary: "End-to-end encrypted Web Push notifications." },
  { group: "TIPs", href: "tip-6-external-nostr-key-storage.html", title: "TIP-6 External Nostr key storage", status: "implemented",
    summary: "Keep the Nostr key outside the app, in a NIP-07 extension." },
  { group: "TIPs", href: "tip-6-remote-signers.html", title: "TIP-6 Remote signers (cont.)", status: "proposal",
    summary: "Sign with a NIP-46 remote signer or a NIP-55 Android signer app." },
  { group: "TIPs", href: "tip-7-routed-payments.html", title: "TIP-7 Routed payments", status: "proposal",
    summary: "Pay a non-friend through a chain of mutual friends, all or nothing." },
  { group: "TIPs", href: "tip-8-bilateral-checkpoints.html", title: "TIP-8 Bilateral checkpoints", status: "proposal",
    summary: "Friends co-sign balance checkpoints so older history can be archived." },
  { group: "TIPs", href: "tip-9-offline-intermediaries.html", title: "TIP-9 Offline intermediaries", status: "proposal",
    summary: "Pre-signed routing budgets let a routed payment pass through an offline friend." },

  { group: "Tooling", href: "tooling.html", title: "Tooling", status: "reference" },
  { group: "Tooling", href: "build.html", title: "Build & runtime", status: "reference" },
  { group: "Tooling", href: "design-roadmap.html", title: "Design roadmap", status: "proposal" },
];
