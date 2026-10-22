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
 * The TIP pages are generated from TIPs/*.md by design/scripts/build-docs.mjs —
 * re-run it after those change and keep the entries below in sync with its
 * output. Every other page, the imported spec and plan ones included, is
 * authored HTML edited directly in design/.
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
  { group: "P2P", href: "spec-data-storage.html", title: "Data storage", status: "reference" },
  { group: "P2P", href: "communication.html", title: "Communication", status: "reference" },
  { group: "P2P", href: "spec-peer-communication.html", title: "Peer communication", status: "reference" },

  { group: "Security", href: "security.html", title: "Security", status: "reference" },
  { group: "Security", href: "plan-performance.html", title: "Performance", status: "reference" },

  { group: "TIPs", href: "tips.html", title: "TIPs", status: "reference" },
  { group: "TIPs", href: "tip-001-user-merge.html", title: "TIP-001 User merge", status: "proposal" },
  { group: "TIPs", href: "tip-002-circular-cancellation.html", title: "TIP-002 Circular cancellation", status: "proposal" },
  { group: "TIPs", href: "tip-003-multiple-relay-servers.html", title: "TIP-003 Multiple relay servers", status: "implemented" },
  { group: "TIPs", href: "tip-003-relay-sharing.html", title: "TIP-003 Relay sharing (cont.)", status: "proposal" },
  { group: "TIPs", href: "tip-004-offline-friend-claims.html", title: "TIP-004 Offline friend claims", status: "proposal" },
  { group: "TIPs", href: "tip-005-os-notifications.html", title: "TIP-005 OS notifications", status: "proposal" },
  { group: "TIPs", href: "tip-006-external-nostr-key-storage.html", title: "TIP-006 External Nostr key storage", status: "implemented" },
  { group: "TIPs", href: "tip-006-remote-signers.html", title: "TIP-006 Remote signers (cont.)", status: "proposal" },
  { group: "TIPs", href: "tip-007-routed-payments.html", title: "TIP-007 Routed payments", status: "proposal" },
  { group: "TIPs", href: "tip-008-bilateral-checkpoints.html", title: "TIP-008 Bilateral checkpoints", status: "proposal" },
  { group: "TIPs", href: "tip-009-offline-intermediaries.html", title: "TIP-009 Offline intermediaries", status: "proposal" },

  { group: "Tooling", href: "tooling.html", title: "Tooling", status: "reference" },
  { group: "Tooling", href: "build.html", title: "Build & runtime", status: "reference" },
  { group: "Tooling", href: "design-roadmap.html", title: "Design roadmap", status: "proposal" },
];
