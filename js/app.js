"use strict";

// =============================================================================
// LiarBoard SPA — app.js
// Hash-based SPA. No framework, no build step, no dependencies.
// =============================================================================

// ─── CONSTANTS ─────────────────────────────────────────────────────────────────
const CLASSES = ["Politician","CEO","Media","Celebrity","Influencer","Official","Other"];

const CLASS_META = {
  Politician: { icon:"🏛️", desc:"Elected officials and government figures" },
  CEO:        { icon:"💼", desc:"Corporate executives and business leaders" },
  Media:      { icon:"📰", desc:"Journalists, anchors, and media personalities" },
  Celebrity:  { icon:"🎬", desc:"Actors, musicians, and public entertainers" },
  Influencer: { icon:"📱", desc:"Social media personalities and online figures" },
  Official:   { icon:"🏢", desc:"Appointed officials and public servants" },
  Other:      { icon:"🔍", desc:"Public figures not covered by other categories" },
};

// Changing this string busts ALL user caches automatically on next visit
const CACHE_PREFIX = "lb3_";
const KEY_VERSION  = CACHE_PREFIX + "ver";
const classKey     = (cls) => CACHE_PREFIX + "cls_" + cls;
const personKey    = (id)  => CACHE_PREFIX + "p_"   + id;

const VALID_SORTS = new Set(["newest","oldest","lvlHigh","lvlLow","mostDebunked","recentCorrect"]);

// Inline SVG fallbacks for broken images — zero extra network requests
const SVG_CARD  = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='220'%3E%3Crect width='320' height='220' fill='%231e293b'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%2364748b' font-size='14'%3ENo Image%3C/text%3E%3C/svg%3E";
const SVG_LARGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='500'%3E%3Crect width='600' height='500' fill='%231e293b'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%2364748b' font-size='18'%3ENo Image%3C/text%3E%3C/svg%3E";

// ─── UTILITIES ─────────────────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

function debounce(fn, ms) {
  ms = ms || 400;
  var t;
  return function() {
    var args = arguments, ctx = this;
    clearTimeout(t);
    t = setTimeout(function() { fn.apply(ctx, args); }, ms);
  };
}

function $(id) { return document.getElementById(id); }

function cloneTemplate(id) {
  var tpl = document.querySelector("template#" + id);
  if (!tpl) { console.error("Template not found:", id); return document.createDocumentFragment(); }
  return tpl.content.cloneNode(true);
}

function setApp(node) {
  var app = $("app");
  if (!app) return;
  app.innerHTML = "";
  if (node) app.appendChild(node);
  window.scrollTo(0, 0);
}

function fmtDate(ts) {
  if (!ts) return "";
  return new Date(Number(ts)).toLocaleDateString(undefined, { year:"numeric", month:"short", day:"numeric" });
}

var store = {
  get: function(k)    { try { return localStorage.getItem(k); }  catch(e) { return null; } },
  set: function(k, v) { try { localStorage.setItem(k, v); }      catch(e) { /* quota */ } },
  del: function(k)    { try { localStorage.removeItem(k); }      catch(e) { /* */ }       },
};

// ─── API ───────────────────────────────────────────────────────────────────────
var api = {
  _ver: null, // in-memory version so we don't double-fetch per page-load

  version: async function() {
    if (this._ver) return this._ver;
    try {
      var r = await fetch("/api/check-version");
      if (!r.ok) return null;
      var d = await r.json();
      var v = d.version_number != null ? String(d.version_number) : null;
      if (v) { this._ver = v; store.set(KEY_VERSION, v); }
      return v;
    } catch(e) { return null; }
  },

  people: async function(opts) {
    opts = opts || {};
    var cls    = opts.cls    || "";
    var sort   = opts.sort   || "newest";
    var search = opts.search || "";
    var cursor = opts.cursor || null;
    var p = new URLSearchParams();
    if (cls)                      p.set("class",  cls);
    if (VALID_SORTS.has(sort))    p.set("sort",   sort);
    if (search)                   p.set("search", search);
    if (cursor)                   p.set("cursor", String(cursor));
    var r = await fetch("/api/people?" + p.toString());
    if (!r.ok) throw new Error("Server error " + r.status);
    return r.json();
  },

  person: async function(id) {
    var r = await fetch("/api/person/" + id);
    if (!r.ok) throw new Error(r.status === 404 ? "Entry not found" : "Server error " + r.status);
    return r.json();
  },

  stats: async function() {
    try {
      var r = await fetch("/api/stats");
      if (!r.ok) return null;
      return r.json();
    } catch(e) { return null; }
  },
};

