export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // =========================================================================
    // HELPERS
    // =========================================================================

    // Decode Basic Auth — splits only on the FIRST colon so passwords with
    // colons work correctly.
    const checkAuth = async (req) => {
      const auth = req.headers.get("Authorization");
      if (!auth || !auth.startsWith("Basic ")) return null;
      try {
        const decoded = atob(auth.split(" ")[1]);
        const i = decoded.indexOf(":");
        if (i === -1) return null;
        const user = decoded.substring(0, i);
        const pass = decoded.substring(i + 1);
        // Main admin: checked against env secret — no DB round-trip needed
        if (user === "admin" && pass === env.ADMIN_PASSWORD) {
          return { user, role: "main" };
        }
        // Sub-admin: DB lookup
        const row = await env.DB
          .prepare("SELECT username, role FROM admin_users WHERE username = ? AND password = ?")
          .bind(user, pass)
          .first();
        return row ? { user: row.username, role: row.role } : null;
      } catch {
        return null;
      }
    };

    // ORDER BY whitelist — the ONLY values that ever touch the query string.
    // Any sort param not in this map falls back to "newest" silently.
    const SORT_MAP = {
      newest:        "timestamp DESC",
      oldest:        "timestamp ASC",
      lvlHigh:       "CAST(lvl AS INTEGER) DESC, timestamp DESC",
      lvlLow:        "CAST(lvl AS INTEGER) ASC, timestamp DESC",
      mostDebunked:  "debunk_count DESC, timestamp DESC",
      recentCorrect: "last_corrected DESC, timestamp DESC",
    };

    // =========================================================================
    // PUBLIC: /api/check-version
    // =========================================================================
    if (url.pathname === "/api/check-version") {
      const row = await env.DB
        .prepare("SELECT version_number FROM site_metadata WHERE id = 1")
        .first();
      return new Response(JSON.stringify(row ?? { version_number: 1 }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
        },
      });
    }

    // =========================================================================
    // PUBLIC: /api/people
    // =========================================================================
    if (url.pathname === "/api/people") {
      const search      = (url.searchParams.get("search") || "").trim();
      const filterClass = (url.searchParams.get("class")  || "").trim();
      const sortParam   = url.searchParams.get("sort") || "newest";
      const orderBy     = SORT_MAP[sortParam] ?? SORT_MAP.newest;
      const cursor      = url.searchParams.get("cursor");

      let query    = "SELECT id, name, image, bio, claim, truth, sources, class, lvl, debunk_count, last_corrected, timestamp, created_by FROM people WHERE 1=1";
      const params = [];

      if (search) {
        query += " AND (name LIKE ? OR bio LIKE ?)";
        params.push(`%${search}%`, `%${search}%`);
      }
      if (filterClass && filterClass !== "all") {
        query += " AND class = ?";
        params.push(filterClass);
      }
      // Cursor pagination only applies to timestamp-ordered views
      if (cursor && (sortParam === "newest" || sortParam === "oldest")) {
        const cursorNum = parseInt(cursor, 10);
        if (!isNaN(cursorNum)) {
          query += sortParam === "newest" ? " AND timestamp < ?" : " AND timestamp > ?";
          params.push(cursorNum);
        }
      }

      // orderBy is 100% whitelisted above — safe to interpolate
      query += ` ORDER BY ${orderBy} LIMIT 50`;

      const { results } = await env.DB.prepare(query).bind(...params).all();
      const nextCursor  = results.length === 50
        ? results[results.length - 1].timestamp
        : null;

      return new Response(JSON.stringify({ data: results, nextCursor }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
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

      // Simple HTML escaper used for rendering server-side values into HTML
      function esc(s) {
        return String(s ?? "")
          .replace(/&/g, "&amp;").replace(/</g, "&lt;")
          .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }

      // ── GET /admin — render dashboard ──────────────────────────────────────
      if (request.method === "GET" && url.pathname === "/admin") {
        const meta = await env.DB
          .prepare("SELECT version_number FROM site_metadata WHERE id = 1")
          .first() ?? { version_number: 1 };

        // messages table is optional — don't crash if it hasn't been created
        let recentMessages = [];
        if (isMain) {
          try {
            const msgs = await env.DB
              .prepare("SELECT * FROM messages WHERE receiver = ? OR receiver = 'all' ORDER BY timestamp DESC LIMIT 10")
              .bind(authUser.user)
              .all();
            recentMessages = msgs.results ?? [];
          } catch { /* table not yet created — skip silently */ }
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
    body{font-family:system-ui,sans-serif;padding:24px;background:#0f172a;color:#e2e8f0;margin:0}
    h2{color:#f8fafc;margin:0 0 4px}
    h3{color:#94a3b8;border-bottom:1px solid #334155;padding-bottom:8px;margin-top:0}
    .card{background:#1e293b;padding:20px;border-radius:10px;margin-bottom:20px;border:1px solid #334155}
    .blue{border-color:#3b82f6!important} .red{border-color:#ef4444!important} .yellow{border-color:#f59e0b!important}
    input,textarea,select{width:100%;background:#0f172a;border:1px solid #475569;color:#e2e8f0;padding:10px;border-radius:6px;margin-bottom:10px;font-size:14px}
    input:focus,textarea:focus,select:focus{outline:none;border-color:#3b82f6}
    button{padding:10px 18px;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:14px}
    .btn-blue{background:#3b82f6;color:#fff} .btn-red{background:#ef4444;color:#fff} .btn-green{background:#22c55e;color:#fff}
    label{display:block;font-size:13px;color:#94a3b8;margin-bottom:4px}
    small{color:#64748b}
    .badge{display:inline-block;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:700;color:#fff;background:${isMain ? "#3b82f6" : "#64748b"}}
    .msg-box{background:#0f172a;border:1px solid #334155;border-radius:6px;padding:10px;margin-bottom:8px;font-size:13px;overflow:hidden}
  </style>
</head>
<body>
  <h2>LiarBoard Admin <span class="badge">${isMain ? "Main Admin" : "Sub Admin"}</span></h2>
  <p style="color:#94a3b8;margin-bottom:24px">Logged in as <strong style="color:#fff">${esc(authUser.user)}</strong></p>

  ${isMain ? `
  <div class="card blue">
    <h3>🔒 Version Control <small>(Main Admin only)</small></h3>
    <p style="color:#94a3b8">Current live version: <strong style="color:#fff">${esc(String(meta.version_number))}</strong></p>
    <p style="color:#f59e0b;font-size:13px">⚠️ Bumping the version clears all user caches and forces a fresh D1 read. Do this after sub-admins finish a batch of entries.</p>
    <form action="/admin/update-version" method="POST">
      <label>New version number</label>
      <input name="new_ver" type="number" step="0.1" min="0.1" value="${esc(String(meta.version_number))}" style="max-width:140px">
      <button type="submit" class="btn-blue">Publish &amp; Bump Version</button>
    </form>
  </div>` : `
  <div class="card yellow">
    <p style="color:#f59e0b;margin:0">ℹ️ Sub-admin: you can add entries below, but only the Main Admin can bump the version to make them live to users.</p>
  </div>`}

  <div class="card">
    <h3>➕ Add New Entry</h3>
    <form action="/admin/add-person" method="POST">
      <label>Full Name *</label>
      <input name="name" placeholder="e.g. Jane Smith" required>
      <label>Image URL(s) * <small>(comma-separated for multiple)</small></label>
      <input name="image" placeholder="https://example.com/photo.jpg" required>
      <label>Bio / Description</label>
      <textarea name="bio" rows="3" placeholder="Brief public description..."></textarea>
      <label>The Claim <small>(what they publicly said)</small></label>
      <textarea name="claim" rows="2" placeholder="What they claimed..."></textarea>
      <label>The Truth <small>(the verified fact)</small></label>
      <textarea name="truth" rows="2" placeholder="What actually happened..."></textarea>
      <label>Sources <small>(comma-separated URLs backing the truth)</small></label>
      <textarea name="sources" rows="2" placeholder="https://source1.com, https://source2.com"></textarea>
      <label>Class</label>
      <select name="class">
        <option value="Politician">Politician</option>
        <option value="CEO">CEO</option>
        <option value="Media">Media</option>
        <option value="Celebrity">Celebrity</option>
        <option value="Influencer">Influencer</option>
        <option value="Official">Official</option>
        <option value="Other">Other</option>
      </select>
      <label>Level <small>(1–100, represents influence/notoriety)</small></label>
      <input name="lvl" type="number" min="1" max="100" value="50">
      <button type="submit" class="btn-green">Submit Entry</button>
    </form>
  </div>

  ${isMain ? `
  <div class="card red">
    <h3>🗑️ Delete Entry <small>(Main Admin only)</small></h3>
    <form action="/admin/delete-person" method="POST" onsubmit="return confirm('Permanently delete this entry? This cannot be undone.')">
      <label>Entry ID</label>
      <input name="id" type="number" placeholder="Numeric ID" required style="max-width:140px">
      <button type="submit" class="btn-red">Delete Entry</button>
    </form>
  </div>
  <div class="card">
    <h3>📬 Recent Messages</h3>
    ${msgHtml}
  </div>` : ""}

</body>
</html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      // ── POST /admin/update-version ─────────────────────────────────────────
      if (url.pathname === "/admin/update-version" && request.method === "POST") {
        if (!isMain) return new Response("Forbidden", { status: 403 });
        const f      = await request.formData();
        const newVer = parseFloat(f.get("new_ver"));
        if (isNaN(newVer) || newVer <= 0) return new Response("Invalid version number.", { status: 400 });
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
        const f = await request.formData();
        const name    = (f.get("name")    ?? "").trim();
        const image   = (f.get("image")   ?? "").trim();
        const bio     = (f.get("bio")     ?? "").trim();
        const claim   = (f.get("claim")   ?? "").trim();
        const truth   = (f.get("truth")   ?? "").trim();
        const sources = (f.get("sources") ?? "").trim();
        const cls     = (f.get("class")   ?? "Other").trim();
        const lvl     = Math.min(100, Math.max(1, parseInt(f.get("lvl"), 10) || 50));

        if (!name || !image) return new Response("Name and Image URL are required.", { status: 400 });

        await env.DB
          .prepare("INSERT INTO people (name, image, bio, claim, truth, sources, class, lvl, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(name, image, bio, claim, truth, sources, cls, lvl, authUser.user)
          .run();

        return Response.redirect(`${origin}/admin`, 302);
      }

      // Any unrecognised /admin/* path → redirect to dashboard
      return Response.redirect(`${origin}/admin`, 302);
    }

    // =========================================================================
    // FALLBACK: Cloudflare Pages static assets
    // =========================================================================
    return env.ASSETS.fetch(request);
  },
};
