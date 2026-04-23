"use strict";

// =============================================================================
// LiarBoard SPA — app.js v3 (with user auth, voting, profiles, messages, chat)
// =============================================================================

// ─── AUTH STATE ────────────────────────────────────────────────────────────────
var AUTH = {
  token:    null,
  username: null,
  _key: "lb_auth",

  load: function() {
    try {
      var raw = localStorage.getItem(this._key);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (!d || !d.token || !d.username) return;
      if (d.expiresAt && d.expiresAt < Date.now()) { this.clear(); return; }
      this.token    = d.token;
      this.username = d.username;
    } catch(e) {}
  },

  save: function(token, username, expiresAt) {
    this.token    = token;
    this.username = username;
    try { localStorage.setItem(this._key, JSON.stringify({token:token,username:username,expiresAt:expiresAt})); } catch(e) {}
  },

  clear: function() {
    this.token = null; this.username = null;
    try { localStorage.removeItem(this._key); } catch(e) {}
  },

  loggedIn: function() { return !!this.token; },

  // Adds Authorization header to fetch options
  headers: function(extra) {
    var h = Object.assign({ "Content-Type":"application/json" }, extra||{});
    if (this.token) h["Authorization"] = "Bearer " + this.token;
    return h;
  },
};
AUTH.load();

// Update nav visibility based on auth state
function updateAuthNav() {
  var loggedIn = AUTH.loggedIn();
  var show = function(id, vis) { var el = $(id); if (el) el.style.display = vis ? "" : "none"; };
  show("navMessages",    loggedIn);
  show("navProfile",     loggedIn);
  show("navLogout",      loggedIn);
  show("navLogin",      !loggedIn);
  show("drawerMessages", loggedIn);
  show("drawerProfile",  loggedIn);
  show("drawerLogout",   loggedIn);
  show("drawerLogin",   !loggedIn);
  show("drawerSignup",  !loggedIn);
  if (loggedIn && $("navProfile")) $("navProfile").textContent = AUTH.username;
  if (loggedIn && $("drawerProfile")) $("drawerProfile").textContent = AUTH.username;
}


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
    // Update the global user count banner
    var ucn = $("userCountNum"); if (ucn && s.users != null) ucn.textContent = String(s.users);
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
      (AUTH.loggedIn()
        ? '<a href="#/chat" class="btn-outline" style="margin-left:10px">💬 Chat with Admin</a>'
        : '') +
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

  // Append vote widget if logged in
  if (AUTH.loggedIn()) {
    var voteSection = document.createElement("div");
    voteSection.className = "vote-section";
    voteSection.innerHTML =
      '<div class="vote-card">' +
        '<h4 class="vote-title">Community Rating</h4>' +
        '<div class="vote-current">' +
          (person.community_score != null
            ? '<span class="vote-score">' + person.community_score + '/100</span> <span class="vote-count">(' + (person.vote_count||0) + ' votes)</span>'
            : '<span class="vote-count">No votes yet</span>') +
        '</div>' +
        '<div class="vote-input-row">' +
          '<label>Your rating (0–100):</label>' +
          '<input type="range" id="voteSlider" min="0" max="100" value="50" class="vote-slider">' +
          '<span id="voteSliderVal">50</span>' +
        '</div>' +
        '<button class="btn-primary" id="voteSubmitBtn">Submit Vote</button>' +
        '<div id="voteMsg" style="margin-top:8px;font-size:13px"></div>' +
      '</div>';
    page.appendChild(voteSection);

    // Load user's existing vote
    fetch("/api/vote/" + id, { headers: AUTH.headers() })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.score != null) {
          var sl = $("voteSlider"); var sv = $("voteSliderVal");
          if (sl) { sl.value = d.score; if (sv) sv.textContent = d.score; }
        }
      }).catch(function(){});

    var slider = $("voteSlider");
    if (slider) {
      slider.addEventListener("input", function() {
        var sv = $("voteSliderVal"); if (sv) sv.textContent = slider.value;
      });
    }

    var voteBtn = $("voteSubmitBtn");
    if (voteBtn) {
      voteBtn.addEventListener("click", function() {
        var score = parseInt(($("voteSlider")||{}).value||"50", 10);
        voteBtn.disabled = true;
        fetch("/api/vote", {
          method:"POST",
          headers: AUTH.headers(),
          body: JSON.stringify({ person_id:id, score:score }),
        }).then(function(r){ return r.json(); }).then(function(d){
          var vm = $("voteMsg");
          if (vm) vm.textContent = d.ok ? "✓ Vote recorded!" : (d.error||"Error");
          voteBtn.disabled = false;
        }).catch(function(e){
          var vm = $("voteMsg"); if (vm) vm.textContent = "Error: " + e.message;
          voteBtn.disabled = false;
        });
      });
    }
  }
}