// ─── CACHE ─────────────────────────────────────────────────────────────────────
var cache = {
  getClass: async function(cls) {
    var liveVer = await api.version();
    if (!liveVer) return null;
    var raw = store.get(classKey(cls));
    if (!raw) return null;
    try {
      var obj = JSON.parse(raw);
      if (!obj || obj.version !== liveVer) { store.del(classKey(cls)); return null; }
      return obj;
    } catch(e) { store.del(classKey(cls)); return null; }
  },

  setClass: function(cls, data, complete, version) {
    store.set(classKey(cls), JSON.stringify({ version:version, data:data, complete:complete }));
  },

  getPerson: async function(id) {
    var liveVer = await api.version();
    if (!liveVer) return null;
    var raw = store.get(personKey(id));
    if (!raw) return null;
    try {
      var obj = JSON.parse(raw);
      if (!obj || obj.version !== liveVer) { store.del(personKey(id)); return null; }
      return obj.data;
    } catch(e) { store.del(personKey(id)); return null; }
  },

  setPerson: function(id, data, version) {
    store.set(personKey(id), JSON.stringify({ version:version, data:data }));
  },
};

// ─── BREADCRUMB ────────────────────────────────────────────────────────────────
function setBreadcrumb(crumbs) {
  var bar = $("breadcrumbBar");
  if (!bar) return;
  if (!crumbs || crumbs.length === 0) {
    bar.style.display = "none";
    bar.innerHTML = "";
    document.body.classList.remove("has-bc");
    return;
  }
  bar.style.display = "flex";
  document.body.classList.add("has-bc");
  bar.innerHTML = crumbs.map(function(c, i) {
    return i < crumbs.length - 1
      ? '<a href="' + esc(c.href) + '" class="bc-link">' + esc(c.label) + '</a><span class="bc-sep">›</span>'
      : '<span class="bc-current">' + esc(c.label) + '</span>';
  }).join("");
}

// ─── PAGE: LANDING ─────────────────────────────────────────────────────────────
function renderLanding() {
  setBreadcrumb(null);
  setApp(cloneTemplate("tpl-landing"));

  var cta = $("ctaReveal");
  if (cta) cta.addEventListener("click", function() { navigate("#/board"); });

  api.stats().then(function(s) {
    if (!s) return;
    var el  = $("statTotal");    if (el)  el.textContent  = s.total    != null ? String(s.total)    : "—";
    var el2 = $("statDebunked"); if (el2) el2.textContent = s.debunked != null ? String(s.debunked) : "—";
  }).catch(function() {});

  // Background prefetch most common category
  setTimeout(function() {
    cache.getClass("Politician").then(function(cached) {
      if (cached) return;
      return api.people({ cls:"Politician", sort:"newest" }).then(function(res) {
        if (!res || !res.data) return;
        return api.version().then(function(v) {
          if (v) cache.setClass("Politician", res.data, !res.nextCursor, v);
        });
      });
    }).catch(function() {});
  }, 1500);
}

