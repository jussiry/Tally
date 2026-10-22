/*
 * build-docs.mjs — repeatable build that renders the TIP Markdown documents
 * into Design HTML pages using the shared shell.
 *
 * TIPs are the only generated pages: their Markdown under TIPs/ stays the
 * source of truth, and every rebuild overwrites design/tip-*.html wholesale.
 * Anything a generated page needs beyond its Markdown — the status badge, the
 * GraphEditor file list — therefore has to live in the DOCS table below, not in
 * the HTML, or the next run drops it.
 *
 * The Markdown subset covered is what these docs actually use: headings,
 * paragraphs, ul/ol (incl. nesting), tables, fenced + inline code, bold/italic,
 * links, block quotes, and horizontal rules.
 *
 * Run:  node design/scripts/build-docs.mjs
 * It writes design/<name>.html for each entry and prints manifest lines to
 * paste into design/assets/pages.js.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DESIGN = join(ROOT, "design");

// ---- Markdown → HTML (small, dependency-free) ---------------------------

const escapeHtml = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, "&quot;");

function inline(src) {
  const codes = [];
  let s = String(src).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return "\u0000" + (codes.length - 1) + "\u0000";
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${escapeAttr(u)}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\s][^*]*?)\*/g, "<em>$1</em>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${escapeHtml(codes[n])}</code>`);
  return s;
}

function parseList(lines, start) {
  const indent = lines[start].match(/^(\s*)/)[1].length;
  const ordered = /^\s*\d+\.\s/.test(lines[start]);
  let i = start;
  let out = ordered ? "<ol>" : "<ul>";
  while (i < lines.length) {
    if (/^\s*$/.test(lines[i])) { i++; continue; }
    const m = lines[i].match(/^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/);
    if (!m) break;
    const ind = m[1].length;
    if (ind < indent) break;
    if (ind > indent) {
      const [nested, ni] = parseList(lines, i);
      out = out.replace(/<\/li>$/, nested + "</li>");
      i = ni;
      continue;
    }
    const item = [m[2]];
    i++;
    // Lazy continuation: a wrapped list item's later lines are indented past
    // the marker. Without folding them back into the <li> they escape as their
    // own paragraph, and any inline span (**bold**, `code`) split across the
    // wrap is left unclosed.
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*(?:[-*+]|\d+\.)\s/.test(lines[i]) &&
      lines[i].match(/^(\s*)/)[1].length > indent
    ) {
      item.push(lines[i].trim());
      i++;
    }
    out += `<li>${inline(item.join(" "))}</li>`;
  }
  return [out + (ordered ? "</ol>" : "</ul>"), i];
}

function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const isBlockStart = (l) =>
    /^\s*$/.test(l) || /^#{1,6}\s/.test(l) || /^```/.test(l) || /^\s*>/.test(l) ||
    /^\s*(?:[-*+]|\d+\.)\s/.test(l) || /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }

    if (/^```/.test(line)) {
      i++;
      const buf = [];
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push("<hr />"); i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2].trim())}</h${h[1].length}>`); i++; continue; }

    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${mdToHtml(buf.join("\n"))}</blockquote>`);
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const row = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = row(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") rows.push(row(lines[i++]));
      let t = '<div class="table-scroll"><table><thead><tr>' + header.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
      for (const r of rows) t += "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
      out.push(t + "</tbody></table></div>");
      continue;
    }

    if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) {
      const [listHtml, ni] = parseList(lines, i);
      out.push(listHtml);
      i = ni;
      continue;
    }

    const buf = [line];
    i++;
    while (i < lines.length && !isBlockStart(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

// ---- Page template ------------------------------------------------------

function wrap({ title, status, files, body }) {
  // data-files is what design.js turns into the "open in GraphEditor" button.
  // It belongs to the page, not to the Markdown, so it comes from DOCS.
  const fileList = files
    ? `\n    data-files="${escapeAttr(files.join(" "))}"`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — Design</title>
  <link rel="stylesheet" href="assets/design.css" />
</head>
<body>
  <main class="page" data-status="${status}"${fileList}>
${body}
  </main>
  <script src="assets/pages.js"></script>
  <script src="assets/design.js"></script>
</body>
</html>
`;
}

// ---- What to build ------------------------------------------------------