// ─── PAGE: LOGIN ───────────────────────────────────────────────────────────────
function renderLogin() {
  setBreadcrumb([{ href:"#/", label:"Home" }, { label:"Sign In" }]);
  setApp(cloneTemplate("tpl-login"));

  var btn = $("loginBtn");
  if (!btn) return;

  btn.addEventListener("click", async function() {
    var username  = ($("loginUsername")||{}).value||"";
    var password  = ($("loginPassword")||{}).value||"";
    var errEl     = $("loginError");
    var tsToken   = getTurnstileToken("loginTurnstile");

    if (!username || !password) { showAuthError(errEl,"Username and password required"); return; }
    btn.disabled = true; btn.textContent = "Signing in…";

    try {
      var r = await fetch("/api/auth/login", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ username:username, password:password, turnstile:tsToken }),
      });
      var d = await r.json();
      if (!r.ok || !d.ok) { showAuthError(errEl, d.error||"Login failed"); resetTurnstile("loginTurnstile"); }
      else {
        AUTH.save(d.token, d.username, d.expiresAt);
        updateAuthNav();
        navigate("#/board");
      }
    } catch(e) { showAuthError(errEl, e.message); }
    finally { btn.disabled=false; btn.textContent="Sign In"; }
  });
}

// ─── PAGE: SIGNUP ──────────────────────────────────────────────────────────────
function renderSignup() {
  setBreadcrumb([{ href:"#/", label:"Home" }, { label:"Sign Up" }]);
  setApp(cloneTemplate("tpl-signup"));

  var btn = $("signupBtn");
  if (!btn) return;

  btn.addEventListener("click", async function() {
    var username = ($("signupUsername")||{}).value||"";
    var email    = ($("signupEmail")||{}).value||"";
    var password = ($("signupPassword")||{}).value||"";
    var errEl    = $("signupError");
    var sucEl    = $("signupSuccess");
    var tsToken  = getTurnstileToken("signupTurnstile");

    if (!username||!email||!password) { showAuthError(errEl,"All fields required"); return; }
    btn.disabled=true; btn.textContent="Creating account…";

    try {
      var r = await fetch("/api/auth/signup", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ username:username, email:email, password:password, turnstile:tsToken }),
      });
      var d = await r.json();
      if (!r.ok || !d.ok) { showAuthError(errEl, d.error||"Signup failed"); resetTurnstile("signupTurnstile"); }
      else {
        if (errEl) errEl.style.display="none";
        if (sucEl) { sucEl.style.display=""; sucEl.textContent="✓ Account created! You can now sign in."; }
        setTimeout(function(){ navigate("#/login"); }, 2000);
      }
    } catch(e) { showAuthError(errEl, e.message); }
    finally { btn.disabled=false; btn.textContent="Create Account"; }
  });
}

