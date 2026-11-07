/*
 * design.js — progressive enhancement for the Design site.
 *
 * Every page is fully readable without this script: the page's <main class="page">
 * is present in the markup and renders as a single column. This script upgrades
 * the layout to a topbar + sidebar-TOC shell by adding `body.enhanced` and
 * injecting the shared chrome, built from the window.DESIGN_PAGES manifest. It
 * injects only navigation — never page content — so the raw HTML of each page
 * stays the single source of truth.
 *
 * No fetch/network: the manifest is a global from pages.js, so this works when
 * pages are opened directly from disk (file://) as well as when served.
 */

(function () {
  var pages = Array.isArray(window.DESIGN_PAGES) ? window.DESIGN_PAGES : [];
  var main = document.querySelector("main.page");
  if (!main || !pages.length) return;

  // Which manifest entry is the current page? Match on the file name, tolerating
  // both "glossary.html" (file://, plain servers) and "/glossary" (static hosts
  // that serve clean URLs), plus "" / "/" for the index. So it works anywhere.
  var slug = function (s) {
    return (String(s).split("/").pop() || "").toLowerCase().replace(/\.html$/, "") || "index";
  };
  var here = slug(location.pathname);
  var current = pages.filter(function (p) {
    return slug(p.href) === here;
  })[0];

  document.body.classList.add("enhanced");
  applyStoredLayoutSize("sidebar");

  // ---- Top bar ----------------------------------------------------------
  var topbar = document.createElement("header");
  topbar.id = "topbar";
  // The toggle sits on the left, next to the sidebar it opens.
  topbar.innerHTML =
    '<button class="nav-toggle" type="button" aria-label="Toggle navigation">☰</button>' +
    '<span class="brand"><a href="index.html">Design</a></span>' +
    '<span class="tagline">Tally — system design &amp; docs</span>';

  // ---- Sidebar table of contents ---------------------------------------
  // Groups fold to just their header, except the group containing the current
  // page (open by default) or one the user expands — so the sidebar stays
  // scannable while always surfacing where you are. The open page also gets its
  // own headers (h2/h3/h4) rendered beneath it as a nested outline; navigating
  // to another page reloads and rebuilds this for that page only. A group with
  // a single page named after the group (Glossary, UI) has no fold — its header
  // is a direct link to that page.
  var toc = document.createElement("nav");
  toc.id = "toc";
  toc.setAttribute("aria-label", "Pages");

  var isCurrent = function (p) { return current && p.href === current.href; };

  // Build a nested outline of the current page's headings, giving each a stable
  // id (slugified) so the links resolve. Returns a <ul> or null if no headings.
  var outlineHeadings = [];
  var buildOutline = function () {
    var headings = main.querySelectorAll("h2, h3, h4");
    if (!headings.length) return null;
    var used = {};
    document.querySelectorAll("[id]").forEach(function (el) { used[el.id] = true; });
    var slugify = function (text) {
      var base = text.toLowerCase().trim().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "") || "section";
      var s = base, n = 2;
      while (used[s]) s = base + "-" + n++;
      used[s] = true;
      return s;
    };
    var ul = document.createElement("ul");
    ul.className = "page-outline";
    headings.forEach(function (h) {
      if (!h.id) h.id = slugify(h.textContent);
      outlineHeadings.push(h);
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = "#" + h.id;
      a.className = "outline-link";
      a.setAttribute("data-outline-id", h.id);
      a.setAttribute("data-depth", String(Number(h.tagName.slice(1)) - 2)); // h2->0
      a.textContent = h.textContent;
      li.appendChild(a);
      ul.appendChild(li);
    });
    return ul;
  };
  var outline = buildOutline();

  var makePageLink = function (p) {
    var a = document.createElement("a");
    a.href = p.href;
    if (p.status) a.setAttribute("data-status", p.status);
    if (isCurrent(p)) a.classList.add("active");
    // The title lives in its own <span> (not a bare text node) so it — not the
    // whole flex row — is what shrinks and truncates; the dot stays fixed-size.
    a.innerHTML =
      '<span class="dot" aria-hidden="true"></span>' +
      '<span class="label">' + escapeHtml(p.title || p.href) + "</span>";
    return a;
  };

  // Bucket the manifest into ordered groups (ungrouped entries — the Overview —
  // become their own single-entry, nameless group rendered as a plain link).
  var groups = [];
  var byName = {};
  pages.forEach(function (p) {
    if (!p.group) { groups.push({ name: null, pages: [p] }); return; }
    if (!byName[p.group]) { byName[p.group] = { name: p.group, pages: [] }; groups.push(byName[p.group]); }
    byName[p.group].pages.push(p);
  });

  // The normal grouped navigation lives in its own wrapper so search can hide
  // it as a unit and show a flat results list in its place (see setupSearch).
  var tocNav = document.createElement("div");
  tocNav.id = "toc-nav";

  groups.forEach(function (g) {
    // Ungrouped (Overview): a plain top-level link, with its outline when open.
    if (g.name === null) {
      var top = makePageLink(g.pages[0]);
      top.classList.add("toc-top");
      tocNav.appendChild(top);
      if (isCurrent(g.pages[0]) && outline) tocNav.appendChild(outline);
      return;
    }

    // Single page named after its group → the header itself is the link.
    if (g.pages.length === 1 && g.pages[0].title === g.name) {
      var p = g.pages[0];
      var link = document.createElement("a");
      link.href = p.href;
      link.className = "toc-group toc-group-link";
      if (p.status) link.setAttribute("data-status", p.status);
      if (isCurrent(p)) link.classList.add("active", "has-active");
      link.innerHTML = '<span class="toc-group-label">' + escapeHtml(g.name) + "</span>";
      tocNav.appendChild(link);
      if (isCurrent(p) && outline) tocNav.appendChild(outline);
      return;
    }

    // Otherwise a foldable group of page links.
    var hasActive = g.pages.some(isCurrent);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toc-group" + (hasActive ? " has-active" : "");
    btn.setAttribute("aria-expanded", String(hasActive));
    btn.innerHTML =
      '<span class="toc-group-label">' + escapeHtml(g.name) + "</span>" +
      '<span class="toc-group-caret" aria-hidden="true"></span>';
    var ul = document.createElement("ul");
    ul.hidden = !hasActive;
    g.pages.forEach(function (p) {
      var li = document.createElement("li");
      li.appendChild(makePageLink(p));
      if (isCurrent(p) && outline) li.appendChild(outline); // outline nested under the active page
      ul.appendChild(li);
    });
    tocNav.appendChild(btn);
    tocNav.appendChild(ul);
  });

  toc.addEventListener("click", function (e) {
    var groupBtn = e.target.closest("button.toc-group");
    if (groupBtn) {
      var isExpanded = groupBtn.getAttribute("aria-expanded") === "true";
      groupBtn.setAttribute("aria-expanded", String(!isExpanded));
      groupBtn.nextElementSibling.hidden = isExpanded;
      return;
    }
    var outlineLink = e.target.closest("a.outline-link");
    if (outlineLink) {
      var id = outlineLink.getAttribute("data-outline-id");
      var heading = id && document.getElementById(id);
      if (heading) {
        e.preventDefault();
        history.pushState(history.state, "", location.pathname + location.search + "#" + id);
        scrollHeadingIntoView(heading);
        updateActiveOutlineLink(id);
      }
    }
    if (e.target.closest("a")) document.body.classList.remove("nav-open");
  });

  // Search box (top) + the grouped nav + an (initially empty) results list.
  var search = buildSearchBox();
  toc.appendChild(search.box);
  toc.appendChild(tocNav);
  var tocResults = document.createElement("div");
  tocResults.id = "toc-results";
  tocResults.hidden = true;
  toc.appendChild(tocResults);

  document.body.insertBefore(toc, main);
  document.body.insertBefore(topbar, toc);
  document.body.insertBefore(makeSplitter("sidebar"), main);
  setupHeadingScrollSpy(outlineHeadings);
  setupSearch({ input: search.input, clearBtn: search.clearBtn, tocNav: tocNav, tocResults: tocResults });

  // Third column: the embedded GraphEditor, opened from documented headers.
  // Built on every page (inert until opened — see body.graph-open in the CSS)
  // so that editing a page into having graph metadata for the first time works
  // without a reload. graphColumn.rescan() re-attaches icons/wiring after edits.
  //
  // Both are authoring tools, so they exist only where they can work: the
  // GraphEditor runs as a separate local process, and edits are saved through
  // the Design dev server's /api/save. That server marks the pages it serves
  // with window.DESIGN_AUTHORING (design/scripts/serve.mjs); the public site and
  // a file:// copy don't, so there the docs are read-only and show no graph icons.
  if (window.DESIGN_AUTHORING === true) {
    document.body.classList.add("authoring");
    setupEditing(setupGraphColumn());
  }

  // Mobile drawer toggle
  topbar.querySelector(".nav-toggle").addEventListener("click", function () {
    document.body.classList.toggle("nav-open");
  });

  // Reflect the current page's status in the tab title prefix, cheap wayfinding.
  if (current && current.title) document.title = current.title + " — Design";

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function setupHeadingScrollSpy(headings) {
    if (!headings.length || !history.replaceState) {
      updateActiveOutlineLink(location.hash.replace(/^#/, ""));
      return;
    }

    var ticking = false;
    var lastActiveId = location.hash.replace(/^#/, "");
    var suppressScrollSpy = false;
    var scrollContainer = main;
    var topSlack = 32;

    var update = function () {
      ticking = false;
      var active = headings[0];
      var containerTop = scrollContainer.getBoundingClientRect().top;

      headings.forEach(function (h) {
        if (h.getBoundingClientRect().top - containerTop <= topSlack) active = h;
      });

      if (!active || active.id === lastActiveId) return;
      lastActiveId = active.id;
      var nextUrl = location.pathname + location.search + "#" + active.id;
      history.replaceState(history.state, "", nextUrl);
      updateActiveOutlineLink(active.id);
    };

    var schedule = function () {
      if (suppressScrollSpy) return;
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };

    scrollContainer.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", function () {
      lastActiveId = location.hash.replace(/^#/, "");
      updateActiveOutlineLink(lastActiveId);
      var heading = lastActiveId && document.getElementById(lastActiveId);
      if (heading) scrollHeadingIntoView(heading);
      schedule();
    });

    if (lastActiveId) {
      updateActiveOutlineLink(lastActiveId);
      var initialHeading = document.getElementById(lastActiveId);
      if (initialHeading) {
        suppressScrollSpy = true;
        requestAnimationFrame(function () {
          scrollHeadingIntoView(initialHeading);
          requestAnimationFrame(function () {
            suppressScrollSpy = false;
            schedule();
          });
        });
        return;
      }
    }
    requestAnimationFrame(update);
  }

  function scrollHeadingIntoView(heading) {
    main.scrollTo({
      top: main.scrollTop + heading.getBoundingClientRect().top - main.getBoundingClientRect().top,
      left: main.scrollLeft,
      behavior: "auto",
    });
  }

  function updateActiveOutlineLink(id) {
    toc.querySelectorAll(".outline-link.active").forEach(function (a) {
      a.classList.remove("active");
      a.removeAttribute("aria-current");
    });
    if (!id) return;
    var active = Array.from(toc.querySelectorAll(".outline-link")).filter(function (a) {
      return a.getAttribute("data-outline-id") === id;
    })[0];
    if (!active) return;
    active.classList.add("active");
    active.setAttribute("aria-current", "location");
  }

  function makeSplitter(name) {
    var splitter = document.createElement("div");
    splitter.className = "layout-splitter";
    splitter.setAttribute("data-splitter", name);
    splitter.setAttribute("role", "separator");
    splitter.setAttribute("aria-orientation", "vertical");
    splitter.setAttribute("aria-label", name === "sidebar" ? "Resize navigation" : "Resize graph editor");
    splitter.tabIndex = 0;

    var config = getSplitterConfig(name);
    var updateValue = function (value) {
      var clamped = clamp(value, config.min, getMaxWidth(config));
      document.documentElement.style.setProperty(config.variable, Math.round(clamped) + "px");
      splitter.setAttribute("aria-valuenow", String(Math.round(clamped)));
      storeLayoutSize(name, clamped);
    };
    var currentValue = function () {
      return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(config.variable)) || config.defaultValue;
    };

    splitter.setAttribute("aria-valuemin", String(config.min));
    splitter.setAttribute("aria-valuemax", String(getMaxWidth(config)));
    splitter.setAttribute("aria-valuenow", String(Math.round(currentValue())));

    splitter.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      splitter.setPointerCapture(e.pointerId);
      document.body.classList.add("is-resizing-layout");
      var startX = e.clientX;
      var startWidth = currentValue();
      var direction = config.side === "right" ? -1 : 1;

      var move = function (moveEvent) {
        updateValue(startWidth + (moveEvent.clientX - startX) * direction);
      };
      var stop = function () {
        document.body.classList.remove("is-resizing-layout");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        splitter.removeEventListener("lostpointercapture", stop);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
      splitter.addEventListener("lostpointercapture", stop);
    });

    splitter.addEventListener("keydown", function (e) {
      var step = e.shiftKey ? 40 : 16;
      if (e.key === "ArrowLeft") { e.preventDefault(); updateValue(currentValue() - step); }
      if (e.key === "ArrowRight") { e.preventDefault(); updateValue(currentValue() + step); }
      if (e.key === "Home") { e.preventDefault(); updateValue(config.min); }
      if (e.key === "End") { e.preventDefault(); updateValue(getMaxWidth(config)); }
    });

    splitter.addEventListener("dblclick", function () {
      updateValue(config.defaultValue);
    });

    return splitter;
  }

  function getSplitterConfig(name) {
    if (name === "graph") {
      return { variable: "--graph-w", storageKey: "design.graphWidth", min: 260, maxRatio: 0.5, defaultValue: 380, side: "right" };
    }
    return { variable: "--sidebar-w", storageKey: "design.sidebarWidth", min: 200, maxRatio: 0.45, defaultValue: 272, side: "left" };
  }

  function applyStoredLayoutSize(name) {
    var config = getSplitterConfig(name);
    try {
      var stored = Number(localStorage.getItem(config.storageKey));
      if (Number.isFinite(stored)) {
        document.documentElement.style.setProperty(config.variable, Math.round(clamp(stored, config.min, getMaxWidth(config))) + "px");
      }
    } catch (e) {
      // Storage is optional; direct file access and strict privacy modes still work.
    }
  }

  function storeLayoutSize(name, value) {
    try {
      localStorage.setItem(getSplitterConfig(name).storageKey, String(Math.round(value)));
    } catch (e) {
      // Ignore storage failures; the live resize has already been applied.
    }
  }

  function getMaxWidth(config) {
    return Math.max(config.min, Math.round(window.innerWidth * config.maxRatio));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // ---- Graph column (embedded GraphEditor) ------------------------------
  // A page documents which code files it covers via hidden `data-files`
  // metadata — one list for the whole document (on <main>, its icon sits by the
  // <h1>), one per root-level section (on each <h2>), or one per glossary term
  // (on each <dt>). For every such element we inject a graph icon that opens a
  // third column hosting the standalone GraphEditor in an iframe, filtered to
  // exactly those files (its "custom" category — an ordinary, toggleable
  // legend entry there, named after the heading/term it came from). A block can
  // also carry a free-standing icon anywhere in its text — see the `{{graph:}}`
  // syntax in the inline-editing section below — which is wired the same way
  // but reads its files/name from its own attributes rather than an ancestor's.
  //
  // GraphEditor stays independent; driven purely over postMessage:
  //   design → editor : { type:'showNodes', ids:[...], name } | { type:'clearFilter' }
  //   editor → design : { source:'graph-editor', type:'ready' | 'close' }
  // The editor announces `ready` after load; commands sent earlier are queued.
  //
  // The column's DOM is always built (inert until opened — see body.graph-open
  // in the CSS), not just on pages that start out with graph metadata, so that
  // inline-editing a page into having its first graph link works without a
  // reload. rescan() (returned below) re-attaches icons/wiring after an edit.
  function setupGraphColumn() {
    var GRAPH_EDITOR_URL = window.GRAPH_EDITOR_URL || "http://localhost:8088/index.html";

    applyStoredLayoutSize("graph");

    var splitter = makeSplitter("graph");
    var panel = document.createElement("section");
    panel.id = "graph-panel";
    panel.setAttribute("aria-label", "Graph editor");
    var iframe = document.createElement("iframe");
    iframe.id = "graph-frame";
    iframe.title = "Graph editor";
    panel.appendChild(iframe);
    document.body.appendChild(splitter);
    document.body.appendChild(panel);

    var ready = false;
    var pending = null;   // command buffered until the iframe reports ready
    var activeKey = null; // which icon is currently lit

    var send = function (msg) {
      if (ready && iframe.contentWindow) iframe.contentWindow.postMessage(msg, "*");
      else pending = msg;
    };

    window.addEventListener("message", function (e) {
      var d = e.data;
      if (!d || d.source !== "graph-editor") return;
      if (d.type === "ready") {
        ready = true;
        if (pending) { iframe.contentWindow.postMessage(pending, "*"); pending = null; }
      } else if (d.type === "close") {
        closeGraph();
      }
    });

    var setActive = function (key) {
      activeKey = key;
      var btns = main.querySelectorAll(".graph-open-btn");
      Array.prototype.forEach.call(btns, function (b) {
        b.classList.toggle("active", b.getAttribute("data-graph-key") === key);
      });
    };
    var closeGraph = function () {
      document.body.classList.remove("graph-open");
      setActive(null);
    };
    var openGraph = function (src) {
      if (!iframe.src) {
        iframe.src = GRAPH_EDITOR_URL + (GRAPH_EDITOR_URL.indexOf("?") < 0 ? "?" : "&") + "embed=1";
      }
      document.body.classList.add("graph-open");
      send({ type: "showNodes", ids: src.files, name: src.name });
      setActive(src.key);
    };

    var keySeq = 0;
    var nextKey = function () { return "graph-" + Date.now().toString(36) + "-" + keySeq++; };

    // Whole-document icon: data-files lives on <main> itself, icon sits on <h1>.
    function ensureWholeDocButton() {
      var wholeAttr = main.getAttribute("data-files");
      var h1 = main.querySelector("h1");
      if (!wholeAttr || !h1) return;
      if (h1.querySelector(":scope > .graph-open-btn")) return;
      var btn = makeIconButton();
      btn.setAttribute("data-graph-key", "whole");
      h1.appendChild(btn);
    }

    // One icon per data-files-bearing heading/term (h2 sections, dt glossary
    // terms). Skips elements that already have their button (re-running this
    // after an edit only needs to add buttons for newly-tagged elements — an
    // edited heading is rebuilt fresh each time, so it never has a stale one).
    function ensureOwnerButtons() {
      var owners = main.querySelectorAll("h2[data-files], dt[data-files]");
      Array.prototype.forEach.call(owners, function (el) {
        if (el.querySelector(":scope > .graph-open-btn")) return;
        if (!el.id) el.id = nextKey();
        var btn = makeIconButton();
        btn.setAttribute("data-graph-key", el.id);
        el.appendChild(btn);
      });
    }

    function makeIconButton() {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "graph-open-btn";
      btn.innerHTML = graphIcon();
      return btn;
    }

    // Resolve a button (however it got there) to { files, name, key } at click
    // time, so edits to the owning heading/term (or the button's own inline
    // attributes) are always reflected without needing to re-wire anything.
    function describeButton(btn) {
      var h1 = main.querySelector("h1");
      if (h1 && btn.parentElement === h1) {
        // Whole-document icon: data-files lives on <main>, not the <h1> itself.
        return { files: parseFiles(main.getAttribute("data-files") || ""), name: h1.textContent.trim(), key: "whole" };
      }
      var owner = btn.closest("h2[data-files], dt[data-files]");
      if (owner) {
        var text = owner.textContent.trim();
        var name = owner.tagName === "DT" ? text.split(",")[0].trim() : text;
        return { files: parseFiles(owner.getAttribute("data-files")), name: name, key: owner.id || (owner.id = nextKey()) };
      }
      // Free-standing inline icon: reads its own data-files/data-graph-name.
      if (!btn.dataset.graphKey) btn.dataset.graphKey = nextKey();
      return {
        files: parseFiles(btn.getAttribute("data-files") || ""),
        name: btn.getAttribute("data-graph-name") || "",
        key: btn.dataset.graphKey,
      };
    }

    // Attach click behaviour to any not-yet-wired .graph-open-btn in main —
    // freshly created above, or already present in the DOM (loaded from source,
    // or just inserted by an inline-edit commit via {{graph:}} markdown).
    function wireButtons() {
      var btns = main.querySelectorAll(".graph-open-btn");
      Array.prototype.forEach.call(btns, function (btn) {
        if (btn.dataset.wired) return;
        btn.dataset.wired = "1";
        btn.addEventListener("click", function () {
          var src = describeButton(btn);
          if (!src.files.length) return;
          btn.setAttribute("data-graph-key", src.key);
          btn.title = "Show these files in the graph (" + src.files.length + ")";
          btn.setAttribute("aria-label", btn.title);
          if (activeKey === src.key && document.body.classList.contains("graph-open")) closeGraph();
          else openGraph(src);
        });
      });
    }

    function rescan() {
      ensureWholeDocButton();
      ensureOwnerButtons();
      wireButtons();
    }

    rescan();
    return { rescan: rescan };
  }

  function parseFiles(s) {
    return String(s).split(/[\s,]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function graphIcon() {
    return (
      '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">' +
      '<path d="M6 13.2 L13 6.2 M6.6 13.8 L14 14.4" stroke="currentColor" stroke-width="1.3" fill="none"/>' +
      '<circle cx="5" cy="14.5" r="2.4"/><circle cx="14.5" cy="5.2" r="2.4"/><circle cx="15" cy="14.8" r="2.1"/>' +
      "</svg>"
    );
  }

  // ---- Sidebar search ---------------------------------------------------
  // A search box at the top of the sidebar searches the full text of *every*
  // page (fetched lazily and cached on first use — needs HTTP, degrades to no
  // results on file://). Matches replace the grouped nav with a flat list of
  // matching documents. Opening a result carries the query in `?q=`, and on the
  // next page load we highlight every match in the document and scroll to the
  // first — so the search box stays populated and results stay listed, letting
  // you hop between matching documents.
  function buildSearchBox() {
    var box = document.createElement("div");
    box.id = "toc-search";
    var input = document.createElement("input");
    input.type = "text";
    input.id = "toc-search-input";
    input.placeholder = "Search docs…";
    input.setAttribute("aria-label", "Search documentation");
    input.autocomplete = "off";
    input.spellcheck = false;
    var clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.id = "toc-search-icon";
    clearBtn.tabIndex = -1;
    clearBtn.setAttribute("aria-label", "Clear search");
    clearBtn.innerHTML =
      '<svg class="icon-search" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
      '<circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13 L17.5 17.5" stroke-linecap="round"/></svg>' +
      '<svg class="icon-clear" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
      '<path d="M5 5 L15 15 M15 5 L5 15" stroke-linecap="round"/></svg>';
    box.appendChild(input);
    box.appendChild(clearBtn);
    return { box: box, input: input, clearBtn: clearBtn };
  }

  function setupSearch(opts) {
    var input = opts.input, clearBtn = opts.clearBtn, tocNav = opts.tocNav, tocResults = opts.tocResults;
    var box = input.parentNode;
    var docsCache = null; // Promise<[{href,title,text}]> — built once, reused
    // The active query is carried across page loads in sessionStorage rather
    // than the URL: clean-URL static hosts (e.g. `serve`) 301-redirect
    // page.html → /page and drop the query string, which would lose it.
    var SEARCH_KEY = "design.searchQuery";
    var readStored = function () { try { return sessionStorage.getItem(SEARCH_KEY) || ""; } catch (e) { return ""; } };
    var writeStored = function (v) { try { if (v) sessionStorage.setItem(SEARCH_KEY, v); else sessionStorage.removeItem(SEARCH_KEY); } catch (e) {} };

    function loadDocs() {
      if (docsCache) return docsCache;
      docsCache = Promise.all(pages.map(function (p) {
        return fetch(p.href)
          .then(function (r) { return r.ok ? r.text() : ""; })
          .then(function (html) {
            var text = "";
            try {
              var doc = new DOMParser().parseFromString(html, "text/html");
              var m = doc.querySelector("main.page");
              text = (m ? m.textContent : "").replace(/\s+/g, " ").trim();
            } catch (e) { /* ignore parse errors */ }
            return { href: p.href, title: p.title || p.href, text: text };
          })
          .catch(function () { return { href: p.href, title: p.title || p.href, text: "" }; });
      }));
      return docsCache;
    }

    function countMatches(haystack, needle) {
      var count = 0, idx = haystack.indexOf(needle);
      while (idx !== -1) { count++; idx = haystack.indexOf(needle, idx + needle.length); }
      return count;
    }

    function renderResults(query) {
      var q = query.toLowerCase();
      loadDocs().then(function (docs) {
        if (input.value.trim().toLowerCase() !== q) return; // superseded while fetching
        var hits = [];
        docs.forEach(function (d) {
          var c = countMatches(d.text.toLowerCase(), q);
          if (c) hits.push({ doc: d, count: c });
        });
        hits.sort(function (a, b) { return b.count - a.count; });

        tocResults.innerHTML = "";
        var summary = document.createElement("div");
        summary.className = "search-summary";
        // Cross-document search reads each page over HTTP; on the file:// origin
        // those fetches are blocked, so every doc comes back empty. Say so
        // rather than showing a bare "No matches".
        var noneLoaded = docs.every(function (d) { return !d.text; });
        summary.textContent = hits.length
          ? hits.length + " document" + (hits.length > 1 ? "s" : "")
          : (noneLoaded && location.protocol === "file:")
          ? "Search needs the dev server (npm run dev:design)"
          : "No matches";
        tocResults.appendChild(summary);

        hits.forEach(function (h) {
          var a = document.createElement("a");
          a.className = "search-result";
          a.href = h.doc.href; // query travels in sessionStorage, not the URL
          if (slug(h.doc.href) === here) a.classList.add("active");
          a.innerHTML =
            '<span class="search-result-title">' + escapeHtml(h.doc.title) + "</span>" +
            '<span class="search-result-count">' + h.count + "</span>";
          tocResults.appendChild(a);
        });
      });
    }

    function enterSearch(query) {
      box.classList.add("has-text");
      tocNav.hidden = true;
      tocResults.hidden = false;
      writeStored(query);
      renderResults(query);
    }
    function exitSearch() {
      box.classList.remove("has-text");
      tocResults.hidden = true;
      tocResults.innerHTML = "";
      tocNav.hidden = false;
      unhighlightMatches(); // drop any highlights on the current page
      writeStored(""); // so a reload / next page returns to the normal sidebar
    }

    var timer = null;
    input.addEventListener("input", function () {
      clearTimeout(timer);
      var v = input.value.trim();
      if (!v) { exitSearch(); return; }
      box.classList.add("has-text"); // flip icon immediately; results after the debounce
      timer = setTimeout(function () { enterSearch(v); }, 150);
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && input.value) { input.value = ""; exitSearch(); }
      if (e.key === "Enter") {
        var first = tocResults.querySelector("a.search-result");
        if (first) { e.preventDefault(); window.location.href = first.href; }
      }
    });

    clearBtn.addEventListener("click", function () {
      if (input.value) { input.value = ""; exitSearch(); }
      input.focus();
    });

    // Restore an in-progress search on load, and highlight this page's matches.
    var initialQ = readStored();
    if (initialQ && initialQ.trim()) {
      input.value = initialQ;
      enterSearch(initialQ.trim());
      highlightMatches(initialQ.trim());
    }
  }

  // Wrap every occurrence of `query` in the current page's <main> with a
  // <mark>, then scroll the first one near the top. Text nodes are collected
  // before any mutation so the walk isn't disturbed by the wrapping.
  function highlightMatches(query) {
    var needle = String(query).toLowerCase();
    if (!needle) return;
    var walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || node.nodeValue.toLowerCase().indexOf(needle) === -1) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);

    var first = null;
    nodes.forEach(function (node) {
      var text = node.nodeValue, lower = text.toLowerCase();
      var frag = document.createDocumentFragment();
      var i = 0, idx;
      while ((idx = lower.indexOf(needle, i)) !== -1) {
        if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
        var mark = document.createElement("mark");
        mark.className = "search-hit";
        mark.textContent = text.slice(idx, idx + needle.length);
        frag.appendChild(mark);
        if (!first) first = mark;
        i = idx + needle.length;
      }
      if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
      node.parentNode.replaceChild(frag, node);
    });

    if (first) {
      first.classList.add("search-hit-first");
      requestAnimationFrame(function () {
        var top = main.scrollTop + first.getBoundingClientRect().top - main.getBoundingClientRect().top - 48;
        main.scrollTo({ top: Math.max(0, top), behavior: "auto" });
      });
    }
  }

  // Reverse highlightMatches: unwrap each <mark> back to plain text.
  function unhighlightMatches() {
    var marks = main.querySelectorAll("mark.search-hit");
    if (!marks.length) return;
    marks.forEach(function (m) {
      m.parentNode.replaceChild(document.createTextNode(m.textContent), m);
    });
    main.normalize(); // merge the text nodes back together
  }

  // ---- Inline editing ---------------------------------------------------
  // Click a block of text to edit it: it turns into a textarea holding the
  // block's markdown. Enter, or clicking/tabbing away, commits (markdown -> HTML,
  // applied both to the live page and, via the dev server's /api/save, to the
  // source .html file); Shift+Enter inserts a newline; Esc cancels and discards.
  // Needs the dev server (see design/scripts/serve.mjs) -- a no-op when the save
  // request can't be made.
  //
  // The textarea isn't limited to producing one block: its content is split on
  // blank lines into as many blocks as it contains, each independently typed as
  // a heading/list/blockquote/paragraph (see parseBlocks below) -- so typing a
  // blank line and then "## New section" splits the edited block in two and
  // adds a heading; clearing the textarea entirely deletes the block. Only
  // prose blocks are click-to-edit entry points; dt/dd (glossary) are left out
  // because their term-self links don't round-trip through plain markdown.
  // Anything inside [data-no-edit] is skipped too: a page's own widget (the
  // TODO page's draggable list) built by script, whose markup isn't authored.
  var EDIT_BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote";
  var pageFile = here + ".html";

  function setupEditing(graphColumn) {
    var active = null; // { el, textarea, index }

    main.addEventListener("click", function (e) {
      if (active) return;
      if (e.target.closest("a, button, input, textarea, select, summary, label, .graph-open-btn")) return;
      if (e.target.closest("[data-no-edit]")) return;
      var sel = window.getSelection && window.getSelection();
      if (sel && String(sel).length) return; // don't hijack a text selection
      var block = e.target.closest(EDIT_BLOCK_SELECTOR);
      if (!block || !main.contains(block)) return;
      beginEdit(block);
    });

    function beginEdit(el) {
      var blocks = Array.prototype.slice.call(main.querySelectorAll(EDIT_BLOCK_SELECTOR));
      var index = blocks.indexOf(el);
      if (index < 0) return;
      var ta = document.createElement("textarea");
      ta.className = "doc-edit";
      ta.value = blockToEditorText(el);
      ta.setAttribute("aria-label", "Edit content");
      el.style.display = "none";
      el.parentNode.insertBefore(ta, el);
      autosize(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      active = { el: el, textarea: ta, index: index };

      ta.addEventListener("input", function () { autosize(ta); });
      ta.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") { ev.preventDefault(); cleanup(); }
        else if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); commit(); }
        // Shift+Enter falls through to the textarea's default newline.
      });
      // Clicking or tabbing away from the textarea commits, same as Enter.
      // commit()/cleanup() both null `active` before removing the textarea, so
      // the blur this triggers (removing/hiding a focused element blurs it
      // synchronously) sees `active` already cleared and no-ops -- no double-commit.
      ta.addEventListener("blur", function () { commit(); });
    }

    // Cancel: discard the textarea, restore the original block untouched.
    function cleanup() {
      if (!active) return;
      var ed = active;
      active = null;
      ed.textarea.remove();
      ed.el.style.display = "";
    }

    function commit() {
      if (!active) return;
      var ed = active;
      active = null;
      var newMd = ed.textarea.value;
      ed.textarea.remove();

      var wasH1 = ed.el.tagName === "H1";
      var blocks = parseBlocks(newMd, wasH1, ed.el);
      replaceBlockWith(ed.el, blocks, wasH1);
      graphColumn.rescan(); // pick up any heading/inline graph tags this edit added or changed

      saveToSource(ed.index, newMd, wasH1).catch(function (err) {
        console.error("[design] inline-edit save failed:", err);
      });
    }

    // Write the edited block back to the source file: locate it by its index
    // among EDIT_BLOCK_SELECTOR matches (identical in the clean source and the
    // live DOM -- the injected chrome lives outside <main> and graph icons
    // aren't block-level, so neither shifts the indexing), re-run the same
    // markdown parse against the fetched source's own document, and splice only
    // <main>'s inner HTML back into the original text -- so the authored
    // comment, doctype, <head>, <main>'s own attributes and scripts stay
    // byte-for-byte unchanged.
    function saveToSource(index, newMd, wasH1) {
      return fetch(pageFile).then(function (res) {
        if (!res.ok) throw new Error("could not read source (" + res.status + ")");
        return res.text();
      }).then(function (text) {
        var doc = new DOMParser().parseFromString(text, "text/html");
        var srcMain = doc.querySelector("main.page");
        if (!srcMain) throw new Error("no <main class=page> in source");
        var target = srcMain.querySelectorAll(EDIT_BLOCK_SELECTOR)[index];
        if (!target) throw new Error("block " + index + " not found in source");

        var blocks = parseBlocks(newMd, wasH1, target);
        replaceBlockWith(target, blocks, wasH1);

        var open = text.search(/<main[\s>]/i);
        var openEnd = open >= 0 ? text.indexOf(">", open) : -1;
        var close = text.lastIndexOf("</main>");
        if (open < 0 || openEnd < 0 || close < 0 || close < openEnd) {
          throw new Error("could not locate <main> in source");
        }
        // The opening <main ...> tag is re-serialized from srcMain's live
        // attributes rather than reused verbatim from `text` — editing the page's
        // own <h1> can change <main data-files>, and that's the only way for
        // that change to make it into the saved file. When nothing touched
        // <main>'s attributes this round-trips byte-identical: DOMParser keeps
        // attribute order and each value's exact original string untouched.
        var openTagMatch = srcMain.outerHTML.match(/^<main[^>]*>/i);
        var openTag = openTagMatch ? openTagMatch[0] : text.slice(open, openEnd + 1);
        // The HTML serializer emits void elements bare (<hr>); the docs write
        // them self-closed (<hr />). Restore that so unedited <hr /> etc.
        // elsewhere in <main> round-trip byte-identical instead of churning.
        var out = text.slice(0, open) + openTag + selfCloseVoids(srcMain.innerHTML) + text.slice(close);
        return fetch("/api/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: pageFile, html: out }),
        });
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok || !data.ok) throw new Error((data && data.error) || ("save failed (" + res.status + ")"));
        });
      });
    }
  }

  function autosize(ta) {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }

  // Rewrite bare void tags (<hr>, <br>, <img …>) to the self-closed form
  // (<hr />) the docs use, matching how the HTML is authored. Applied to
  // serialized <main> output; text/attribute content can't match because the
  // serializer escapes any literal "<" there.
  var VOID_TAG_RE = /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)((?:\s+[^>]*?)?)\s*>/gi;
  function selfCloseVoids(html) {
    return html.replace(VOID_TAG_RE, function (_, tag, attrs) { return "<" + tag + attrs + " />"; });
  }

  // Replace `target` (a block matching EDIT_BLOCK_SELECTOR, live or from a
  // freshly-parsed source document -- works either way since it inserts via
  // HTML strings, which parse in whatever document `target` belongs to) with
  // zero or more new blocks. Zero blocks = the edit deleted the content, so the
  // container itself is removed -- except the page's own <h1>, which is never
  // deleted outright (a title-less page has nowhere for the next edit's entry
  // point to anchor), only reset to a placeholder.
  function replaceBlockWith(target, blocks, wasH1) {
    var parent = target.parentNode;
    if (blocks.length) {
      blocks.forEach(function (b) { target.insertAdjacentHTML("beforebegin", b.html); });
    } else if (wasH1) {
      target.insertAdjacentHTML("beforebegin", "<h1>Untitled</h1>");
    }
    // A level-1 heading's graph tag lives on <main data-files>, not the <h1>
    // itself (matching the authored convention) -- only touched when editing
    // the page's own <h1> and the result is still a level-1 heading.
    if (wasH1 && blocks[0] && blocks[0].level === 1) {
      var mainEl = target.closest("main.page");
      if (blocks[0].mainFiles) mainEl.setAttribute("data-files", blocks[0].mainFiles);
      else mainEl.removeAttribute("data-files");
    }
    parent.removeChild(target);
  }

  // ---- Minimal HTML <-> markdown for the editable inline subset ---------
  // Inline grammar: **bold**, *italic*, `code`, [text](url), and the one
  // non-standard extension -- {{graph: file1.js, file2.js}} or
  // {{graph: file1.js, file2.js | Label}} -- a free-standing graph-editor icon
  // link, usable anywhere inline (see graphButtonHtml). A heading can instead
  // (or additionally) carry a *trailing* {graph: file1.js, file2.js} tag (single
  // braces) binding the icon to that heading/section, matching the existing
  // data-files convention -- see chunkToBlock.
  //
  // Block grammar, one per blank-line-separated chunk of the textarea:
  //   heading    -- starts with 1-6 #'s + a space
  //   list       -- every line starts with "- "/"* " (unordered) or "1. " (ordered)
  //   blockquote -- every line starts with "> "
  //   paragraph  -- anything else (the fallback)
  // Enough for how these docs are authored; anything richer in the original
  // HTML is left as-is until that block is edited.
  function collapseWs(s) { return String(s).replace(/\s+/g, " ").trim(); }

  // skipDirectIcon: true only for the outermost call over a heading's own
  // children, so its ancestor-owned graph icon (appended as a direct child by
  // graphColumn) is excluded -- that one is represented by the heading's
  // trailing {graph:} tag instead, not inline {{graph:}} markdown.
  function inlineToMarkdown(node, skipDirectIcon) {
    var out = "";
    Array.prototype.forEach.call(node.childNodes, function (child) {
      if (child.nodeType === 3) { out += child.nodeValue; return; }
      if (child.nodeType !== 1) return;
      if (child.classList && child.classList.contains("graph-open-btn")) {
        if (skipDirectIcon) return;
        var files = child.getAttribute("data-files") || "";
        var name = child.getAttribute("data-graph-name") || "";
        out += "{{graph: " + files + (name ? " | " + name : "") + "}}";
        return;
      }
      var tag = child.tagName.toLowerCase();
      if (tag === "br") { out += "\n"; return; }
      if (tag === "code") { out += "`" + child.textContent + "`"; return; }
      var inner = inlineToMarkdown(child, false);
      if (tag === "strong" || tag === "b") out += "**" + inner + "**";
      else if (tag === "em" || tag === "i") out += "*" + inner + "*";
      else if (tag === "a") out += "[" + inner + "](" + (child.getAttribute("href") || "") + ")";
      else out += inner; // span, mark (search), etc. -- keep the text
    });
    return out;
  }

  // Whether a block round-trips losslessly through the inline markdown grammar.
  // The block's *own* attributes are fine (carried over by withOrigAttrs / kept
  // by raw fallback); this only inspects descendants. Anything markdown can't
  // express — an unknown element (span, div, table…), a nested list, an <li>
  // with attributes (e.g. the Conventions legend's class="chip" data-status),
  // or an attribute other than a link's href — makes the block "unsafe", so it
  // is edited as raw HTML instead (see blockToEditorText / detectBlockType).
  function isMarkdownSafe(el) {
    var listCtx = el.tagName === "UL" || el.tagName === "OL";
    var descendants = el.querySelectorAll("*");
    for (var i = 0; i < descendants.length; i++) {
      var c = descendants[i];
      if (c.closest(".graph-open-btn")) continue; // injected icon (+ its <svg>)
      var ct = c.tagName.toLowerCase();
      var okTag = ct === "strong" || ct === "b" || ct === "em" || ct === "i" ||
        ct === "code" || ct === "a" || ct === "br" || (listCtx && ct === "li");
      if (!okTag) return false;
      for (var j = 0; j < c.attributes.length; j++) {
        if (ct === "a" && c.attributes[j].name.toLowerCase() === "href") continue;
        return false;
      }
    }
    return true;
  }

  // The text shown in the textarea for a block: markdown when the block is
  // representable (below), otherwise its raw HTML (minus any injected graph
  // icon), which parseBlocks passes straight back through untouched.
  function blockToEditorText(el) {
    if (!isMarkdownSafe(el)) {
      var clone = el.cloneNode(true);
      Array.prototype.forEach.call(clone.querySelectorAll(".graph-open-btn"), function (b) { b.remove(); });
      return clone.outerHTML;
    }
    return blockToMarkdown(el);
  }

  function blockToMarkdown(el) {
    var tag = el.tagName.toLowerCase();
    var headingLevel = /^h[1-6]$/.test(tag) ? +tag.slice(1) : 0;
    if (headingLevel) {
      var files = headingLevel === 1 ? main.getAttribute("data-files") : el.getAttribute("data-files");
      var text = collapseWs(inlineToMarkdown(el, true));
      var suffix = files ? " {graph: " + collapseWs(files) + "}" : "";
      return "#".repeat(headingLevel) + " " + text + suffix;
    }
    if (tag === "ul" || tag === "ol") {
      var items = Array.prototype.filter.call(el.children, function (c) { return c.tagName === "LI"; });
      return items.map(function (li, i) {
        return (tag === "ol" ? (i + 1) + ". " : "- ") + collapseWs(inlineToMarkdown(li, false));
      }).join("\n");
    }
    if (tag === "blockquote") {
      return "> " + collapseWs(inlineToMarkdown(el, false));
    }
    return collapseWs(inlineToMarkdown(el, false));
  }

  function inlineMarkdownToHtml(md) {
    var s = String(md).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // {{graph: ...}} -- inline icon links -- before the code/bold/italic/link
    // passes so a file list or label can't accidentally trip those up.
    s = s.replace(/\{\{graph:\s*([^|}]+?)\s*(?:\|\s*([^}]+?)\s*)?\}\}/gi, function (_, files, name) {
      return graphButtonHtml(files, name || "");
    });
    var codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return " " + (codes.length - 1) + " "; });
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, t, u) {
      return '<a href="' + u.replace(/"/g, "&quot;") + '">' + t + "</a>";
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replace(/ (\d+) /g, function (_, i) { return "<code>" + codes[+i] + "</code>"; });
    return s;
  }

  // `filesRaw`/`nameRaw` come from already-HTML-escaped text (inlineMarkdownToHtml
  // escapes & / < / > up front), so only the still-live `"` needs handling here
  // -- re-escaping & would double-encode it.
  function graphButtonHtml(filesRaw, nameRaw) {
    var files = collapseWs(filesRaw).replace(/"/g, "&quot;");
    var name = collapseWs(nameRaw).replace(/"/g, "&quot;");
    return '<button type="button" class="graph-open-btn" data-files="' + files + '"' +
      (name ? ' data-graph-name="' + name + '"' : "") + ">" + graphIcon() + "</button>";
  }

  // Raw (not-yet-HTML-escaped) text destined for an attribute value assembled
  // by string concatenation -- unlike graphButtonHtml's inputs, this hasn't
  // been through inlineMarkdownToHtml's escaping pass yet, so & needs handling too.
  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  function detectBlockType(chunk) {
    var lines = chunk.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length) return null;
    if (lines[0][0] === "<") return "html"; // raw HTML passthrough (see isMarkdownSafe)
    if (/^#{1,6}\s+/.test(lines[0])) return "heading";
    if (lines.every(function (l) { return /^(?:[-*]|\d+\.)\s+/.test(l); })) return "list";
    if (lines.every(function (l) { return /^>\s?/.test(l); })) return "blockquote";
    return "paragraph";
  }

  // One blank-line-delimited chunk -> { html, level, mainFiles }. `html` is the
  // block's outerHTML as a string (inserted via insertAdjacentHTML, which is
  // document-context-agnostic -- works whether `target` in replaceBlockWith is
  // in the live page or a freshly-parsed source document). `level` is set only
  // for headings (used by replaceBlockWith to decide whether this chunk still
  // owns the page's <h1> role); `mainFiles` only for a level-1 heading, the
  // resolved data-files value for <main> (a string, possibly "" to mean clear).
  function chunkToBlock(chunk, allowH1) {
    var type = detectBlockType(chunk);
    if (type === "html") {
      // Verbatim HTML the user typed or kept from an unsupported block. `raw`
      // stops parseBlocks from merging the original element's attributes back in
      // (the user owns the full markup here).
      var raw = chunk.trim();
      return { html: raw, level: /^<h1[\s>]/i.test(raw) ? 1 : 0, raw: true };
    }
    if (type === "heading") {
      var m = chunk.match(/^(#{1,6})\s+([\s\S]*)$/);
      var level = m[1].length;
      var rest = collapseWs(m[2]);
      var graphFiles = null;
      var tagMatch = rest.match(/\{graph:\s*([^}]*)\}\s*$/i);
      if (tagMatch) {
        graphFiles = tagMatch[1].trim();
        rest = rest.slice(0, tagMatch.index).trim();
      }
      if (level === 1 && !allowH1) level = 2; // guard against a stray extra <h1>
      var tag = "h" + level;
      var attr = level !== 1 && graphFiles ? ' data-files="' + escapeAttr(collapseWs(graphFiles)) + '"' : "";
      return {
        html: "<" + tag + attr + ">" + inlineMarkdownToHtml(rest) + "</" + tag + ">",
        level: level,
        mainFiles: level === 1 ? (graphFiles || "") : undefined,
      };
    }
    if (type === "list") {
      var lines = chunk.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
      var ordered = /^\d+\./.test(lines[0]);
      var itemsHtml = lines.map(function (l) {
        var item = l.replace(/^(?:[-*]|\d+\.)\s+/, "");
        return "<li>" + inlineMarkdownToHtml(collapseWs(item)) + "</li>";
      }).join("");
      var listTag = ordered ? "ol" : "ul";
      return { html: "<" + listTag + ">" + itemsHtml + "</" + listTag + ">", level: 0 };
    }
    if (type === "blockquote") {
      var qLines = chunk.split("\n").map(function (l) { return l.trim().replace(/^>\s?/, ""); }).filter(Boolean);
      return { html: "<blockquote>" + qLines.map(function (l) { return inlineMarkdownToHtml(collapseWs(l)); }).join("<br>") + "</blockquote>", level: 0 };
    }
    var pLines = chunk.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
    return { html: "<p>" + pLines.map(function (l) { return inlineMarkdownToHtml(collapseWs(l)); }).join("<br>") + "</p>", level: 0 };
  }

  // Full textarea value -> array of chunkToBlock results, one per blank-line-
  // separated chunk (zero-length input -> zero blocks -> the block is deleted).
  // allowH1 only ever applies to the *first* chunk, and only when the edited
  // element itself was the page's <h1> -- typing "# Foo" into an ordinary
  // paragraph downgrades to <h2> rather than minting a second page title.
  //
  // origEl (optional) is the block being edited: if the *first* resulting chunk
  // keeps the same tag (the common case -- editing text without changing its
  // type), origEl's other attributes are carried over onto it, so e.g. a
  // <p class="lede"> stays a <p class="lede"> rather than becoming a bare <p>.
  // id/data-files/data-wired/data-graph-key are excluded -- those are re-derived
  // fresh each edit (see chunkToBlock / graphColumn's rescan), not preserved.
  function parseBlocks(md, allowH1, origEl) {
    var text = String(md).replace(/\r\n?/g, "\n");
    var chunks = text.split(/\n[ \t]*\n+/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length; });
    var blocks = chunks.map(function (c, i) { return chunkToBlock(c, allowH1 && i === 0); });
    if (origEl && blocks[0] && !blocks[0].raw) blocks[0].html = withOrigAttrs(blocks[0].html, origEl);
    return blocks;
  }

  var CARRIED_ATTR_EXCLUDE = { id: 1, "data-files": 1, "data-wired": 1, "data-graph-key": 1, style: 1 };
  function withOrigAttrs(html, origEl) {
    var m = html.match(/^<([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*)?)>/);
    if (!m || m[1].toLowerCase() !== origEl.tagName.toLowerCase()) return html;
    var already = {};
    var attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=/g, am;
    while ((am = attrRe.exec(m[2]))) already[am[1].toLowerCase()] = true;
    var extra = "";
    Array.prototype.forEach.call(origEl.attributes, function (a) {
      var name = a.name.toLowerCase();
      if (CARRIED_ATTR_EXCLUDE[name] || already[name]) return;
      extra += " " + a.name + '="' + escapeAttr(a.value) + '"';
    });
    return extra ? "<" + m[1] + m[2] + extra + ">" + html.slice(m[0].length) : html;
  }
})();
