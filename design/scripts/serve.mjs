/**
 * serve.mjs — dev server for the Design site.
 *
 * Two reasons the Design site needs a real server (rather than being opened
 * from disk):
 *   1. The sidebar search fetches every page's HTML to build its index —
 *      cross-document fetch is blocked on the file:// origin, so search shows
 *      nothing when the docs are opened straight from the filesystem.
 *   2. Inline editing (see assets/design.js) POSTs edited markdown back to the
 *      source .html file via the /api/save endpoint below, and the TODO page
 *      saves its TIP ranking via /api/tip-order. These are switched on only by
 *      the flag this server injects into the pages it serves, so the public
 *      copy of the site stays read-only.
 *
 * Static files are served from design/. Clean URLs work too: a path with no
 * extension falls back to "<path>.html" (so /purpose and /purpose.html both
 * serve purpose.html, and search's fetch("purpose.html") gets a direct 200).
 *
 * Usage: node design/scripts/serve.mjs [port]   (default 4000)
 * PORT env var wins over the CLI arg so an autoPort launcher can pick a free
 * port without colliding with a hardcoded one.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, normalize, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..')); // design/
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 4000;

const AUTHORING_FLAG = '<script>window.DESIGN_AUTHORING = true;</script>\n  ';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// Resolve a request path to an absolute file inside ROOT, or null if it escapes
// ROOT. Path traversal is blocked by rejecting anything that resolves outside.
function safeResolve(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const abs = resolve(join(ROOT, clean));
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null;
  return abs;
}

async function readBody(req, limit = 5_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);

  // --- Save endpoint: overwrite a design HTML file with edited content. ------
  // Used by inline editing. Only .html files directly inside design/ may be
  // written, and only files that already exist (no creating new paths).
  if (req.method === 'POST' && path === '/api/save') {
    try {
      const { file, html } = JSON.parse(await readBody(req));
      if (typeof file !== 'string' || typeof html !== 'string') {
        return json(res, 400, { ok: false, error: 'file and html required' });
      }
      const base = file.split('/').pop() || '';
      if (!/^[a-z0-9._-]+\.html$/i.test(base)) {
        return json(res, 400, { ok: false, error: 'only .html files may be saved' });
      }
      const abs = safeResolve(base);
      if (!abs) return json(res, 400, { ok: false, error: 'invalid path' });
      try { await stat(abs); } catch { return json(res, 404, { ok: false, error: 'file not found' }); }
      // The editor builds the file from the page as served, flag included;
      // keep it out of the source.
      await writeFile(abs, html.split(AUTHORING_FLAG).join(''), 'utf8');
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { ok: false, error: String((e && e.message) || e) });
    }
  }

  // --- TIP order endpoint: rewrite assets/tip-order.js from the TODO page. ---
  // Accepts only names of existing tip-*.html pages, so the file stays a plain
  // list the page can trust.
  if (req.method === 'POST' && path === '/api/tip-order') {
    try {
      const { order } = JSON.parse(await readBody(req, 100_000));
      if (!Array.isArray(order) || !order.every((h) => typeof h === 'string' && /^tip-[a-z0-9-]+\.html$/.test(h))) {
        return json(res, 400, { ok: false, error: 'order must list tip-*.html pages' });
      }
      for (const h of order) {
        try { await stat(join(ROOT, h)); } catch { return json(res, 400, { ok: false, error: `no page ${h}` }); }
      }
      const file = join(ROOT, 'assets', 'tip-order.js');
      const src = await readFile(file, 'utf8');
      const header = src.slice(0, src.indexOf('window.TIP_ORDER'));
      await writeFile(file, `${header}window.TIP_ORDER = ${JSON.stringify([...new Set(order)], null, 2)};\n`, 'utf8');
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { ok: false, error: String((e && e.message) || e) });
    }
  }

  // --- Static file serving --------------------------------------------------
  let reqPath = path;
  if (reqPath.endsWith('/')) reqPath += 'index.html';
  let abs = safeResolve(reqPath);
  if (!abs) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  // Clean URL: no extension → try "<path>.html".
  if (!extname(abs)) {
    try { await stat(abs); } catch { abs += '.html'; }
  }

  try {
    let body = await readFile(abs);
    // Mark pages served here as authoring-enabled: design.js turns on inline
    // editing and the GraphEditor column only when this flag is set, so the
    // public site (served by server/server.js, which doesn't inject it) stays
    // read-only. Injected before the first script so it is set when design.js runs.
    if (extname(abs) === '.html') {
      body = Buffer.from(String(body).replace(
        '<script src="assets/pages.js">',
        AUTHORING_FLAG + '<script src="assets/pages.js">'
      ));
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(abs)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  }
}).listen(PORT, () => console.log(`Design dev server → http://localhost:${PORT}/`));