// ─── PAGE: MY PROFILE ──────────────────────────────────────────────────────────
async function renderProfile() {
  if (!AUTH.loggedIn()) { navigate("#/login"); return; }
  setBreadcrumb([{ href:"#/", label:"Home" }, { label:"My Profile" }]);
  setApp(cloneTemplate("tpl-profile"));

  // Load current user data
  try {
    var r = await fetch("/api/auth/me", { headers:AUTH.headers() });
    var u = await r.json();
    var infoEl = $("profileAccountInfo");
    if (infoEl) infoEl.innerHTML =
      '<div class="profile-field"><span class="pf-label">Username</span><span>' + esc(u.username) + '</span></div>' +
      '<div class="profile-field"><span class="pf-label">Email</span><span>' + esc(u.email||"—") + '</span></div>' +
      '<div class="profile-field"><span class="pf-label">Member since</span><span>' + fmtDate(u.created_at) + '</span></div>';

    var curEl = $("profileCurrentData");
    if (curEl) curEl.innerHTML =
      '<div class="profile-field"><span class="pf-label">Display name</span><span>' + esc(u.display_name||"Not set") + '</span></div>' +
      '<div class="profile-field"><span class="pf-label">Bio</span><span>' + esc(u.bio||"Not set") + '</span></div>' +
      '<div class="profile-field"><span class="pf-label">Contact</span><span>' + esc(u.contact_info||"Not set") + '</span></div>';
  } catch(e) {}

  var submitBtn = $("profileSubmitBtn");
  if (submitBtn) {
    submitBtn.addEventListener("click", async function() {
      var field = ($("profileField")||{}).value||"";
      var value = ($("profileValue")||{}).value||"";
      var msgEl = $("profileMsg");
      if (!field||!value.trim()) { if (msgEl) { msgEl.textContent="Field and value required"; msgEl.style.color="#f87171"; } return; }
      submitBtn.disabled=true;
      try {
        var r = await fetch("/api/profile/request", {
          method:"POST", headers:AUTH.headers(),
          body: JSON.stringify({ field:field, value:value.trim() }),
        });
        var d = await r.json();
        if (msgEl) {
          msgEl.textContent = d.ok ? "✓ Submitted for review." : (d.error||"Error");
          msgEl.style.color = d.ok ? "#86efac" : "#f87171";
        }
      } catch(e) { if (msgEl) { msgEl.textContent=e.message; msgEl.style.color="#f87171"; } }
      finally { submitBtn.disabled=false; }
    });
  }
}

// ─── PAGE: VIEW USER PROFILE ───────────────────────────────────────────────────
async function renderUserProfile(username) {
  setBreadcrumb([{ href:"#/", label:"Home" }, { label:username }]);
  setApp(cloneTemplate("tpl-user-profile"));
  var el = $("userProfileContent");
  if (!el) return;
  el.innerHTML = '<div class="load-msg">Loading…</div>';
  try {
    var r = await fetch("/api/profile/" + encodeURIComponent(username));
    if (!r.ok) { el.innerHTML = '<div class="load-msg error">Profile not found.</div>'; return; }
    var u = await r.json();
    el.innerHTML =
      '<h1 class="person-name">' + esc(u.display_name||u.username) + '</h1>' +
      '<p style="color:#64748b;margin-bottom:16px">@' + esc(u.username) + ' · Member since ' + fmtDate(u.created_at) + '</p>' +
      (u.bio ? '<p style="color:#e2e8f0;line-height:1.7;margin-bottom:16px">' + esc(u.bio) + '</p>' : '') +
      (u.contact_info ? '<p style="color:#94a3b8;font-size:13px">' + esc(u.contact_info) + '</p>' : '') +
      (AUTH.loggedIn()
        ? '<a href="#/messages" class="btn-outline" style="margin-top:16px;display:inline-block" id="msgThisUser">Send Message</a>'
        : '');
    // Pre-fill message compose with this user
    var msgBtn = $("msgThisUser");
    if (msgBtn) msgBtn.addEventListener("click", function() {
      navigate("#/messages");
      setTimeout(function() { var t=$("msgTo"); if(t) t.value=u.username; }, 100);
    });
  } catch(e) { el.innerHTML = '<div class="load-msg error">Error: ' + esc(e.message) + '</div>'; }
}

