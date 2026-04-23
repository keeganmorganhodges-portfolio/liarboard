"use strict";

// =============================================================================
// LiarBoard SPA — app.js
// Single-file vanilla JS SPA. No build step, no dependencies.
//
// Architecture:
//   LB.router  — hash-based router (#/, #/board, #/category/CEO, #/person/42)
//   LB.cache   — per-category localStorage cache keyed by version
//   LB.api     — thin fetch wrappers for /api/* endpoints
//   LB.render  — page renderers (landing, board, category, person, docs, contact)
//   LB.contact — contact page helpers (exposed for inline onclick)
// =============================================================================

const LB = (() => {

  // ───────────────────────────────────────────────────────────────────────────
  // CONSTANTS
  // ───────────────────────────────────────────────────────────────────────────
  const CLASSES = ["Politician","CEO","Media","Celebrity","Influencer","Official","Other"];

  const CLASS_META = {
    Politician: { icon: "🏛️", desc: "Elected officials and government figures" },
    CEO:        { icon: "💼", desc: "Corporate executives and business leaders" },
    Media:      { icon: "📰", desc: "Journalists, anchors, and media personalities" },
    Celebrity:  { icon: "🎬", desc: "Actors, musicians, and public entertainers" },
    Influencer: { icon: "📱", desc: "Social media personalities and online figures" },
    Official:   { icon: "🏢", desc: "Appointed officials and public servants" },
    Other:      { icon: "🔍", desc: "Public figures not covered by other categories" },
  };

  // Cache key prefix — bump this to bust ALL user caches on a code deploy
  const CACHE_PREFIX  = "lb3_";
  const KEY_VERSION   = CACHE_PREFIX + "ver";
  // Per-class: lb3_class_CEO, lb3_class_Politician, etc.
  const classKey  = (cls) => `${CACHE_PREFIX}class_${cls}`;
  const personKey = (id)  => `${CACHE_PREFIX}person_${id}`;

  // Sort map (whitelist — mirrors the server-side map exactly)
  const SORT_MAP = {
    newest:        true,
    oldest:        true,
    lvlHigh:       true,
    lvlLow:        true,
    mostDebunked:  true,
    recentCorrect: true,
  };

  // Broken image SVG fallbacks
  const SVG_CARD   = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='220'%3E%3Crect width='320' height='220' fill='%231e293b'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%2364748b' font-size='14'%3ENo Image%3C/text%3E%3C/svg%3E`;
  const SVG_LARGE  = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='500'%3E%3Crect width='600' height='500' fill='%231e293b'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%2364748b' font-size='18'%3ENo Image%3C/text%3E%3C/svg%3E`;

  // ───────────────────────────────────────────────────────────────────────────
  // UTILITIES
  // ───────────────────────────────────────────────────────────────────────────
  function esc(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;")
      .replace(/'/g,"&#039;");
  }

  function debounce(fn, ms = 400) {
    let t;
    return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }

  function $(id) { return document.getElementById(id); }

  function cloneTemplate(id) {
    const tpl = document.querySelector(`template#${id}`);
    if (!tpl) { console.error("Template not found:", id); return null; }
    return tpl.content.cloneNode(true);
  }

  function setApp(node) {
    const app = $("app");
    app.innerHTML = "";
    if (node) app.appendChild(node);
    window.scrollTo(0, 0);
  }

  function fmtDate(ts) {
    if (!ts) return "";
    return new Date(Number(ts)).toLocaleDateString(undefined, { year:"numeric", month:"short", day:"numeric" });
  }

  // Safe localStorage helpers — quota errors are caught silently
  const store = {
    get(k)    { try { return localStorage.getItem(k); }        catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); }            catch { /* quota */ } },
    del(k)    { try { localStorage.removeItem(k); }            catch { /* */ } },
  };

  // ───────────────────────────────────────────────────────────────────────────
  // API LAYER
  // ───────────────────────────────────────────────────────────────────────────
  const api = {
    async version() {
      try {
        const r = await fetch("/api/check-version");
        if (!r.ok) return null;
        const d = await r.json();
        return d.version_number != null ? String(d.version_number) : null;
      } catch { return null; }
    },

    // Fetch people for a class, with optional sort/search/cursor.
    // Returns { data: [], nextCursor: null|number }
    async people({ cls, sort = "newest", search = "", cursor = null } = {}) {
      const p = new URLSearchParams();
      if (cls)    p.set("class",  cls);
      if (sort && SORT_MAP[sort]) p.set("sort", sort);
      if (search) p.set("search", search);
      if (cursor) p.set("cursor", String(cursor));
      const r = await fetch(`/api/people?${p}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();  // { data, nextCursor }
    },

    // Fetch a single person by ID
    async person(id) {
      const r = await fetch(`/api/person/${id}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },

    // Fetch board stats (total entries + claims count)
    async stats() {
      try {
        const r = await fetch("/api/stats");
        if (!r.ok) return null;
        return r.json();
      } catch { return null; }
    },
  };

  // ───────────────────────────────────────────────────────────────────────────
  // CACHE LAYER
  // Per-class caching: lb3_class_CEO = { version, data: [], complete: bool }
  // A "complete" cache means all pages of that class are loaded (no nextCursor).
  // Individual person pages are cached separately by ID.
  // The main admin bumps version_number → all lb3_class_* caches become stale.
  // ───────────────────────────────────────────────────────────────────────────
  const cache = {
    _liveVersion: null,

    async getLiveVersion() {
      if (this._liveVersion) return this._liveVersion;
      const v = await api.version();
      if (v) { this._liveVersion = v; store.set(KEY_VERSION, v); }
      return v;
    },

    // Returns cached data array for a class if fresh, otherwise null
    async getClass(cls) {
      const liveVer = await this.getLiveVersion();
      const raw = store.get(classKey(cls));
      if (!raw) return null;
      try {
        const obj = JSON.parse(raw);
        if (!obj || obj.version !== liveVer) return null;
        return obj; // { version, data, complete }
      } catch { store.del(classKey(cls)); return null; }
    },

    setClass(cls, data, complete, version) {
      const obj = { version, data, complete };
      store.set(classKey(cls), JSON.stringify(obj));
    },

    // Cache a single person record (keyed by ID + version)
    async getPerson(id) {
      const liveVer = await this.getLiveVersion();
      const raw = store.get(personKey(id));
      if (!raw) return null;
      try {
        const obj = JSON.parse(raw);
        if (!obj || obj.version !== liveVer) return null;
        return obj.data;
      } catch { store.del(personKey(id)); return null; }
    },

    setPerson(id, data, version) {
      store.set(personKey(id), JSON.stringify({ version, data }));
    },

    // Invalidate everything (used when version bumped server-side)
    invalidateAll() {
      const keys = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
        }
        keys.forEach(k => store.del(k));
      } catch { /* */ }
      this._liveVersion = null;
    },
  };

  // ───────────────────────────────────────────────────────────────────────────
  // BREADCRUMB
  // ───────────────────────────────────────────────────────────────────────────
  function setBreadcrumb(crumbs) {
    const bar = $("breadcrumbBar");
    if (!bar) return;
    if (!crumbs || crumbs.length === 0) {
      bar.style.display = "none";
      bar.innerHTML = "";
      document.body.classList.remove("has-bc");
      return;
    }
    bar.style.display = "flex";
    document.body.classList.add("has-bc");
    bar.innerHTML = crumbs.map((c, i) =>
      i < crumbs.length - 1
        ? `<a href="${esc(c.href)}" class="bc-link">${esc(c.label)}</a><span class="bc-sep">›</span>`
        : `<span class="bc-current">${esc(c.label)}</span>`
    ).join("");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PAGE: LANDING
  // ───────────────────────────────────────────────────────────────────────────
  function renderLanding() {
    setBreadcrumb(null);
    const frag = cloneTemplate("tpl-landing");
    setApp(frag);

    $("ctaReveal").addEventListener("click", () => { router.go("#/board"); });

    // Load stats in background (non-blocking)
    api.stats().then(s => {
      if (!s) return;
      const total   = $("statTotal");
      const debunked = $("statDebunked");
      if (total)    total.textContent    = s.total    ?? "—";
      if (debunked) debunked.textContent = s.debunked ?? "—";
    });

    // Prefetch docs and contact templates into view so they're instant
    // (they render from <template> tags — no network needed, this just warms JS)
    setTimeout(() => {
      if (!store.get(classKey("Politician"))) {
        api.people({ cls: "Politician", sort: "newest" }).then(res => {
          if (res && res.data) {
            cache.getLiveVersion().then(v => {
              if (v) cache.setClass("Politician", res.data, !res.nextCursor, v);
            });
          }
        }).catch(() => {});
      }
    }, 1500); // Delay 1.5s — let landing paint first
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PAGE: BOARD (category picker)
  // ───────────────────────────────────────────────────────────────────────────
  function renderBoard() {
    setBreadcrumb([{ href: "#/", label: "Home" }, { label: "The Board" }]);
    const frag = cloneTemplate("tpl-board");
    setApp(frag);

    const grid = $("categoryGrid");
    grid.innerHTML = CLASSES.map(cls => {
      const m = CLASS_META[cls] || { icon: "🔍", desc: "" };
      return `
        <a href="#/category/${encodeURIComponent(cls)}" class="category-card">
          <div class="cat-icon">${m.icon}</div>
          <div class="cat-name">${esc(cls)}</div>
          <div class="cat-desc">${esc(m.desc)}</div>
          <div class="cat-arrow">→</div>
        </a>`;
    }).join("");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PAGE: CATEGORY LIST
  // ───────────────────────────────────────────────────────────────────────────
  async function renderCategory(cls) {
    setBreadcrumb([
      { href: "#/",       label: "Home" },
      { href: "#/board",  label: "The Board" },
      { label: cls },
    ]);

    const frag = cloneTemplate("tpl-category");
    setApp(frag);

    const titleEl   = $("catPageTitle");
    const listEl    = $("peopleList");
    const moreWrap  = $("loadMoreWrapper");
    const moreBtn   = $("loadMoreBtn");
    const searchEl  = $("catSearch");
    const sortEl    = $("catSort");

    if (titleEl) titleEl.textContent = `${CLASS_META[cls]?.icon ?? ""} ${cls}`;

    let currentSort   = "newest";
    let currentSearch = "";
    let nextCursor    = null;
    let allLoaded     = false;
    let people        = [];
    let isLoading     = false;
    let liveVersion   = null;

    function showLoading() {
      listEl.innerHTML = '<div class="load-msg">Loading…</div>';
      if (moreWrap) moreWrap.style.display = "none";
    }

    function showError(msg) {
      listEl.innerHTML = `<div class="load-msg error">⚠️ ${esc(msg)}</div>`;
    }

    function renderList() {
      if (people.length === 0) {
        const hasFilters = currentSearch || currentSort !== "newest";
        listEl.innerHTML = `
          <div class="empty-state">
            <p>No results found.</p>
            ${hasFilters ? `<button class="btn-outline" onclick="LB._clearCatFilters()">✕ Clear Filters</button>` : ""}
          </div>`;
        if (moreWrap) moreWrap.style.display = "none";
        return;
      }

      listEl.innerHTML = people.map((p, i) => {
        const img      = esc(p.image ? p.image.split(",")[0].trim() : "");
        const hasClaim = p.claim && p.claim.trim();
        return `
          <a href="#/person/${p.id}" class="person-row">
            <img src="${img}" class="row-img" alt="${esc(p.name)}"
                 loading="${i < 6 ? "eager" : "lazy"}"
                 onerror="this.onerror=null;this.src='${SVG_CARD}'">
            <div class="row-info">
              <h3 class="row-name">${esc(p.name)}</h3>
              <div class="row-meta">
                <span class="row-class">${esc(p.class)}</span>
                <span class="row-lvl">Lvl ${esc(String(p.lvl ?? "?"))}</span>
                ${hasClaim ? `<span class="claim-pill">⚡ Claim</span>` : ""}
                ${p.debunk_count ? `<span class="debunk-pill">🔥 ${esc(String(p.debunk_count))} debunks</span>` : ""}
              </div>
              ${p.bio ? `<p class="row-bio">${esc(p.bio.substring(0, 120))}${p.bio.length > 120 ? "…" : ""}</p>` : ""}
              <div class="row-date">Added ${fmtDate(p.timestamp)}</div>
            </div>
            <div class="row-arrow">›</div>
          </a>`;
      }).join("");

      if (moreWrap) moreWrap.style.display = (!allLoaded) ? "block" : "none";
    }

    // Expose for the "Clear Filters" button which uses an onclick attribute
    LB._clearCatFilters = () => {
      currentSearch = "";
      currentSort   = "newest";
      if (searchEl) searchEl.value = "";
      if (sortEl)   sortEl.value   = "newest";
      load(true);
    };

    async function load(reset = false) {
      if (isLoading || (allLoaded && !reset)) return;
      isLoading = true;

      if (reset) {
        people     = [];
        nextCursor = null;
        allLoaded  = false;
        showLoading();
      }

      const isDefaultSort = currentSort === "newest" && !currentSearch;

      // ── Cache check (only for the clean newest-no-search first page) ───────
      if (reset && isDefaultSort) {
        const cached = await cache.getClass(cls);
        if (cached && cached.data.length > 0) {
          people    = cached.data;
          allLoaded = cached.complete;
          nextCursor = null; // cached data always starts from page 1
          renderList();
          isLoading = false;
          return;
        }
      }

      // Snapshot liveVersion before fetch so we cache with the right key
      if (!liveVersion) liveVersion = await cache.getLiveVersion();

      try {
        const payload = await api.people({ cls, sort: currentSort, search: currentSearch, cursor: reset ? null : nextCursor });
        const incoming = Array.isArray(payload.data) ? payload.data : [];

        people     = reset ? incoming : [...people, ...incoming];
        nextCursor = payload.nextCursor ?? null;
        if (!nextCursor) allLoaded = true;

        // Cache only the complete default first-page result
        if (reset && isDefaultSort && allLoaded && liveVersion) {
          cache.setClass(cls, people, true, liveVersion);
        }

        renderList();
      } catch (err) {
        showError(err.message);
      } finally {
        isLoading = false;
      }
    }

    // Event: search
    if (searchEl) {
      searchEl.addEventListener("input", debounce(function(e) {
        currentSearch = e.target.value.trim();
        load(true);
      }));
    }

    // Event: sort
    if (sortEl) {
      sortEl.addEventListener("change", (e) => {
        currentSort = e.target.value;
        load(true);
      });
    }

    // Event: load more button
    if (moreBtn) {
      moreBtn.addEventListener("click", () => load(false));
    }

    // Initial load
    load(true);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PAGE: PERSON DETAIL
  // ───────────────────────────────────────────────────────────────────────────
  async function renderPerson(id) {
    const frag = cloneTemplate("tpl-person");
    setApp(frag);
    const page = $("personPage");
    if (!page) return;

    page.innerHTML = '<div class="load-msg">Loading…</div>';

    // Try to find the person in any cached class first (avoids a network call)
    let person = null;

    // Check dedicated person cache
    person = await cache.getPerson(id);

    // Fall back: scan class caches in memory (already parsed above if visited)
    if (!person) {
      for (const cls of CLASSES) {
        const cached = store.get(classKey(cls));
        if (!cached) continue;
        try {
          const obj = JSON.parse(cached);
          if (obj && Array.isArray(obj.data)) {
            const found = obj.data.find(p => String(p.id) === String(id));
            if (found) { person = found; break; }
          }
        } catch { /* */ }
      }
    }

    // Fall back to API
    if (!person) {
      try {
        person = await api.person(id);
        const v = await cache.getLiveVersion();
        if (v && person) cache.setPerson(id, person, v);
      } catch (err) {
        page.innerHTML = `<div class="load-msg error">⚠️ Could not load entry: ${esc(err.message)}</div>`;
        return;
      }
    }

    if (!person) {
      page.innerHTML = `<div class="load-msg error">Entry not found.</div>`;
      return;
    }

    // Set breadcrumb now that we have the name
    setBreadcrumb([
      { href: "#/",                                          label: "Home" },
      { href: "#/board",                                     label: "The Board" },
      { href: `#/category/${encodeURIComponent(person.class)}`, label: person.class },
      { label: person.name },
    ]);

    const images   = person.image ? person.image.split(",").map(s => s.trim()).filter(Boolean) : [];
    const hasClaim = person.claim   && person.claim.trim()   !== "";
    const hasTruth = person.truth   && person.truth.trim()   !== "";
    const hasSrcs  = person.sources && person.sources.trim() !== "";
    const hasDebunk = hasClaim || hasTruth;

    // Sources HTML
    let sourcesHtml = "";
    if (hasSrcs) {
      const links = person.sources.split(",").map(s => s.trim()).filter(Boolean);
      sourcesHtml = `
        <div class="sources-block">
          <h4 class="sources-title">🔗 Sources</h4>
          <div class="sources-links">
            ${links.map((l, i) => `<a href="${esc(l)}" target="_blank" rel="noopener noreferrer" class="source-link">Source ${i+1} ↗</a>`).join("")}
          </div>
        </div>`;
    }

    // Image gallery HTML
    let galleryHtml = "";
    if (images.length > 0) {
      galleryHtml = `
        <div class="person-gallery">
          <div class="gallery-main-wrap">
            <img src="${esc(images[0])}" class="gallery-main" id="galleryMain" alt="${esc(person.name)}"
                 onerror="this.onerror=null;this.src='${SVG_LARGE}'">
            ${images.length > 1 ? `
              <button class="gal-btn gal-prev" onclick="LB._galNav(-1)" aria-label="Previous">❮</button>
              <button class="gal-btn gal-next" onclick="LB._galNav(1)"  aria-label="Next">❯</button>
              <div class="gal-counter" id="galCounter">1 / ${images.length}</div>
            ` : ""}
          </div>
          ${images.length > 1 ? `
            <div class="gallery-thumbs" id="galleryThumbs">
              ${images.map((img, i) => `
                <img src="${esc(img)}" class="thumb${i===0?" active":""}" 
                     onclick="LB._galTo(${i})"
                     onerror="this.onerror=null;this.src='${SVG_CARD}'"
                     alt="Image ${i+1}">
              `).join("")}
            </div>
          ` : ""}
        </div>`;
    }

    page.innerHTML = `
      <div class="person-hero">
        ${galleryHtml}
        <div class="person-header-info">
          <div class="person-class-badge">${esc(CLASS_META[person.class]?.icon ?? "")} ${esc(person.class)}</div>
          <h1 class="person-name">${esc(person.name)}</h1>
          <div class="person-meta-row">
            <span class="person-lvl">Level ${esc(String(person.lvl ?? "?"))}</span>
            ${person.debunk_count ? `<span class="debunk-badge">⚡ ${esc(String(person.debunk_count))} debunks</span>` : ""}
          </div>
          <div class="person-dates">
            <span>Added: ${fmtDate(person.timestamp)}</span>
            ${person.last_corrected ? `<span>Last corrected: ${fmtDate(person.last_corrected)}</span>` : ""}
          </div>
          ${person.bio ? `<p class="person-bio">${esc(person.bio)}</p>` : ""}
        </div>
      </div>

      ${hasDebunk ? `
      <div class="claim-truth-section">
        <div class="ct-tabs">
          <button class="ct-tab active" id="claimTab" onclick="LB._showPanel('claim')">⚡ The Claim</button>
          <button class="ct-tab"        id="truthTab" onclick="LB._showPanel('truth')">✅ The Truth</button>
        </div>
        <div id="claimPanel" class="ct-panel claim-panel">
          <div class="ct-label">WHAT THEY CLAIMED</div>
          <p>${hasClaim ? esc(person.claim) : "<em style='opacity:0.5'>No claim recorded.</em>"}</p>
        </div>
        <div id="truthPanel" class="ct-panel truth-panel" style="display:none">
          <div class="ct-label">THE VERIFIED TRUTH</div>
          <p>${hasTruth ? esc(person.truth) : "<em style='opacity:0.5'>No verified truth recorded yet.</em>"}</p>
          ${sourcesHtml}
        </div>
      </div>` : ""}

      ${!hasDebunk && hasSrcs ? sourcesHtml : ""}

      <div class="person-back-row">
        <a href="#/category/${encodeURIComponent(person.class)}" class="btn-outline">← Back to ${esc(person.class)}</a>
      </div>`;

    // Gallery nav helpers (exposed globally for onclick)
    let galIdx = 0;
    LB._galNav = (step) => {
      galIdx = (galIdx + step + images.length) % images.length;
      LB._galTo(galIdx);
    };
    LB._galTo = (i) => {
      galIdx = i;
      const main    = $("galleryMain");
      const counter = $("galCounter");
      const thumbs  = document.querySelectorAll(".thumb");
      if (main)    main.src = images[i];
      if (counter) counter.textContent = `${i+1} / ${images.length}`;
      thumbs.forEach((t, ti) => t.classList.toggle("active", ti === i));
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PANEL TOGGLE (claim / truth)
  // ───────────────────────────────────────────────────────────────────────────
  LB._showPanel = (panel) => {
    const cp = $("claimPanel"), tp = $("truthPanel");
    const ct = $("claimTab"),   tt = $("truthTab");
    if (!cp || !tp) return;
    const isClaim = panel === "claim";
    cp.style.display = isClaim ? "" : "none";
    tp.style.display = isClaim ? "none" : "";
    ct.classList.toggle("active", isClaim);
    tt.classList.toggle("active", !isClaim);
  };

  // ───────────────────────────────────────────────────────────────────────────
  // PAGE: DOCS
  // ───────────────────────────────────────────────────────────────────────────
  function renderDocs() {
    setBreadcrumb([{ href:"#/", label:"Home" }, { label:"Documentation" }]);
    setApp(cloneTemplate("tpl-docs"));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PAGE: CONTACT
  // ───────────────────────────────────────────────────────────────────────────
  function renderContact() {
    setBreadcrumb([{ href:"#/", label:"Home" }, { label:"Contact" }]);
    setApp(cloneTemplate("tpl-contact"));

    const copyBtn = $("copyResultBtn");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        const ta = $("contactOutput");
        if (!ta) return;
        navigator.clipboard.writeText(ta.value).catch(() => {
          ta.select(); document.execCommand("copy");
        });
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy to Clipboard"; }, 2000);
      });
    }
  }

  // Contact helpers exposed for template onclick attributes
  const contact = {
    addInput(containerId) {
      const c = $(containerId);
      if (!c) return;
      const d = document.createElement("div");
      d.className = "name-entry";
      d.innerHTML = `<input type="text" placeholder="Enter name…" class="name-input" maxlength="50">`;
      c.appendChild(d);
    },
    generateList(type) {
      const id = type === "ADD" ? "addListContainer" : "removeListContainer";
      const inputs = document.querySelectorAll(`#${id} .name-input`);
      const names  = Array.from(inputs).map(i => i.value.trim()).filter(Boolean);
      if (!names.length) { alert("Please enter at least one name."); return; }
      const out = $("contactOutput");
      const res = $("contactResult");
      if (out) out.value = `--- ${type} REQUEST ---\n${names.join("\n")}`;
      if (res) { res.style.display = "block"; res.scrollIntoView({ behavior:"smooth" }); }
    },
  };

  // ───────────────────────────────────────────────────────────────────────────
  // PAGE: 404
  // ───────────────────────────────────────────────────────────────────────────
  function render404() {
    setBreadcrumb(null);
    setApp(cloneTemplate("tpl-404"));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ROUTER
  // ───────────────────────────────────────────────────────────────────────────
  const router = {
    go(hash) { window.location.hash = hash; },

    async dispatch() {
      const hash = window.location.hash || "#/";
      const path = hash.slice(1) || "/";

      // Highlight active nav link
      document.querySelectorAll(".nav-link, .drawer-link").forEach(a => {
        a.classList.toggle("active", path.startsWith(a.getAttribute("href")?.slice(1) ?? "___NONE___"));
      });

      const parts = path.split("/").filter(Boolean); // ["", "category", "CEO"] → ["category","CEO"]

      if (path === "/" || path === "") {
        renderLanding();
      } else if (path === "/board") {
        renderBoard();
      } else if (parts[0] === "category" && parts[1]) {
        const cls = decodeURIComponent(parts[1]);
        if (!CLASSES.includes(cls)) { render404(); return; }
        await renderCategory(cls);
      } else if (parts[0] === "person" && parts[1]) {
        const id = parseInt(parts[1], 10);
        if (isNaN(id)) { render404(); return; }
        await renderPerson(id);
      } else if (path === "/docs") {
        renderDocs();
      } else if (path === "/contact") {
        renderContact();
      } else {
        render404();
      }
    },
  };

  // ───────────────────────────────────────────────────────────────────────────
  // NAVBAR MOBILE HAMBURGER
  // ───────────────────────────────────────────────────────────────────────────
  function initNav() {
    const btn    = $("navHamburger");
    const drawer = $("navDrawer");
    if (!btn || !drawer) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      drawer.classList.toggle("open");
    });
    document.addEventListener("click", (e) => {
      if (!drawer.contains(e.target) && e.target !== btn) {
        drawer.classList.remove("open");
      }
    });
    // Close drawer on any link click
    drawer.querySelectorAll("a").forEach(a => {
      a.addEventListener("click", () => drawer.classList.remove("open"));
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // BOOT
  // ───────────────────────────────────────────────────────────────────────────
  function init() {
    initNav();
    window.addEventListener("hashchange", () => router.dispatch());
    router.dispatch();
  }

  // Public surface
  return { init, router, cache, api, contact, _showPanel: () => {}, _galNav: () => {}, _galTo: () => {}, _clearCatFilters: () => {} };

})(); // end IIFE

// Kick off
LB.init();
