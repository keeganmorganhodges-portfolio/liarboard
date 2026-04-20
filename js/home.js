"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// DOM REFERENCES
// ─────────────────────────────────────────────────────────────────────────────
const grid        = document.getElementById("mainGrid");
const searchInput = document.getElementById("searchInput");
const filterSelect = document.getElementById("classFilter");
const sortSelect  = document.getElementById("sortOrder");
const modal       = document.getElementById("charModal");
const modalContent = document.getElementById("modalContent");

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
let people        = [];
let nextCursor    = null;
let isLoading     = false;
let allLoaded     = false;
let currentSearch = "";
let currentFilter = "all";
let currentSort   = "newest";

// Image carousel state (only active while modal is open)
let modalImages       = [];
let currentImageIndex = 0;

// ─────────────────────────────────────────────────────────────────────────────
// CACHE
// Only the default view (newest, no search, no filter, page 1) is cached in
// localStorage.  The main admin bumps version_number to invalidate it.
// Sub-admin adds do NOT bump the version; the main admin does that manually.
// ─────────────────────────────────────────────────────────────────────────────
const CACHE_KEY_DATA    = "lb_people_v2";
const CACHE_KEY_VERSION = "lb_site_version";

function isDefaultView() {
  return !currentSearch && currentFilter === "all" && currentSort === "newest";
}