// ─── PAGE: MESSAGES ────────────────────────────────────────────────────────────
async function renderMessages() {
  if (!AUTH.loggedIn()) { navigate("#/login"); return; }
  setBreadcrumb([{ href:"#/", label:"Home" }, { label:"Messages" }]);
  setApp(cloneTemplate("tpl-messages"));

  // Load inbox
  var inboxEl = $("inboxList");
  try {
    var r = await fetch("/api/messages", { headers:AUTH.headers() });
    var d = await r.json();
    var msgs = d.messages||[];
    if (!msgs.length) {
      if (inboxEl) inboxEl.innerHTML = '<div class="load-msg">No messages yet.</div>';
    } else {
      if (inboxEl) inboxEl.innerHTML = msgs.map(function(m) {
        return '<div class="inbox-item' + (m.read_at ? '' : ' unread') + '">' +
          '<div class="inbox-from">From <a href="#/user/' + esc(m.from_username) + '" class="auth-link">@' + esc(m.from_username) + '</a>' +
          ' <span class="inbox-date">' + fmtDate(m.sent_at) + '</span></div>' +
          '<div class="inbox-body">' + esc(m.body) + '</div>' +
        '</div>';
      }).join("");
    }
  } catch(e) { if (inboxEl) inboxEl.innerHTML = '<div class="load-msg error">Failed to load messages.</div>'; }

  // Send message handler
  var sendBtn = $("msgSendBtn");
  if (sendBtn) {
    sendBtn.addEventListener("click", async function() {
      var to   = ($("msgTo")||{}).value||"";
      var body = ($("msgBody")||{}).value||"";
      var res  = $("msgSendResult");
      if (!to||!body.trim()) { if(res){res.textContent="Recipient and message required";res.style.color="#f87171";} return; }
      sendBtn.disabled=true;
      try {
        var r = await fetch("/api/messages/send", {
          method:"POST", headers:AUTH.headers(),
          body: JSON.stringify({ to_username:to.trim(), body:body.trim() }),
        });
        var d = await r.json();
        if (res) { res.textContent = d.ok ? "✓ Sent!" : (d.error||"Error"); res.style.color = d.ok?"#86efac":"#f87171"; }
        if (d.ok) { var mb=$("msgBody"); if(mb) mb.value=""; }
      } catch(e) { if(res){res.textContent=e.message;res.style.color="#f87171";} }
      finally { sendBtn.disabled=false; }
    });
  }
}

// ─── PAGE: CHAT ────────────────────────────────────────────────────────────────
async function renderChat() {
  if (!AUTH.loggedIn()) { navigate("#/login"); return; }
  setBreadcrumb([{ href:"#/", label:"Home" }, { label:"Live Chat" }]);
  setApp(cloneTemplate("tpl-chat"));

  var statusBox = $("chatStatusBox");
  var controls  = $("chatControls");

  async function refreshStatus() {
    try {
      var r = await fetch("/api/chat/status", { headers:AUTH.headers() });
      var d = await r.json();
      var tl = $("chatTimeLimit"); if (tl) tl.textContent = Math.round((d.timeLimit||300)/60) + " minutes";

      if (d.status==="disabled") {
        if (statusBox) statusBox.innerHTML = '<div class="chat-status-badge disabled">Chat is currently disabled by the admin.</div>';
        if (controls) controls.innerHTML = "";
        return;
      }
      if (d.status==="none") {
        if (statusBox) statusBox.innerHTML = '<div class="chat-status-badge available">Chat is available. Click to join the queue.</div>';
        if (controls) {
          controls.innerHTML = '<button class="btn-primary" id="chatJoinBtn">Join Queue</button>';
          var jb = $("chatJoinBtn");
          if (jb) jb.addEventListener("click", async function() {
            jb.disabled=true; jb.textContent="Joining…";
            try {
              await fetch("/api/chat/join",{method:"POST",headers:AUTH.headers()});
              setTimeout(refreshStatus, 500);
            } catch(e) { jb.disabled=false; jb.textContent="Join Queue"; }
          });
        }
      } else if (d.status==="waiting") {
        if (statusBox) statusBox.innerHTML =
          '<div class="chat-status-badge waiting">You are in the queue.' +
          (d.position>0 ? ' <strong>' + d.position + ' ' + (d.position===1?"person":"people") + '</strong> ahead of you.' : ' You\'re next!') +
          '</div>';
        if (controls) {
          controls.innerHTML = '<button class="btn-outline" id="chatLeaveBtn">Leave Queue</button>';
          var lb2 = $("chatLeaveBtn");
          if (lb2) lb2.addEventListener("click", async function() {
            await fetch("/api/chat/leave",{method:"POST",headers:AUTH.headers()});
            refreshStatus();
          });
        }
        // Poll every 15s
        setTimeout(refreshStatus, 15000);
      } else if (d.status==="active") {
        if (statusBox) statusBox.innerHTML =
          '<div class="chat-status-badge active">You are in an active session! Time limit: ' + Math.round((d.timeLimit||300)/60) + ' minutes.</div>' +
          '<p style="color:#64748b;font-size:13px;margin-top:8px">Real-time messaging requires Cloudflare Workers Paid plan. Your session is tracked.</p>';
        if (controls) controls.innerHTML = '<button class="btn-outline" id="chatLeaveBtn">End Session</button>';
      }
    } catch(e) {
      if (statusBox) statusBox.innerHTML = '<div class="load-msg error">Failed to check status.</div>';
    }
  }
  refreshStatus();
}