const DOCS = [
  { src: "TIPs/README.md", out: "tips.html", title: "TIPs", status: "reference", group: "TIPs" },
  {
    src: "TIPs/TIP-001-user-merge.md", out: "tip-001-user-merge.html",
    title: "TIP-001 User merge", status: "proposal", group: "TIPs",
    files: ["js/commands/user.js", "js/commands/friendship.js", "js/models/data-model.ts",
      "js/peer/authorship.js", "js/storage/migrations.ts", "js/utils/nostr-keys.js",
      "js/crypto/key-provider.js"],
  },
  {
    src: "TIPs/TIP-002-circular-cancellation.md", out: "tip-002-circular-cancellation.html",
    title: "TIP-002 Circular cancellation", status: "proposal", group: "TIPs",
    files: ["js/commands/transaction.js", "js/ledger.ts", "js/utils/friendships.js",
      "js/friends-helpers.js", "js/peer/authorship.js", "js/crypto/canonical.js"],
  },
  {
    src: "TIPs/implemented/TIP-003-multiple-relay-servers.md", out: "tip-003-multiple-relay-servers.html",
    title: "TIP-003 Multiple relay servers", status: "implemented", group: "TIPs",
    files: ["js/signaling/relay-pool.js", "js/signaling/relay-status-registry.js",
      "js/signaling/socket-client.js", "js/commands/relays.js", "js/utils/relay-url.js",
      "js/peer/outbox.js", "js/peer/envelope.js", "js/peer/bridge.js"],
  },
  {
    src: "TIPs/TIP-003-relay-sharing.md", out: "tip-003-relay-sharing.html",
    title: "TIP-003 Relay sharing (cont.)", status: "proposal", group: "TIPs",
    files: ["js/commands/relays.js", "js/peer/messages.js", "js/peer/handlers.js",
      "js/models/data-model.ts", "js/signaling/relay-pool.js", "js/utils/relay-url.js",
      "ui-modules/settings-page/index.js"],
  },
  {
    src: "TIPs/TIP-004-offline-friend-claims.md", out: "tip-004-offline-friend-claims.html",
    title: "TIP-004 Offline friend claims", status: "proposal", group: "TIPs",
    files: ["js/commands/transaction.js", "js/commands/friendship.js", "js/peer/authorship.js",
      "js/crypto/canonical.js", "js/crypto/nostr-event.js", "js/models/data-model.ts",
      "ui-modules/subpage/add-friend.js", "js/utils/qr-uri.js"],
  },
  {
    src: "TIPs/TIP-005-os-notifications.md", out: "tip-005-os-notifications.html",
    title: "TIP-005 OS notifications", status: "proposal", group: "TIPs",
    files: ["js/notify/notification-policy.js", "js/push/push-subscribe.js", "sw.js",
      "js/peer/handlers.js", "js/ui/notifications.js", "js/commands/transaction.js",
      "js/commands/payment-request.js", "js/commands/friendship.js",
      "js/notify/notification-prefs.js", "js/commands/notification-prefs.js",
      "js/notify/local-os-notification.js", "ui-modules/subpage/notifications.js"],
  },
  {
    src: "TIPs/implemented/TIP-006-external-nostr-key-storage.md", out: "tip-006-external-nostr-key-storage.html",
    title: "TIP-006 External Nostr key storage", status: "implemented", group: "TIPs",
    files: ["js/crypto/key-provider.js", "js/crypto/nip44.js", "js/crypto/nip49.js",
      "js/crypto/nostr-event.js", "js/crypto/canonical.js", "js/crypto/peer-crypto.js",
      "js/peer/authorship.js", "js/peer/envelope.js", "js/utils/nostr-keys.js"],
  },
  {
    src: "TIPs/TIP-006-remote-signers.md", out: "tip-006-remote-signers.html",
    title: "TIP-006 Remote signers (cont.)", status: "proposal", group: "TIPs",
    files: ["js/crypto/key-provider.js", "js/crypto/nip44.js", "js/crypto/nostr-event.js",
      "js/peer/authorship.js", "js/crypto/peer-crypto.js"],
  },
  {
    src: "TIPs/TIP-007-routed-payments.md", out: "tip-007-routed-payments.html",
    title: "TIP-007 Routed payments", status: "proposal", group: "TIPs",
    files: ["js/commands/transaction.js", "js/ledger.ts", "js/peer/authorship.js",
      "js/crypto/canonical.js", "js/peer/messages.js", "js/models/data-model.ts"],
  },
  {
    src: "TIPs/TIP-008-bilateral-checkpoints.md", out: "tip-008-bilateral-checkpoints.html",
    title: "TIP-008 Bilateral checkpoints", status: "proposal", group: "TIPs",
    files: ["js/ledger.ts", "js/peer/authorship.js", "js/peer/client.js",
      "js/peer/bridge.js", "js/peer/handlers.js", "js/crypto/canonical.js"],
  },
  {
    src: "TIPs/TIP-009-offline-intermediaries.md", out: "tip-009-offline-intermediaries.html",
    title: "TIP-009 Offline intermediaries", status: "proposal", group: "TIPs",
    files: ["js/commands/trust-limit.js", "js/commands/transaction.js", "js/peer/authorship.js",
      "js/ledger.ts", "js/utils/friendships.js", "sw.js"],
  },
];

// ---- Cross-link rewriting ------------------------------------------------
// Source Markdown links to sibling docs the way they resolve *in the repo*
// ("TIP-002-….md", "implemented/TIP-003-….md", "../design/purpose.html"). In the
// Design site every page is flat in design/, so those hrefs are rewritten to
// the built page name. Anything unknown (external URLs, source files) is left
// alone.

const BUILT = new Map(DOCS.map((d) => [d.src, d.out]));

const rewriteHref = (href, srcDir) => {
  if (/^(https?:|#|mailto:)/.test(href)) return href;
  const [path, hash = ""] = href.split("#");
  const repoPath = posix.normalize(posix.join(srcDir, path));
  if (BUILT.has(repoPath)) return BUILT.get(repoPath) + (hash && "#" + hash);
  if (repoPath.startsWith("design/")) return repoPath.slice("design/".length) + (hash && "#" + hash);
  return href;
};

const manifest = [];
for (const d of DOCS) {
  if (!existsSync(join(ROOT, d.src))) {
    console.log("MISSING " + d.src + " — design/" + d.out + " left untouched");
    continue;
  }
  const md = readFileSync(join(ROOT, d.src), "utf8");
  const srcDir = posix.dirname(d.src);
  const html = wrap({
    title: d.title,
    status: d.status,
    files: d.files,
    body: mdToHtml(md).replace(/href="([^"]+)"/g, (m, href) => `href="${rewriteHref(href, srcDir)}"`),
  });
  writeFileSync(join(DESIGN, d.out), html);
  manifest.push(`  { group: ${JSON.stringify(d.group)}, href: ${JSON.stringify(d.out)}, title: ${JSON.stringify(d.title)}, status: ${JSON.stringify(d.status)} },`);
  console.log("wrote design/" + d.out);
}
console.log("\n--- manifest entries (for pages.js) ---\n" + manifest.join("\n"));