// ─── PAGE: BOARD ───────────────────────────────────────────────────────────────
function renderBoard() {
  setBreadcrumb([{ href:"#/", label:"Home" }, { label:"The Board" }]);
  setApp(cloneTemplate("tpl-board"));

  var grid = $("categoryGrid");
  if (!grid) return;
  grid.innerHTML = CLASSES.map(function(cls) {
    var m = CLASS_META[cls] || { icon:"🔍", desc:"" };
    return '<a href="#/category/' + encodeURIComponent(cls) + '" class="category-card">' +
             '<div class="cat-icon">'  + m.icon      + '</div>' +
             '<div class="cat-name">'  + esc(cls)    + '</div>' +
             '<div class="cat-desc">'  + esc(m.desc) + '</div>' +
             '<div class="cat-arrow">→</div>' +
           '</a>';
  }).join("");
}

// ─── PAGE: CATEGORY ─────────────────────────────────────────────────────────────
async function renderCategory(cls) {
  setBreadcrumb([
    { href:"#/",      label:"Home" },
    { href:"#/board", label:"The Board" },
    { label:cls },
  ]);
  setApp(cloneTemplate("tpl-category"));

  var titleEl  = $("catPageTitle");
  var listEl   = $("peopleList");
  var moreWrap = $("loadMoreWrapper");
  var moreBtn  = $("loadMoreBtn");
  var searchEl = $("catSearch");
  var sortEl   = $("catSort");

  if (!listEl) return;
  if (titleEl) titleEl.textContent = (CLASS_META[cls] ? CLASS_META[cls].icon + " " : "") + cls;

  var currentSort   = "newest";
  var currentSearch = "";
  var nextCursor    = null;
  var allLoaded     = false;
  var people        = [];
  var isLoading     = false;
  var liveVersion   = null;

  function showLoading() {
    listEl.innerHTML = '<div class="load-msg">Loading…</div>';
    if (moreWrap) moreWrap.style.display = "none";
  }

  function showError(msg) {
    listEl.innerHTML = '<div class="load-msg error">⚠️ ' + esc(msg) + '</div>';
  }

  function clearFilters() {
    currentSearch = "";
    currentSort   = "newest";
    if (searchEl) searchEl.value = "";
    if (sortEl)   sortEl.value   = "newest";
    load(true);
  }

  function renderList() {
    if (people.length === 0) {
      var hasFilters = currentSearch || currentSort !== "newest";
      listEl.innerHTML =
        '<div class="empty-state">' +
          '<p>No results found.</p>' +
          (hasFilters ? '<button class="btn-outline" id="clearFiltersBtn">✕ Clear Filters</button>' : '') +
        '</div>';
      var cb = $("clearFiltersBtn");
      if (cb) cb.addEventListener("click", clearFilters);
      if (moreWrap) moreWrap.style.display = "none";
      return;
    }

    listEl.innerHTML = people.map(function(p, i) {
      var img      = esc(p.image ? p.image.split(",")[0].trim() : "");
      var hasClaim = p.claim && p.claim.trim();
      return (
        '<a href="#/person/' + p.id + '" class="person-row">' +
          '<img src="' + img + '" class="row-img" alt="' + esc(p.name) + '"' +
               ' loading="' + (i < 6 ? "eager" : "lazy") + '"' +
               ' onerror="this.onerror=null;this.src=\'' + SVG_CARD + '\'">' +
          '<div class="row-info">' +
            '<h3 class="row-name">' + esc(p.name) + '</h3>' +
            '<div class="row-meta">' +
              '<span class="row-class">' + esc(p.class) + '</span>' +
              '<span class="row-lvl">Lvl ' + esc(String(p.lvl != null ? p.lvl : "?")) + '</span>' +
              (hasClaim ? '<span class="claim-pill">⚡ Claim</span>' : '') +
              (p.debunk_count ? '<span class="debunk-pill">🔥 ' + esc(String(p.debunk_count)) + ' debunks</span>' : '') +
            '</div>' +
            (p.bio ? '<p class="row-bio">' + esc(p.bio.substring(0, 120)) + (p.bio.length > 120 ? "…" : "") + '</p>' : '') +
            '<div class="row-date">Added ' + fmtDate(p.timestamp) + '</div>' +
          '</div>' +
          '<div class="row-arrow">›</div>' +
        '</a>'
      );
    }).join("");

    if (moreWrap) moreWrap.style.display = !allLoaded ? "block" : "none";
  }

  async function load(reset) {
    if (isLoading || (allLoaded && !reset)) return;
    isLoading = true;
    if (reset) { people = []; nextCursor = null; allLoaded = false; showLoading(); }

    var isDefault = currentSort === "newest" && !currentSearch;

    // Check cache for default first-page view
    if (reset && isDefault) {
      try {
        var cached = await cache.getClass(cls);
        if (cached && cached.data && cached.data.length > 0) {
          people    = cached.data;
          allLoaded = cached.complete === true;
          nextCursor = null;
          renderList();
          isLoading = false;
          return;
        }
      } catch(e) { /* cache miss */ }
    }

    if (!liveVersion) liveVersion = await api.version();

    try {
      var payload  = await api.people({ cls:cls, sort:currentSort, search:currentSearch, cursor:reset ? null : nextCursor });
      var incoming = Array.isArray(payload.data) ? payload.data : [];
      people       = reset ? incoming : people.concat(incoming);
      nextCursor   = payload.nextCursor || null;
      if (!nextCursor) allLoaded = true;

      if (reset && isDefault && allLoaded && liveVersion) {
        cache.setClass(cls, people, true, liveVersion);
      }
      renderList();
    } catch(err) {
      showError(err.message || "Failed to load");
    } finally {
      isLoading = false;
    }
  }

  if (searchEl) {
    searchEl.addEventListener("input", debounce(function(e) {
      currentSearch = e.target.value.trim();
      load(true);
    }));
  }
  if (sortEl) {
    sortEl.addEventListener("change", function(e) { currentSort = e.target.value; load(true); });
  }
  if (moreBtn) {
    moreBtn.addEventListener("click", function() { load(false); });
  }

  load(true);
}