async function fetchVersion() {
  try {
    const res = await fetch("/api/check-version");
    if (!res.ok) return null;
    const { version_number } = await res.json();
    return version_number != null ? String(version_number) : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY: HTML escape for any user-sourced string rendered via innerHTML
// ─────────────────────────────────────────────────────────────────────────────
function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA LOADING
// ─────────────────────────────────────────────────────────────────────────────
async function loadFromDB(reset = false) {
  if (isLoading || (allLoaded && !reset)) return;
  isLoading = true;

  if (reset) {
    people     = [];
    nextCursor = null;
    allLoaded  = false;
    grid.innerHTML = '<div class="meta load-msg">Loading…</div>';
  }

  // ── Cache check (only on a fresh default-view load) ──────────────────────
  if (reset && isDefaultView()) {
    const liveVer   = await fetchVersion();
    const cachedVer = localStorage.getItem(CACHE_KEY_VERSION);
    const cachedRaw = localStorage.getItem(CACHE_KEY_DATA);

    if (liveVer && liveVer === cachedVer && cachedRaw) {
      try {
        people    = JSON.parse(cachedRaw);
        allLoaded = true;
        render();
        isLoading = false;
        return;
      } catch {
        localStorage.removeItem(CACHE_KEY_DATA); // corrupt — discard
      }
    }
    // Always write the latest version so a bump invalidates on next visit
    if (liveVer) localStorage.setItem(CACHE_KEY_VERSION, liveVer);
  }

  // ── Build API URL ─────────────────────────────────────────────────────────
  const params = new URLSearchParams({ sort: currentSort });
  if (nextCursor)            params.set("cursor", String(nextCursor));
  if (currentSearch)         params.set("search", currentSearch);
  if (currentFilter !== "all") params.set("class", currentFilter);

  // Snapshot whether this is a cacheable request BEFORE the await
  const willCache = reset && isDefaultView();

  try {
    const res = await fetch(`/api/people?${params}`);
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const payload  = await res.json();
    const incoming = Array.isArray(payload.data) ? payload.data : [];

    people     = [...people, ...incoming];
    nextCursor = payload.nextCursor ?? null;
    if (!nextCursor) allLoaded = true;

    // Cache only the complete first-page default result
    if (willCache && allLoaded) {
      try {
        localStorage.setItem(CACHE_KEY_DATA, JSON.stringify(people));
      } catch { /* quota exceeded — skip silently */ }
    }

    render();
  } catch (err) {
    grid.innerHTML = `<div class="meta" style="color:#ef4444">⚠️ Failed to load: ${esc(err.message)}</div>`;
  } finally {
    isLoading = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDERING
// ─────────────────────────────────────────────────────────────────────────────
function updateFilterCounts() {
  if (!filterSelect) return;
  const counts = {};
  people.forEach(p => { counts[p.class] = (counts[p.class] || 0) + 1; });
  for (const opt of filterSelect.options) {
    const base = opt.textContent.split(" (")[0];
    if (opt.value === "all") {
      opt.textContent = `${base} (${people.length}${allLoaded ? "" : "+"})`;
    } else {
      const n = counts[opt.value] || 0;
      opt.textContent = `${base} (${n}${allLoaded || n === 0 ? "" : "+"})`;
    }
  }
}

function render() {
  if (!grid) return;
  updateFilterCounts();

  if (people.length === 0) {
    const hasFilters = currentSearch || currentFilter !== "all" || currentSort !== "newest";
    grid.innerHTML = `
      <div class="empty-state">
        <p>No results found.</p>
        ${hasFilters ? `<button class="clear-filters-btn" onclick="clearFilters()">✕ Clear Filters</button>` : ""}
      </div>`;
    return;
  }

  // Broken-image fallback as a data-URI (no external request)
  const fallbackSvg = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='280' height='220'%3E%3Crect width='280' height='220' fill='%231e293b'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%2364748b' font-size='14'%3ENo Image%3C/text%3E%3C/svg%3E`;

  grid.innerHTML = people.map((c, i) => {
    const firstImg = esc(c.image ? c.image.split(",")[0].trim() : "");
    const hasClaim = c.claim && c.claim.trim() !== "";
    return `
      <div class="card" onclick="openDetails(${Number(c.id)})">
        <img
          src="${firstImg}"
          class="card-img"
          alt="${esc(c.name)}"
          loading="${i < 4 ? "eager" : "lazy"}"
          onerror="this.onerror=null;this.src='${fallbackSvg}'"
        >
        <div class="card-info">
          <h3>${esc(c.name)}</h3>
          <div class="meta">${esc(c.class)} · Lvl ${esc(String(c.lvl ?? "?"))}</div>
          ${hasClaim ? `<div class="claim-badge">⚡ Claim on record</div>` : ""}
          <div class="meta timestamp-meta">Added: ${new Date(c.timestamp).toLocaleDateString()}</div>
        </div>
      </div>`;
  }).join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// CLEAR FILTERS
// ─────────────────────────────────────────────────────────────────────────────
window.clearFilters = () => {
  currentSearch = "";
  currentFilter = "all";
  currentSort   = "newest";
  if (searchInput)   searchInput.value   = "";
  if (filterSelect)  filterSelect.value  = "all";
  if (sortSelect)    sortSelect.value    = "newest";
  loadFromDB(true);
};

// ─────────────────────────────────────────────────────────────────────────────
// MODAL
// ─────────────────────────────────────────────────────────────────────────────
const fallbackModalSvg = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3Crect width='400' height='400' fill='%231e293b'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%2364748b' font-size='16'%3ENo Image%3C/text%3E%3C/svg%3E`;

window.openDetails = (id) => {
  const c = people.find(p => p.id === id);
  if (!c) return;
  modalImages       = c.image ? c.image.split(",").map(s => s.trim()).filter(Boolean) : [];
  currentImageIndex = 0;
  renderModal(c);
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
};

function renderModal(c) {
  const multi      = modalImages.length > 1;
  const hasClaim   = c.claim   && c.claim.trim()   !== "";
  const hasTruth   = c.truth   && c.truth.trim()   !== "";
  const hasSources = c.sources && c.sources.trim() !== "";
  const hasDebunk  = hasClaim || hasTruth;

  // Sources block
  let sourcesHtml = "";
  if (hasSources) {
    const links = c.sources.split(",").map(s => s.trim()).filter(Boolean);
    sourcesHtml = `
      <div class="sources-section">
        <strong class="sources-label">🔗 Sources</strong>
        ${links.map((l, i) =>
          `<a href="${esc(l)}" target="_blank" rel="noopener noreferrer" class="source-link">Source ${i + 1}</a>`
        ).join("")}
      </div>`;
  }

  // Claim / Truth toggle
  let debunkHtml = "";
  if (hasDebunk) {
    debunkHtml = `
      <div class="claim-truth-container">
        <div class="flip-tabs">
          <button class="flip-tab active" id="claimTab" onclick="showPanel('claim')">⚡ The Claim</button>
          <button class="flip-tab"        id="truthTab" onclick="showPanel('truth')">✅ The Truth</button>
        </div>
        <div id="claimPanel" class="claim-panel">
          <p>${hasClaim ? esc(c.claim) : "<em>No claim recorded.</em>"}</p>
        </div>
        <div id="truthPanel" class="truth-panel" style="display:none">
          <p>${hasTruth ? esc(c.truth) : "<em>No verified truth recorded yet.</em>"}</p>
          ${sourcesHtml}
        </div>
      </div>`;
  }

  const imgSrc = modalImages[0] ? esc(modalImages[0]) : fallbackModalSvg;

  modalContent.innerHTML = `
    <button class="modal-close" onclick="closeModal()" aria-label="Close">✕</button>
    <div class="modal-body">
      <div class="carousel-container">
        <img
          src="${imgSrc}"
          class="modal-img"
          id="carouselImg"
          alt="${esc(c.name)}"
          onerror="this.onerror=null;this.src='${fallbackModalSvg}'"
        >
        ${multi ? `
          <button class="prev-img" onclick="changeImg(-1)" aria-label="Previous image">&#10094;</button>
          <button class="next-img" onclick="changeImg(1)"  aria-label="Next image">&#10095;</button>
          <div class="img-counter" id="imgCounter">1 / ${modalImages.length}</div>
        ` : ""}
      </div>
      <div class="modal-text">
        <h2 style="margin:0 0 4px;color:var(--accent)">${esc(c.name)}</h2>
        <p style="color:#94a3b8;font-size:13px;margin:0 0 4px">${esc(c.class)} · Level ${esc(String(c.lvl ?? "?"))}</p>
        <p style="font-size:12px;color:#64748b;margin:0 0 14px">
          Added: ${new Date(c.timestamp).toLocaleDateString()}
          ${c.last_corrected ? ` · Corrected: ${new Date(c.last_corrected).toLocaleDateString()}` : ""}
          ${c.debunk_count   ? ` · <span style="color:#f59e0b">⚡ ${esc(String(c.debunk_count))} debunks</span>` : ""}
        </p>
        ${c.bio ? `<p style="color:#e2e8f0;font-size:0.92rem;line-height:1.6;margin-bottom:14px">${esc(c.bio)}</p>` : ""}
        ${debunkHtml}
        ${!hasDebunk && hasSources ? sourcesHtml : ""}
      </div>
    </div>`;
}

window.showPanel = (panel) => {
  const cp = document.getElementById("claimPanel");
  const tp = document.getElementById("truthPanel");
  const ct = document.getElementById("claimTab");
  const tt = document.getElementById("truthTab");
  if (!cp || !tp) return;
  const isClaim = panel === "claim";
  cp.style.display = isClaim ? "" : "none";
  tp.style.display = isClaim ? "none" : "";
  ct.classList.toggle("active", isClaim);
  tt.classList.toggle("active", !isClaim);
};

window.changeImg = (step) => {
  if (modalImages.length <= 1) return;
  currentImageIndex = (currentImageIndex + step + modalImages.length) % modalImages.length;
  const img     = document.getElementById("carouselImg");
  const counter = document.getElementById("imgCounter");
  if (img)     { img.src = esc(modalImages[currentImageIndex]); }
  if (counter) { counter.textContent = `${currentImageIndex + 1} / ${modalImages.length}`; }
};

window.closeModal = () => {
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
};

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function debounce(fn, ms = 500) {
  let t;
  // Use a regular function (not arrow) so `this` binds correctly
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener("scroll", () => {
  if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 600) {
    loadFromDB();
  }
});

if (searchInput) {
  searchInput.addEventListener(
    "input",
    debounce(function (e) {
      currentSearch = e.target.value.trim();
      loadFromDB(true);
    })
  );
}

if (filterSelect) {
  filterSelect.addEventListener("change", (e) => {
    currentFilter = e.target.value;
    loadFromDB(true);
  });
}

if (sortSelect) {
  sortSelect.addEventListener("change", (e) => {
    currentSort = e.target.value;
    loadFromDB(true);
  });
}

// Close on backdrop click
window.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

// Close on Escape
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modal && modal.style.display === "flex") closeModal();
});

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────
loadFromDB(true);