// ─── TURNSTILE HELPERS ─────────────────────────────────────────────────────────
function getTurnstileToken(containerId) {
  try {
    var el = $(containerId);
    if (!el) return "";
    // Cloudflare Turnstile puts the token in the first iframe's response input
    var inp = el.querySelector("[name='cf-turnstile-response']");
    return inp ? inp.value : "";
  } catch(e) { return ""; }
}

function resetTurnstile(containerId) {
  try {
    if (window.turnstile && $(containerId)) window.turnstile.reset($(containerId));
  } catch(e) {}
}

function showAuthError(el, msg) {
  if (!el) return;
  el.textContent = msg;
  el.style.display = "";
}

// ─── CONTACT PAGE (updated renderer) ──────────────────────────────────────────
function renderContact() {
  setBreadcrumb([{ href:"#/", label:"Home" }, { label:"Contact" }]);
  setApp(cloneTemplate("tpl-contact"));

  function wireSubmit(btnId, containerId, type, resultId) {
    var btn = $(btnId);
    if (!btn) return;
    btn.addEventListener("click", async function() {
      if (!AUTH.loggedIn()) { navigate("#/login"); return; }
      var inputs = document.querySelectorAll("#" + containerId + " .name-input");
      var names  = Array.from(inputs).map(function(i){ return i.value.trim(); }).filter(Boolean);
      var resEl  = $(resultId);
      if (!names.length) { if (resEl) { resEl.textContent="Enter at least one name."; resEl.style.color="#f87171"; } return; }
      var tsToken = getTurnstileToken("contactTurnstile");
      btn.disabled=true;
      try {
        var r = await fetch("/api/submit", {
          method:"POST", headers:AUTH.headers(),
          body: JSON.stringify({ type:type, names:names, turnstile:tsToken }),
        });
        var d = await r.json();
        if (resEl) { resEl.textContent = d.ok ? "✓ Request submitted for admin review." : (d.error||"Error"); resEl.style.color = d.ok?"#86efac":"#f87171"; }
        resetTurnstile("contactTurnstile");
      } catch(e) { if(resEl){resEl.textContent=e.message;resEl.style.color="#f87171";} }
      finally { btn.disabled=false; }
    });
  }

  wireSubmit("submitAddBtn",    "addListContainer",    "add",    "addResult");
  wireSubmit("submitRemoveBtn", "removeListContainer", "remove", "removeResult");
}

// ─── PAGE: DOCS ────────────────────────────────────────────────────────────────
function renderDocs() {
  setBreadcrumb([{ href:"#/", label:"Home" }, { label:"Documentation" }]);
  setApp(cloneTemplate("tpl-docs"));
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
    } else if (path === "/login") {
      renderLogin();
    } else if (path === "/signup") {
      renderSignup();
    } else if (path === "/profile") {
      await renderProfile();
    } else if (parts[0] === "user" && parts[1]) {
      await renderUserProfile(decodeURIComponent(parts[1]));
    } else if (path === "/messages") {
      await renderMessages();
    } else if (path === "/chat") {
      await renderChat();
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
window.LB = {
  contact: {
    addInput:     contactAddInput,
    generateList: contactGenerateList,
  },
};

// ─── BOOT ──────────────────────────────────────────────────────────────────────
initNav();
updateAuthNav();

// Wire logout buttons
["navLogout","drawerLogout"].forEach(function(id) {
  var el = $(id);
  if (!el) return;
  el.addEventListener("click", async function() {
    try { await fetch("/api/auth/logout",{method:"POST",headers:AUTH.headers()}); } catch(e){}
    AUTH.clear();
    updateAuthNav();
    navigate("#/");
  });
});

// Load user count banner from stats (non-blocking)
api.stats().then(function(s) {
  if (s && s.users != null) {
    var ucn = $("userCountNum"); if (ucn) ucn.textContent = String(s.users);
  }
}).catch(function(){});

window.addEventListener("hashchange", function() { dispatch(); });
dispatch();
