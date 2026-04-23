export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // =========================================================================
    // HELPERS
    // =========================================================================
    const checkAuth = async (req) => {
      const auth = req.headers.get("Authorization");
      if (!auth || !auth.startsWith("Basic ")) return null;
      try {
        const decoded = atob(auth.split(" ")[1]);
        const i = decoded.indexOf(":");
        if (i === -1) return null;
        const user = decoded.substring(0, i);
        const pass = decoded.substring(i + 1);
        if (user === "admin" && pass === env.ADMIN_PASSWORD) return { user, role: "main" };
        const row = await env.DB
          .prepare("SELECT username, role FROM admin_users WHERE username = ? AND password = ?")
          .bind(user, pass).first();
        return row ? { user: row.username, role: row.role } : null;
      } catch { return null; }
    };

    // ORDER BY whitelist — safe to interpolate because only these values can pass
    const SORT_MAP = {
      newest:        "timestamp DESC",
      oldest:        "timestamp ASC",
      lvlHigh:       "CAST(lvl AS INTEGER) DESC, timestamp DESC",
      lvlLow:        "CAST(lvl AS INTEGER) ASC, timestamp DESC",
      mostDebunked:  "debunk_count DESC, timestamp DESC",
      recentCorrect: "last_corrected DESC, timestamp DESC",
    };

    const VALID_CLASSES = new Set(["Politician","CEO","Media","Celebrity","Influencer","Official","Other"]);

    // Common response helpers
    const jsonResp = (data, status = 200, extra = {}) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...extra },
      });

    const COLS = "id, name, image, bio, claim, truth, sources, class, lvl, debunk_count, last_corrected, timestamp, created_by";

    // =========================================================================
    // PUBLIC: /api/check-version
    // =========================================================================
    if (url.pathname === "/api/check-version") {
      const row = await env.DB
        .prepare("SELECT version_number FROM site_metadata WHERE id = 1").first();
      return jsonResp(row ?? { version_number: 1 }, 200, {
        "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
      });
    }

    // =========================================================================
    // PUBLIC: /api/stats  — total entries + entries with a claim
    // =========================================================================
    if (url.pathname === "/api/stats") {
      const row = await env.DB
        .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN claim IS NOT NULL AND claim != '' THEN 1 ELSE 0 END) AS debunked FROM people")
        .first();
      return jsonResp(row ?? { total: 0, debunked: 0 }, 200, {
        "Cache-Control": "public, max-age=60",
      });
    }

    // =========================================================================
    // PUBLIC: /api/person/:id  — single person by ID
    // =========================================================================
    const personMatch = url.pathname.match(/^\/api\/person\/(\d+)$/);
    if (personMatch) {
      const id = parseInt(personMatch[1], 10);
      if (isNaN(id)) return jsonResp({ error: "Invalid ID" }, 400);
      const row = await env.DB
        .prepare(`SELECT ${COLS} FROM people WHERE id = ?`).bind(id).first();
      if (!row) return jsonResp({ error: "Not found" }, 404);
      return jsonResp(row, 200, { "Cache-Control": "no-store" });
    }

    // =========================================================================
    // PUBLIC: /api/people  — paginated list with optional class/sort/search
    // =========================================================================
    if (url.pathname === "/api/people") {
      const search      = (url.searchParams.get("search") || "").trim();
      const filterClass = (url.searchParams.get("class")  || "").trim();
      const sortParam   = url.searchParams.get("sort") || "newest";
      const orderBy     = SORT_MAP[sortParam] ?? SORT_MAP.newest;
      const cursor      = url.searchParams.get("cursor");

      // Validate class against whitelist to prevent unexpected queries
      if (filterClass && filterClass !== "all" && !VALID_CLASSES.has(filterClass)) {
        return jsonResp({ data: [], nextCursor: null });
      }

      let query  = `SELECT ${COLS} FROM people WHERE 1=1`;
      const params = [];

      if (search) {
        query += " AND (name LIKE ? OR bio LIKE ?)";
        params.push(`%${search}%`, `%${search}%`);
      }
      if (filterClass && filterClass !== "all") {
        query += " AND class = ?";
        params.push(filterClass);
      }
      if (cursor && (sortParam === "newest" || sortParam === "oldest")) {
        const cursorNum = parseInt(cursor, 10);
        if (!isNaN(cursorNum)) {
          query += sortParam === "newest" ? " AND timestamp < ?" : " AND timestamp > ?";
          params.push(cursorNum);
        }
      }

      query += ` ORDER BY ${orderBy} LIMIT 50`;

      const { results } = await env.DB.prepare(query).bind(...params).all();
      const nextCursor  = results.length === 50 ? results[results.length - 1].timestamp : null;

      return jsonResp({ data: results, nextCursor }, 200, { "Cache-Control": "no-store" });
    }

    // =========================================================================
    // ADMIN: /admin and /admin/*
    // =========================================================================
    if (url.pathname.startsWith("/admin")) {
      const authUser = await checkAuth(request);
      if (!authUser) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="LiarBoard Admin"' },
        });
      }

      const isMain = authUser.role === "main";
      const origin = url.origin;

      function esc(s) {
        return String(s ?? "")
          .replace(/&/g,"&amp;").replace(/</g,"&lt;")
          .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
      }

      const CLASS_OPTIONS = ["Politician","CEO","Media","Celebrity","Influencer","Official","Other"]
        .map(c => `<option value="${c}">${c}</option>`).join("");

      // ── GET /admin ──────────────────────────────────────────────────────────
      if (request.method === "GET" && url.pathname === "/admin") {
        const meta = await env.DB
          .prepare("SELECT version_number FROM site_metadata WHERE id = 1").first() ?? { version_number: 1 };

        let recentMessages = [];
        if (isMain) {
          try {
            const msgs = await env.DB
              .prepare("SELECT * FROM messages WHERE receiver = ? OR receiver = 'all' ORDER BY timestamp DESC LIMIT 10")
              .bind(authUser.user).all();
            recentMessages = msgs.results ?? [];
          } catch { /* messages table optional */ }
        }

        const msgHtml = recentMessages.length === 0
          ? '<p style="color:#64748b;margin:0">No messages.</p>'
          : recentMessages.map(m =>
              `<div class="msg-box"><strong>${esc(m.sender ?? "System")}:</strong> ${esc(m.body ?? "")}
               <span style="float:right;color:#64748b">${new Date(m.timestamp).toLocaleDateString()}</span></div>`
            ).join("");

        return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>LiarBoard Admin</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:system-ui,sans-serif;padding:0;background:#0f172a;color:#e2e8f0;margin:0}
    .top-bar{background:#1e293b;padding:16px 24px;border-bottom:1px solid #334155;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
    .top-bar h1{margin:0;font-size:1.2rem;color:#f8fafc}
    .badge{display:inline-block;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:700;color:#fff;background:${isMain?"#3b82f6":"#64748b"};margin-left:8px}
    .content{max-width:860px;margin:0 auto;padding:24px}
    h3{color:#94a3b8;border-bottom:1px solid #334155;padding-bottom:8px;margin-top:0;font-size:14px;text-transform:uppercase;letter-spacing:0.8px}
    .card{background:#1e293b;padding:20px;border-radius:10px;margin-bottom:20px;border:1px solid #334155}
    .blue{border-color:#3b82f6!important}.red{border-color:#ef4444!important}.yellow{border-color:#f59e0b!important}.green{border-color:#22c55e!important}
    input,textarea,select{width:100%;background:#0f172a;border:1px solid #475569;color:#e2e8f0;padding:10px;border-radius:6px;margin-bottom:10px;font-size:14px;font-family:inherit}
    input:focus,textarea:focus,select:focus{outline:none;border-color:#3b82f6}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    button{padding:10px 18px;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:14px}
    .btn-blue{background:#3b82f6;color:#fff}.btn-red{background:#ef4444;color:#fff}.btn-green{background:#22c55e;color:#fff}.btn-yellow{background:#f59e0b;color:#000}
    label{display:block;font-size:12px;color:#94a3b8;margin-bottom:3px}
    small{color:#64748b;font-size:12px}
    .msg-box{background:#0f172a;border:1px solid #334155;border-radius:6px;padding:10px;margin-bottom:8px;font-size:13px;overflow:hidden}
    .warn{color:#f59e0b;font-size:13px}
  </style>
</head>
<body>
  <div class="top-bar">
    <h1>LiarBoard Admin<span class="badge">${isMain?"Main Admin":"Sub Admin"}</span></h1>
    <span style="color:#94a3b8;font-size:13px">Logged in as <strong style="color:#fff">${esc(authUser.user)}</strong></span>
  </div>
  <div class="content">

  ${isMain ? `
  <div class="card blue">
    <h3>🔒 Version Control</h3>
    <p style="color:#94a3b8">Current live version: <strong style="color:#fff">${esc(String(meta.version_number))}</strong></p>
    <p class="warn">⚠️ Bumping the version clears every user's cache and forces a fresh D1 read. Do this after finishing a batch of entries.</p>
    <form action="/admin/update-version" method="POST" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
      <div>
        <label>New version number</label>
        <input name="new_ver" type="number" step="0.1" min="0.1" value="${esc(String(meta.version_number))}" style="max-width:130px;margin-bottom:0">
      </div>
      <button type="submit" class="btn-blue">Publish &amp; Bump</button>
    </form>
  </div>` : `
  <div class="card yellow">
    <p style="color:#f59e0b;margin:0">ℹ️ Sub-admin: You can add entries. Only the Main Admin can bump the version, delete, or edit entries.</p>
  </div>`}

  <div class="card">
    <h3>➕ Add New Entry</h3>
    <form action="/admin/add-person" method="POST">
      <div class="row">
        <div><label>Full Name *</label><input name="name" placeholder="e.g. Jane Smith" required></div>
        <div><label>Image URL(s) * <small>(comma-separated)</small></label><input name="image" placeholder="https://…" required></div>
      </div>
      <label>Bio / Description</label>
      <textarea name="bio" rows="2" placeholder="Brief public description…"></textarea>
      <div class="row">
        <div><label>The Claim <small>(what they said)</small></label><textarea name="claim" rows="2" placeholder="What they claimed…"></textarea></div>
        <div><label>The Truth <small>(verified fact)</small></label><textarea name="truth" rows="2" placeholder="What actually happened…"></textarea></div>
      </div>
      <label>Sources <small>(comma-separated URLs)</small></label>
      <textarea name="sources" rows="2" placeholder="https://source1.com, https://source2.com"></textarea>
      <div class="row">
        <div><label>Class</label><select name="class">${CLASS_OPTIONS}</select></div>
        <div><label>Level <small>(1–100)</small></label><input name="lvl" type="number" min="1" max="100" value="50"></div>
      </div>
      <button type="submit" class="btn-green">Submit Entry</button>
    </form>
  </div>

  ${isMain ? `
  <div class="card green">
    <h3>✏️ Edit Entry by ID</h3>
    <p style="color:#94a3b8;font-size:13px;margin-bottom:12px">Look up an entry by ID to pre-fill the edit form, then submit changes.</p>
    <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">
      <input type="number" id="lookupId" placeholder="Entry ID" style="max-width:130px;margin-bottom:0">
      <button type="button" class="btn-yellow" onclick="lookupEntry()">Look Up</button>
    </div>
    <form action="/admin/update-person" method="POST" id="editForm" style="display:none">
      <input type="hidden" name="id" id="editId">
      <div class="row">
        <div><label>Full Name *</label><input name="name" id="editName" required></div>
        <div><label>Image URL(s) * <small>(comma-separated)</small></label><input name="image" id="editImage" required></div>
      </div>
      <label>Bio</label>
      <textarea name="bio" id="editBio" rows="2"></textarea>
      <div class="row">
        <div><label>The Claim</label><textarea name="claim" id="editClaim" rows="2"></textarea></div>
        <div><label>The Truth</label><textarea name="truth" id="editTruth" rows="2"></textarea></div>
      </div>
      <label>Sources</label>
      <textarea name="sources" id="editSources" rows="2"></textarea>
      <div class="row">
        <div><label>Class</label><select name="class" id="editClass">${CLASS_OPTIONS}</select></div>
        <div><label>Level (1–100)</label><input name="lvl" id="editLvl" type="number" min="1" max="100"></div>
      </div>
      <button type="submit" class="btn-yellow">Save Changes</button>
    </form>
  </div>

  <div class="card red">
    <h3>🗑️ Delete Entry</h3>
    <form action="/admin/delete-person" method="POST" onsubmit="return confirm('Permanently delete? Cannot be undone.')">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
        <div><label>Entry ID</label><input name="id" type="number" placeholder="Numeric ID" required style="max-width:130px;margin-bottom:0"></div>
        <button type="submit" class="btn-red">Delete Entry</button>
      </div>
    </form>
  </div>

  <div class="card">
    <h3>📬 Recent Messages</h3>
    ${msgHtml}
  </div>

  <script>
  async function lookupEntry() {
    const id = document.getElementById('lookupId').value;
    if (!id) return;
    try {
      const r = await fetch('/api/person/' + id);
      if (!r.ok) { alert('Entry not found (ID: ' + id + ')'); return; }
      const d = await r.json();
      document.getElementById('editId').value      = d.id;
      document.getElementById('editName').value    = d.name    || '';
      document.getElementById('editImage').value   = d.image   || '';
      document.getElementById('editBio').value     = d.bio     || '';
      document.getElementById('editClaim').value   = d.claim   || '';
      document.getElementById('editTruth').value   = d.truth   || '';
      document.getElementById('editSources').value = d.sources || '';
      document.getElementById('editLvl').value     = d.lvl     || 50;
      const cls = document.getElementById('editClass');
      for (const opt of cls.options) { if (opt.value === d.class) { opt.selected = true; break; } }
      document.getElementById('editForm').style.display = 'block';
    } catch(e) { alert('Error: ' + e.message); }
  }
  </script>` : ""}

  </div><!-- /content -->
</body>
</html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      // ── POST /admin/update-version ─────────────────────────────────────────
      if (url.pathname === "/admin/update-version" && request.method === "POST") {
        if (!isMain) return new Response("Forbidden", { status: 403 });
        const f      = await request.formData();
        const newVer = parseFloat(f.get("new_ver"));
        if (isNaN(newVer) || newVer <= 0) return new Response("Invalid version.", { status: 400 });
        await env.DB.prepare("UPDATE site_metadata SET version_number = ? WHERE id = 1").bind(newVer).run();
        return Response.redirect(`${origin}/admin`, 302);
      }

      // ── POST /admin/delete-person ──────────────────────────────────────────
      if (url.pathname === "/admin/delete-person" && request.method === "POST") {
        if (!isMain) return new Response("Forbidden", { status: 403 });
        const f  = await request.formData();
        const id = parseInt(f.get("id"), 10);
        if (isNaN(id)) return new Response("Invalid ID.", { status: 400 });
        await env.DB.prepare("DELETE FROM people WHERE id = ?").bind(id).run();
        return Response.redirect(`${origin}/admin`, 302);
      }

      // ── POST /admin/add-person (all admins — does NOT bump version) ─────────
      if (url.pathname === "/admin/add-person" && request.method === "POST") {
        const f       = await request.formData();
        const name    = (f.get("name")    ?? "").trim();
        const image   = (f.get("image")   ?? "").trim();
        const bio     = (f.get("bio")     ?? "").trim();
        const claim   = (f.get("claim")   ?? "").trim();
        const truth   = (f.get("truth")   ?? "").trim();
        const sources = (f.get("sources") ?? "").trim();
        const cls     = VALID_CLASSES.has((f.get("class") ?? "").trim()) ? (f.get("class")).trim() : "Other";
        const lvl     = Math.min(100, Math.max(1, parseInt(f.get("lvl"), 10) || 50));

        if (!name || !image) return new Response("Name and Image are required.", { status: 400 });

        await env.DB.prepare(
          "INSERT INTO people (name,image,bio,claim,truth,sources,class,lvl,created_by) VALUES (?,?,?,?,?,?,?,?,?)"
        ).bind(name, image, bio, claim, truth, sources, cls, lvl, authUser.user).run();

        return Response.redirect(`${origin}/admin`, 302);
      }

      // ── POST /admin/update-person (main admin only) ────────────────────────
      if (url.pathname === "/admin/update-person" && request.method === "POST") {
        if (!isMain) return new Response("Forbidden", { status: 403 });
        const f       = await request.formData();
        const id      = parseInt(f.get("id"), 10);
        if (isNaN(id)) return new Response("Invalid ID.", { status: 400 });
        const name    = (f.get("name")    ?? "").trim();
        const image   = (f.get("image")   ?? "").trim();
        const bio     = (f.get("bio")     ?? "").trim();
        const claim   = (f.get("claim")   ?? "").trim();
        const truth   = (f.get("truth")   ?? "").trim();
        const sources = (f.get("sources") ?? "").trim();
        const cls     = VALID_CLASSES.has((f.get("class") ?? "").trim()) ? (f.get("class")).trim() : "Other";
        const lvl     = Math.min(100, Math.max(1, parseInt(f.get("lvl"), 10) || 50));
        const now     = Date.now();

        if (!name || !image) return new Response("Name and Image are required.", { status: 400 });

        await env.DB.prepare(
          "UPDATE people SET name=?,image=?,bio=?,claim=?,truth=?,sources=?,class=?,lvl=?,last_corrected=? WHERE id=?"
        ).bind(name, image, bio, claim, truth, sources, cls, lvl, now, id).run();

        return Response.redirect(`${origin}/admin`, 302);
      }

      return Response.redirect(`${origin}/admin`, 302);
    }

    // =========================================================================
    // SPA ROUTING: Return index.html for all non-API, non-admin paths
    // so that hash-based routing works correctly (browser refreshes on /index.html
    // always serve the shell; the hash fragment drives the view).
    // =========================================================================
    return env.ASSETS.fetch(request);
  },
};