// ─── PAGE: PERSON ──────────────────────────────────────────────────────────────
async function renderPerson(id) {
  setBreadcrumb([
    { href:"#/",      label:"Home" },
    { href:"#/board", label:"The Board" },
    { label:"Loading…" },
  ]);
  setApp(cloneTemplate("tpl-person"));

  var page = $("personPage");
  if (!page) return;
  page.innerHTML = '<div class="load-msg">Loading…</div>';

  // 1. Dedicated person cache
  var person = null;
  try { person = await cache.getPerson(id); } catch(e) {}

  // 2. Scan class caches — free if user came from a category page
  if (!person) {
    for (var ci = 0; ci < CLASSES.length; ci++) {
      var raw = store.get(classKey(CLASSES[ci]));
      if (!raw) continue;
      try {
        var obj = JSON.parse(raw);
        if (obj && Array.isArray(obj.data)) {
          var found = null;
          for (var pi = 0; pi < obj.data.length; pi++) {
            if (Number(obj.data[pi].id) === Number(id)) { found = obj.data[pi]; break; }
          }
          if (found) { person = found; break; }
        }
      } catch(e) {}
    }
  }

  // 3. API fallback
  if (!person) {
    try {
      person = await api.person(id);
      var v  = await api.version();
      if (v && person) cache.setPerson(id, person, v);
    } catch(err) {
      page.innerHTML = '<div class="load-msg error">⚠️ ' + esc(err.message) + '</div>';
      return;
    }
  }

  if (!person) {
    page.innerHTML = '<div class="load-msg error">Entry not found.</div>';
    return;
  }

  setBreadcrumb([
    { href:"#/",      label:"Home" },
    { href:"#/board", label:"The Board" },
    { href:"#/category/" + encodeURIComponent(person.class), label:person.class },
    { label:person.name },
  ]);

  var images    = person.image ? person.image.split(",").map(function(s){return s.trim();}).filter(Boolean) : [];
  var hasClaim  = !!(person.claim  && person.claim.trim());
  var hasTruth  = !!(person.truth  && person.truth.trim());
  var hasSrcs   = !!(person.sources && person.sources.trim());
  var hasDebunk = hasClaim || hasTruth;
  var multi     = images.length > 1;
  var meta      = CLASS_META[person.class] || { icon:"🔍" };

  // Sources block
  var sourcesHtml = "";
  if (hasSrcs) {
    var links = person.sources.split(",").map(function(s){return s.trim();}).filter(Boolean);
    sourcesHtml =
      '<div class="sources-block">' +
        '<h4 class="sources-title">🔗 Sources</h4>' +
        '<div class="sources-links">' +
          links.map(function(l, i) {
            return '<a href="' + esc(l) + '" target="_blank" rel="noopener noreferrer" class="source-link">Source ' + (i+1) + ' ↗</a>';
          }).join("") +
        '</div>' +
      '</div>';
  }

  // Gallery block
  var galleryHtml = "";
  if (images.length > 0) {
    galleryHtml =
      '<div class="person-gallery">' +
        '<div class="gallery-main-wrap">' +
          '<img src="' + esc(images[0]) + '" class="gallery-main" id="galleryMain"' +
               ' alt="' + esc(person.name) + '"' +
               ' onerror="this.onerror=null;this.src=\'' + SVG_LARGE + '\'">' +
          (multi
            ? '<button class="gal-btn gal-prev" id="galPrev" aria-label="Previous">❮</button>' +
              '<button class="gal-btn gal-next" id="galNext" aria-label="Next">❯</button>' +
              '<div class="gal-counter" id="galCounter">1 / ' + images.length + '</div>'
            : '') +
        '</div>' +
        (multi
          ? '<div class="gallery-thumbs" id="galleryThumbs">' +
              images.map(function(img, i) {
                return '<img src="' + esc(img) + '" class="thumb' + (i===0 ? ' active' : '') + '"' +
                            ' data-idx="' + i + '" alt="Image ' + (i+1) + '"' +
                            ' onerror="this.onerror=null;this.src=\'' + SVG_CARD + '\'">';
              }).join("") +
            '</div>'
          : '') +
      '</div>';
  }

  // Claim/Truth section
  var debunkHtml = "";
  if (hasDebunk) {
    debunkHtml =
      '<div class="claim-truth-section">' +
        '<div class="ct-tabs">' +
          '<button class="ct-tab active" id="claimTab">⚡ The Claim</button>' +
          '<button class="ct-tab" id="truthTab">✅ The Truth</button>' +
        '</div>' +
        '<div id="claimPanel" class="ct-panel claim-panel">' +
          '<div class="ct-label">WHAT THEY CLAIMED</div>' +
          '<p>' + (hasClaim ? esc(person.claim) : '<em style="opacity:0.5">No claim recorded.</em>') + '</p>' +
        '</div>' +
        '<div id="truthPanel" class="ct-panel truth-panel" style="display:none">' +
          '<div class="ct-label">THE VERIFIED TRUTH</div>' +
          '<p>' + (hasTruth ? esc(person.truth) : '<em style="opacity:0.5">No verified truth recorded yet.</em>') + '</p>' +
          sourcesHtml +
        '</div>' +
      '</div>';
  }

  page.innerHTML =
    '<div class="person-hero">' +
      galleryHtml +
      '<div class="person-header-info">' +
        '<div class="person-class-badge">' + meta.icon + ' ' + esc(person.class) + '</div>' +
        '<h1 class="person-name">' + esc(person.name) + '</h1>' +
        '<div class="person-meta-row">' +
          '<span class="person-lvl">Level ' + esc(String(person.lvl != null ? person.lvl : "?")) + '</span>' +
          (person.debunk_count ? '<span class="debunk-badge">⚡ ' + esc(String(person.debunk_count)) + ' debunks</span>' : '') +
        '</div>' +
        '<div class="person-dates">' +
          '<span>Added: ' + fmtDate(person.timestamp) + '</span>' +
          (person.last_corrected ? '<span>Last corrected: ' + fmtDate(person.last_corrected) + '</span>' : '') +
        '</div>' +
        (person.bio ? '<p class="person-bio">' + esc(person.bio) + '</p>' : '') +
      '</div>' +
    '</div>' +
    debunkHtml +
    (!hasDebunk && hasSrcs ? sourcesHtml : "") +
    '<div class="person-back-row">' +
      '<a href="#/category/' + encodeURIComponent(person.class) + '" class="btn-outline">← Back to ' + esc(person.class) + '</a>' +
    '</div>';

  // Wire gallery buttons with addEventListener — no inline onclick
  if (multi) {
    var galIdx = 0;
    function galTo(i) {
      galIdx = i;
      var main    = $("galleryMain");
      var counter = $("galCounter");
      if (main)    main.src = images[i] || SVG_LARGE;
      if (counter) counter.textContent = (i + 1) + " / " + images.length;
      document.querySelectorAll(".gallery-thumbs .thumb").forEach(function(t, ti) {
        t.classList.toggle("active", ti === i);
      });
    }
    var prevBtn = $("galPrev");
    var nextBtn = $("galNext");
    if (prevBtn) prevBtn.addEventListener("click", function() { galTo((galIdx - 1 + images.length) % images.length); });
    if (nextBtn) nextBtn.addEventListener("click", function() { galTo((galIdx + 1) % images.length); });

    var thumbsEl = $("galleryThumbs");
    if (thumbsEl) {
      thumbsEl.addEventListener("click", function(e) {
        var t = e.target.closest(".thumb");
        if (!t) return;
        var idx = parseInt(t.dataset.idx, 10);
        if (!isNaN(idx)) galTo(idx);
      });
    }
  }

  // Wire claim/truth tabs
  var claimTab = $("claimTab");
  var truthTab = $("truthTab");
  if (claimTab && truthTab) {
    function showPanel(panel) {
      var cp = $("claimPanel"), tp = $("truthPanel");
      if (!cp || !tp) return;
      var isClaim = panel === "claim";
      cp.style.display = isClaim ? "" : "none";
      tp.style.display = isClaim ? "none" : "";
      claimTab.classList.toggle("active", isClaim);
      truthTab.classList.toggle("active", !isClaim);
    }
    claimTab.addEventListener("click", function() { showPanel("claim"); });
    truthTab.addEventListener("click", function() { showPanel("truth"); });
  }
}

// ─── PAGE: DOCS ────────────────────────────────────────────────────────────────
function renderDocs() {
  setBreadcrumb([{ href:"#/", label:"Home" }, { label:"Documentation" }]);
  setApp(cloneTemplate("tpl-docs"));
}

// ─── PAGE: CONTACT ─────────────────────────────────────────────────────────────
function renderContact() {
  setBreadcrumb([{ href:"#/", label:"Home" }, { label:"Contact" }]);
  setApp(cloneTemplate("tpl-contact"));

  var copyBtn = $("copyResultBtn");
  if (copyBtn) {
    copyBtn.addEventListener("click", function() {
      var ta = $("contactOutput");
      if (!ta) return;
      navigator.clipboard.writeText(ta.value).catch(function() {
        ta.select(); document.execCommand("copy");
      });
      copyBtn.textContent = "Copied!";
      setTimeout(function() { copyBtn.textContent = "Copy to Clipboard"; }, 2000);
    });
  }
}

// ─── PAGE: 404 ─────────────────────────────────────────────────────────────────
function render404() {
  setBreadcrumb(null);
  setApp(cloneTemplate("tpl-404"));
}

// ─── CONTACT HELPERS (called from template onclick="LB.contact.x()") ───────────
// Declared before window.LB so they can be referenced in the LB object literal.
function contactAddInput(containerId) {
  var c = $(containerId);
  if (!c) return;
  var d   = document.createElement("div");
  d.className = "name-entry";
  var inp = document.createElement("input");
  inp.type        = "text";
  inp.placeholder = "Enter name…";
  inp.className   = "name-input";
  inp.maxLength   = 50;
  d.appendChild(inp);
  c.appendChild(d);
}

function contactGenerateList(type) {
  var id     = type === "ADD" ? "addListContainer" : "removeListContainer";
  var inputs = document.querySelectorAll("#" + id + " .name-input");
  var names  = Array.from(inputs).map(function(i) { return i.value.trim(); }).filter(Boolean);
  if (!names.length) { alert("Please enter at least one name."); return; }
  var out = $("contactOutput");
  var res = $("contactResult");
  if (out) out.value = "--- " + type + " REQUEST ---\n" + names.join("\n");
  if (res) { res.style.display = "block"; res.scrollIntoView({ behavior:"smooth" }); }
}

// ─── ROUTER ────────────────────────────────────────────────────────────────────
var _navigating = false;

function navigate(hash) {
  window.location.hash = hash;
}

async function dispatch() {
  if (_navigating) return;
  _navigating = true;
  try {
    var hash  = window.location.hash || "#/";
    var path  = hash.slice(1) || "/";
    var parts = path.split("/").filter(Boolean);

    // Active nav highlighting — exact match only (no prefix false-positives)
    document.querySelectorAll(".nav-link, .drawer-link").forEach(function(a) {
      var href = (a.getAttribute("href") || "").slice(1); // "#/board" → "/board"
      var isActive = (href === "/" && path === "/")
                  || (href !== "/" && (path === href || path.indexOf(href + "/") === 0));
      a.classList.toggle("active", isActive);
    });

    if (path === "/" || path === "") {
      renderLanding();
    } else if (path === "/board") {
      renderBoard();
    } else if (parts[0] === "category" && parts[1]) {
      var cls = decodeURIComponent(parts[1]);
      if (CLASSES.indexOf(cls) === -1) { render404(); return; }
      await renderCategory(cls);
    } else if (parts[0] === "person" && parts[1]) {
      var pid = parseInt(parts[1], 10);
      if (isNaN(pid)) { render404(); return; }
      await renderPerson(pid);
    } else if (path === "/docs") {
      renderDocs();
    } else if (path === "/contact") {
      renderContact();
    } else {
      render404();
    }
  } catch(err) {
    console.error("Router error:", err);
    render404();
  } finally {
    _navigating = false;
  }
}

// ─── NAVBAR ────────────────────────────────────────────────────────────────────
function initNav() {
  var btn    = $("navHamburger");
  var drawer = $("navDrawer");
  if (!btn || !drawer) return;

  btn.addEventListener("click", function(e) {
    e.stopPropagation();
    var open = drawer.classList.toggle("open");
    btn.setAttribute("aria-expanded", String(open));
  });

  document.addEventListener("click", function(e) {
    if (!drawer.contains(e.target) && e.target !== btn) {
      drawer.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
    }
  });

  drawer.querySelectorAll("a").forEach(function(a) {
    a.addEventListener("click", function() {
      drawer.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
    });
  });
}

// ─── EXPOSE MINIMAL GLOBAL API ─────────────────────────────────────────────────
// Only what the contact template's onclick= attributes need.
// Everything else uses addEventListener so no globals are needed.
window.LB = {
  contact: {
    addInput:     contactAddInput,
    generateList: contactGenerateList,
  },
};

// ─── BOOT ──────────────────────────────────────────────────────────────────────
initNav();
window.addEventListener("hashchange", function() { dispatch(); });
dispatch();
