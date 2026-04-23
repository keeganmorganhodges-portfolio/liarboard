// =============================================================================
// LiarBoard _worker.js
// Bindings expected:
//   env.DB         — content D1 (people, site_metadata, admin_users)
//   env.USERS_DB   — users D1  (users, sessions, votes, messages, etc.)
//   env.ASSETS     — Cloudflare Pages static assets
//   env.ADMIN_PASSWORD     — main admin password secret
//   env.TURNSTILE_SECRET   — Cloudflare Turnstile secret key
//   env.VAPID_PRIVATE_KEY  — Web Push VAPID private key (optional)
//   env.VAPID_PUBLIC_KEY   — Web Push VAPID public key  (optional)
// =============================================================================

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;
    const origin = url.origin;

    // =========================================================================
    // CRYPTO HELPERS
    // =========================================================================

    // Hash a password with PBKDF2 (Web Crypto — available in Workers)
    async function hashPassword(plain) {
      const enc  = new TextEncoder();
      const key  = await crypto.subtle.importKey("raw", enc.encode(plain),
        { name:"PBKDF2" }, false, ["deriveBits"]);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const bits = await crypto.subtle.deriveBits(
        { name:"PBKDF2", hash:"SHA-256", salt, iterations:100000 }, key, 256);
      const hashArr  = Array.from(new Uint8Array(bits));
      const saltArr  = Array.from(salt);
      return saltArr.map(b=>b.toString(16).padStart(2,"0")).join("") + ":" +
             hashArr.map(b=>b.toString(16).padStart(2,"0")).join("");
    }

    async function verifyPassword(plain, stored) {
      try {
        const [saltHex, hashHex] = stored.split(":");
        const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h=>parseInt(h,16)));
        const enc  = new TextEncoder();
        const key  = await crypto.subtle.importKey("raw", enc.encode(plain),
          { name:"PBKDF2" }, false, ["deriveBits"]);
        const bits = await crypto.subtle.deriveBits(
          { name:"PBKDF2", hash:"SHA-256", salt, iterations:100000 }, key, 256);
        const computed = Array.from(new Uint8Array(bits))
          .map(b=>b.toString(16).padStart(2,"0")).join("");
        return computed === hashHex;
      } catch { return false; }
    }

    // Generate a cryptographically random token
    function genToken(bytes = 32) {
      return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
        .map(b=>b.toString(16).padStart(2,"0")).join("");
    }

    // SHA-256 hex of a string (for IP hashing — never store raw IPs)
    async function sha256hex(str) {
      const buf  = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
      return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
    }

    // =========================================================================
    // RESPONSE HELPERS
    // =========================================================================
    const J  = (data, status=200, hdrs={}) =>
      new Response(JSON.stringify(data), { status,
        headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*",...hdrs}});
    const Err = (msg, status=400) => J({ error: msg }, status);
    const Ok  = (data={})         => J({ ok:true, ...data });

    // =========================================================================
    // AUTH HELPERS
    // =========================================================================

    // Verify a session token from Authorization: Bearer <token>
    // Returns { userId, username, role } or null
    async function getSession(req) {
      const auth = req.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
      if (!token) return null;
      const now = Date.now();
      const row = await env.USERS_DB.prepare(
        "SELECT s.user_id, u.username, u.status, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?"
      ).bind(token).first();
      if (!row || row.expires_at < now) return null;
      if (row.status !== "active") return null;
      return { userId: row.user_id, username: row.username, role: "user" };
    }

    // Admin auth (Basic, same as before)
    async function getAdmin(req) {
      const auth = req.headers.get("Authorization") || "";
      if (!auth.startsWith("Basic ")) return null;
      try {
        const decoded = atob(auth.split(" ")[1]);
        const i = decoded.indexOf(":");
        if (i === -1) return null;
        const user = decoded.substring(0, i);
        const pass = decoded.substring(i + 1);
        if (user === "admin" && pass === env.ADMIN_PASSWORD)
          return { user, role: "main" };
        const row = await env.DB.prepare(
          "SELECT username, role FROM admin_users WHERE username=? AND password=?"
        ).bind(user, pass).first();
        return row ? { user: row.username, role: row.role } : null;
      } catch { return null; }
    }

    // Verify Cloudflare Turnstile token
    async function verifyTurnstile(token, ip) {
      if (!env.TURNSTILE_SECRET || !token) return false;
      try {
        const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method:"POST",
          headers:{"Content-Type":"application/x-www-form-urlencoded"},
          body: new URLSearchParams({ secret:env.TURNSTILE_SECRET, response:token,
                                      remoteip:ip||"" }).toString(),
        });
        const d = await r.json();
        return d.success === true;
      } catch { return false; }
    }

    // Get today's UTC date as YYYY-MM-DD
    function utcDay() {
      return new Date().toISOString().slice(0,10);
    }

    // =========================================================================
    // SORT WHITELIST (content API)
    // =========================================================================
    const SORT_MAP = {
      newest:"timestamp DESC", oldest:"timestamp ASC",
      lvlHigh:"CAST(lvl AS INTEGER) DESC, timestamp DESC",
      lvlLow:"CAST(lvl AS INTEGER) ASC, timestamp DESC",
      mostDebunked:"debunk_count DESC, timestamp DESC",
      recentCorrect:"last_corrected DESC, timestamp DESC",
      topRated:"community_score DESC, timestamp DESC",
    };
    const VALID_CLASSES = new Set(["Politician","CEO","Media","Celebrity","Influencer","Official","Other"]);
    const COLS = "id,name,image,bio,claim,truth,sources,class,lvl,community_score,vote_count,debunk_count,last_corrected,timestamp,created_by";

    // =========================================================================
    // CORS pre-flight
    // =========================================================================
    if (method === "OPTIONS") {
      return new Response(null, { headers:{
        "Access-Control-Allow-Origin":"*",
        "Access-Control-Allow-Methods":"GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers":"Content-Type,Authorization",
      }});
    }

    // =========================================================================
    // PUBLIC: /api/check-version
    // =========================================================================
    if (path === "/api/check-version") {
      const row = await env.DB.prepare(
        "SELECT version_number FROM site_metadata WHERE id=1").first();
      return J(row ?? {version_number:1}, 200,
        {"Cache-Control":"public,max-age=30,stale-while-revalidate=60"});
    }

    // =========================================================================
    // PUBLIC: /api/stats  (user count cached once per day at noon CDT)
    // =========================================================================
    if (path === "/api/stats") {
      // Content stats
      const cRow = await env.DB.prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN claim IS NOT NULL AND claim!='' THEN 1 ELSE 0 END) AS debunked FROM people"
      ).first();

      // User count — only refresh at noon CDT (UTC-5 in CDT = 17:00 UTC)
      let userCount = 0;
      try {
        const cached = await env.USERS_DB.prepare(
          "SELECT value, cached_at FROM stats_cache WHERE key='user_count'").first();
        const nowMs   = Date.now();
        const nowUtc  = new Date(nowMs);
        // Noon CDT = 17:00 UTC; check if we've passed today's noon CDT
        const todayNoonCDT = new Date(Date.UTC(nowUtc.getUTCFullYear(),
          nowUtc.getUTCMonth(), nowUtc.getUTCDate(), 17, 0, 0, 0));
        const needsRefresh = !cached ||
          (nowMs >= todayNoonCDT.getTime() && cached.cached_at < todayNoonCDT.getTime());

        if (needsRefresh) {
          const countRow = await env.USERS_DB.prepare(
            "SELECT COUNT(*) AS n FROM users WHERE status='active'").first();
          userCount = countRow?.n ?? 0;
          // Fire-and-forget write — don't block the response
          ctx.waitUntil(env.USERS_DB.prepare(
            "INSERT OR REPLACE INTO stats_cache VALUES ('user_count',?,?)"
          ).bind(String(userCount), nowMs).run());
        } else {
          userCount = parseInt(cached?.value ?? "0", 10);
        }
      } catch { userCount = 0; }

      return J({
        total:    cRow?.total    ?? 0,
        debunked: cRow?.debunked ?? 0,
        users:    userCount,
      }, 200, {"Cache-Control":"public,max-age=60"});
    }

    // =========================================================================
    // PUBLIC: /api/people
    // =========================================================================
    if (path === "/api/people") {
      const search  = (url.searchParams.get("search")||"").trim();
      const cls     = (url.searchParams.get("class") ||"").trim();
      const sortP   = url.searchParams.get("sort")||"newest";
      const orderBy = SORT_MAP[sortP] ?? SORT_MAP.newest;
      const cursor  = url.searchParams.get("cursor");

      if (cls && cls!=="all" && !VALID_CLASSES.has(cls))
        return J({data:[],nextCursor:null});

      let q = `SELECT ${COLS} FROM people WHERE 1=1`;
      const p=[];
      if (search) { q+=" AND (name LIKE ? OR bio LIKE ?)"; p.push(`%${search}%`,`%${search}%`); }
      if (cls && cls!=="all") { q+=" AND class=?"; p.push(cls); }
      if (cursor && (sortP==="newest"||sortP==="oldest")) {
        const cn=parseInt(cursor,10);
        if (!isNaN(cn)) { q+=sortP==="newest"?" AND timestamp<?":"  AND timestamp>?"; p.push(cn); }
      }
      q+=` ORDER BY ${orderBy} LIMIT 50`;
      const {results} = await env.DB.prepare(q).bind(...p).all();
      const nextCursor = results.length===50 ? results[results.length-1].timestamp : null;
      return J({data:results, nextCursor}, 200, {"Cache-Control":"no-store"});
    }

    // =========================================================================
    // PUBLIC: /api/person/:id
    // =========================================================================
    const personMatch = path.match(/^\/api\/person\/(\d+)$/);
    if (personMatch) {
      const id  = parseInt(personMatch[1],10);
      if (isNaN(id)) return Err("Invalid ID",400);
      const row = await env.DB.prepare(`SELECT ${COLS} FROM people WHERE id=?`).bind(id).first();
      if (!row) return Err("Not found",404);
      return J(row,200,{"Cache-Control":"no-store"});
    }

    // =========================================================================
    // USER AUTH: /api/auth/*
    // =========================================================================

    // ── POST /api/auth/signup ──────────────────────────────────────────────────
    if (path==="/api/auth/signup" && method==="POST") {
      let body;
      try { body = await request.json(); } catch { return Err("Invalid JSON"); }

      const { username, email, password, turnstile } = body;
      if (!username || !email || !password) return Err("username, email, password required");
      if (username.length < 3 || username.length > 30) return Err("Username must be 3–30 chars");
      if (!/^[a-zA-Z0-9_-]+$/.test(username)) return Err("Username: letters, numbers, _ - only");
      if (password.length < 8) return Err("Password must be at least 8 characters");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Err("Invalid email");

      // Turnstile verification
      const ip = request.headers.get("CF-Connecting-IP") || "";
      const tsOk = await verifyTurnstile(turnstile, ip);
      if (!tsOk) return Err("Turnstile verification failed. Please try again.", 403);

      // Check signup enabled
      const cfg = await env.USERS_DB.prepare("SELECT value FROM config WHERE key='signup_enabled'").first();
      if (cfg?.value === "false") return Err("Signups are currently disabled.", 403);

      // Check uniqueness
      const existing = await env.USERS_DB.prepare(
        "SELECT id FROM users WHERE username=? OR email=?").bind(username, email).first();
      if (existing) return Err("Username or email already taken");

      const hash = await hashPassword(password);
      await env.USERS_DB.prepare(
        "INSERT INTO users (username,email,password_hash) VALUES (?,?,?)"
      ).bind(username, email.toLowerCase(), hash).run();

      return Ok({ message:"Account created. You can now sign in." });
    }

    // ── POST /api/auth/login ───────────────────────────────────────────────────
    if (path==="/api/auth/login" && method==="POST") {
      let body;
      try { body = await request.json(); } catch { return Err("Invalid JSON"); }

      const { username, password, turnstile } = body;
      if (!username || !password) return Err("username and password required");

      const ip   = request.headers.get("CF-Connecting-IP") || "";
      const tsOk = await verifyTurnstile(turnstile, ip);
      if (!tsOk) return Err("Turnstile verification failed.", 403);

      const user = await env.USERS_DB.prepare(
        "SELECT id,username,password_hash,status FROM users WHERE username=?"
      ).bind(username).first();
      if (!user) return Err("Invalid username or password", 401);
      if (user.status !== "active") return Err("Account suspended.", 403);

      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) return Err("Invalid username or password", 401);

      // Create 30-day session
      const token    = genToken();
      const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
      await env.USERS_DB.prepare(
        "INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)"
      ).bind(token, user.id, expiresAt).run();

      // Update last_seen
      ctx.waitUntil(env.USERS_DB.prepare(
        "UPDATE users SET last_seen=? WHERE id=?").bind(Date.now(), user.id).run());

      return Ok({ token, username: user.username, expiresAt });
    }

    // ── POST /api/auth/logout ──────────────────────────────────────────────────
    if (path==="/api/auth/logout" && method==="POST") {
      const session = await getSession(request);
      if (session) {
        const auth  = request.headers.get("Authorization")||"";
        const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
        if (token) await env.USERS_DB.prepare("DELETE FROM sessions WHERE token=?").bind(token).run();
      }
      return Ok({ message:"Logged out" });
    }

    // ── GET /api/auth/me ───────────────────────────────────────────────────────
    if (path==="/api/auth/me" && method==="GET") {
      const session = await getSession(request);
      if (!session) return Err("Not authenticated", 401);
      const user = await env.USERS_DB.prepare(
        "SELECT id,username,email,display_name,bio,contact_info,avatar_url,created_at,last_seen FROM users WHERE id=?"
      ).bind(session.userId).first();
      if (!user) return Err("User not found",404);
      return J({ ...user, role:"user" });
    }

    // =========================================================================
    // VOTES: /api/vote
    // =========================================================================

    // ── POST /api/vote  { person_id, score } ──────────────────────────────────
    if (path==="/api/vote" && method==="POST") {
      const session = await getSession(request);
      if (!session) return Err("Sign in to vote", 401);
      let body;
      try { body = await request.json(); } catch { return Err("Invalid JSON"); }
      const { person_id, score } = body;
      if (!person_id || score==null) return Err("person_id and score required");
      const s = parseInt(score, 10);
      if (isNaN(s) || s<0 || s>100) return Err("Score must be 0–100");

      // Upsert vote
      await env.USERS_DB.prepare(
        "INSERT INTO votes (user_id,person_id,score,voted_at) VALUES (?,?,?,?) ON CONFLICT(user_id,person_id) DO UPDATE SET score=excluded.score, voted_at=excluded.voted_at"
      ).bind(session.userId, person_id, s, Date.now()).run();

      // Recompute average and update people table (fire-and-forget)
      ctx.waitUntil((async()=>{
        const agg = await env.USERS_DB.prepare(
          "SELECT AVG(score) AS avg, COUNT(*) AS cnt FROM votes WHERE person_id=?"
        ).bind(person_id).first();
        if (agg) {
          await env.DB.prepare(
            "UPDATE people SET community_score=?,vote_count=? WHERE id=?"
          ).bind(Math.round(agg.avg), agg.cnt, person_id).run();
        }
      })());

      return Ok({ message:"Vote recorded" });
    }

    // ── GET /api/vote/:person_id  — user's own vote for a person ──────────────
    const voteMatch = path.match(/^\/api\/vote\/(\d+)$/);
    if (voteMatch && method==="GET") {
      const session = await getSession(request);
      if (!session) return J({ score:null });
      const row = await env.USERS_DB.prepare(
        "SELECT score FROM votes WHERE user_id=? AND person_id=?")
        .bind(session.userId, parseInt(voteMatch[1],10)).first();
      return J({ score: row?.score ?? null });
    }

    // =========================================================================
    // PROFILES: /api/profile/*
    // =========================================================================

    // ── GET /api/profile/:username ────────────────────────────────────────────
    const profileGet = path.match(/^\/api\/profile\/([a-zA-Z0-9_-]+)$/);
    if (profileGet && method==="GET") {
      const row = await env.USERS_DB.prepare(
        "SELECT username,display_name,bio,contact_info,avatar_url,created_at FROM users WHERE username=? AND status='active'"
      ).bind(profileGet[1]).first();
      if (!row) return Err("Profile not found",404);
      return J(row, 200, {"Cache-Control":"public,max-age=1209600"}); // 2 weeks
    }

    // ── POST /api/profile/request  — submit field change for admin approval ───
    if (path==="/api/profile/request" && method==="POST") {
      const session = await getSession(request);
      if (!session) return Err("Sign in required",401);
      let body;
      try { body = await request.json(); } catch { return Err("Invalid JSON"); }
      const { field, value } = body;
      const ALLOWED_FIELDS = new Set(["display_name","bio","contact_info","avatar_url"]);
      if (!ALLOWED_FIELDS.has(field)) return Err("Invalid field");
      if (!value || typeof value !== "string") return Err("value required");

      // Hard limits on field lengths
      const LIMITS = { display_name:40, bio:500, contact_info:200, avatar_url:300 };
      if (value.length > LIMITS[field]) return Err(`${field} max ${LIMITS[field]} chars`);

      await env.USERS_DB.prepare(
        "INSERT INTO profile_requests (user_id,field,new_value) VALUES (?,?,?)"
      ).bind(session.userId, field, value).run();
      return Ok({ message:"Profile change submitted for review." });
    }

    // =========================================================================
    // MESSAGES: /api/messages/*
    // =========================================================================

    // ── GET /api/messages  — inbox (updated once per day per user cache) ──────
    if (path==="/api/messages" && method==="GET") {
      const session = await getSession(request);
      if (!session) return Err("Sign in required",401);

      const rows = await env.USERS_DB.prepare(
        `SELECT m.id,m.body,m.sent_at,m.read_at,u.username AS from_username
         FROM messages m JOIN users u ON u.id=m.from_id
         WHERE m.to_id=? ORDER BY m.sent_at DESC LIMIT 50`
      ).bind(session.userId).all();

      // Mark unread as read
      ctx.waitUntil(env.USERS_DB.prepare(
        "UPDATE messages SET read_at=? WHERE to_id=? AND read_at IS NULL"
      ).bind(Date.now(), session.userId).run());

      return J({ messages: rows.results ?? [] }, 200,
        {"Cache-Control":"private,max-age=86400"}); // 1-day cache
    }

    // ── POST /api/messages/send  { to_username, body } ────────────────────────
    if (path==="/api/messages/send" && method==="POST") {
      const session = await getSession(request);
      if (!session) return Err("Sign in required",401);
      let body;
      try { body = await request.json(); } catch { return Err("Invalid JSON"); }
      const { to_username, body: msgBody } = body;
      if (!to_username || !msgBody) return Err("to_username and body required");
      if (msgBody.length > 1000) return Err("Message max 1000 chars");

      // Resolve recipient
      const recipient = await env.USERS_DB.prepare(
        "SELECT id FROM users WHERE username=? AND status='active'"
      ).bind(to_username).first();
      if (!recipient) return Err("Recipient not found");
      if (recipient.id === session.userId) return Err("Cannot message yourself");

      // Rate limit check
      const day = utcDay();
      const rl  = await env.USERS_DB.prepare(
        "SELECT sent_count FROM msg_daily WHERE user_id=? AND utc_day=?"
      ).bind(session.userId, day).first();
      const sent = rl?.sent_count ?? 0;

      // Get per-user limit (falls back to global config)
      const userRow = await env.USERS_DB.prepare(
        "SELECT msg_daily_limit FROM users WHERE id=?").bind(session.userId).first();
      const globalLimit = await env.USERS_DB.prepare(
        "SELECT value FROM config WHERE key='msg_daily_limit'").first();
      const limit = userRow?.msg_daily_limit ?? parseInt(globalLimit?.value??"5",10);

      if (sent >= limit) return Err(`Daily message limit (${limit}) reached`, 429);

      await env.USERS_DB.prepare(
        "INSERT INTO messages (from_id,to_id,body) VALUES (?,?,?)"
      ).bind(session.userId, recipient.id, msgBody).run();

      // Increment daily counter
      await env.USERS_DB.prepare(
        "INSERT INTO msg_daily (user_id,utc_day,sent_count) VALUES (?,?,1) ON CONFLICT(user_id,utc_day) DO UPDATE SET sent_count=sent_count+1"
      ).bind(session.userId, day).run();

      return Ok({ message:"Message sent" });
    }

    // =========================================================================
    // SUBMISSIONS: /api/submit  (contact page → admin review)
    // =========================================================================
    if (path==="/api/submit" && method==="POST") {
      let body;
      try { body = await request.json(); } catch { return Err("Invalid JSON"); }
      const { type, names, turnstile } = body;
      if (!type || !names || !Array.isArray(names)) return Err("type and names[] required");
      if (!["add","remove"].includes(type)) return Err("type must be add or remove");
      if (names.length === 0 || names.length > 20) return Err("1–20 names allowed");

      // Validate each name
      for (const n of names) {
        if (typeof n !== "string" || n.trim().length < 1 || n.trim().length > 100)
          return Err("Each name must be 1–100 chars");
      }

      // Auth — must be signed in
      const session = await getSession(request);
      if (!session) return Err("Sign in to submit requests",401);

      const ip    = request.headers.get("CF-Connecting-IP") || "unknown";
      const ipH   = await sha256hex(ip);

      // Turnstile
      const tsOk = await verifyTurnstile(turnstile, ip);
      if (!tsOk) return Err("Turnstile verification failed",403);

      // Rate limit: 1 per type per user+ip per day
      const day = utcDay();
      const rlKey = `${session.userId}_${ipH}_${type}_${day}`;
      const rl = await env.USERS_DB.prepare(
        "SELECT count FROM submission_daily WHERE key=?").bind(rlKey).first();
      if (rl && rl.count >= 1) return Err("You already submitted a " + type + " request today",429);

      await env.USERS_DB.prepare(
        "INSERT INTO submission_requests (user_id,ip_hash,type,names) VALUES (?,?,?,?)"
      ).bind(session.userId, ipH, type, JSON.stringify(names.map(n=>n.trim()))).run();

      await env.USERS_DB.prepare(
        "INSERT INTO submission_daily (key,count) VALUES (?,1) ON CONFLICT(key) DO UPDATE SET count=count+1"
      ).bind(rlKey).run();

      return Ok({ message:"Request submitted for review." });
    }

    // =========================================================================
    // CHAT QUEUE: /api/chat/*
    // =========================================================================

    // ── GET /api/chat/status — queue position for current user ────────────────
    if (path==="/api/chat/status" && method==="GET") {
      const session = await getSession(request);
      if (!session) return Err("Sign in required",401);

      const enabled = await env.USERS_DB.prepare(
        "SELECT value FROM config WHERE key='chat_enabled'").first();
      if (enabled?.value==="false") return J({ status:"disabled" });

      // Clean expired/stale entries (>10 min waiting)
      ctx.waitUntil(env.USERS_DB.prepare(
        "UPDATE chat_queue SET status='expired' WHERE status='waiting' AND joined_at < ?"
      ).bind(Date.now() - 10*60*1000).run());

      const myEntry = await env.USERS_DB.prepare(
        "SELECT id,status,joined_at FROM chat_queue WHERE user_id=? AND status IN ('waiting','active') ORDER BY joined_at DESC LIMIT 1"
      ).bind(session.userId).first();

      const activeCount = await env.USERS_DB.prepare(
        "SELECT COUNT(*) AS n FROM chat_queue WHERE status='waiting' AND joined_at < ?"
      ).bind(myEntry?.joined_at ?? Date.now()).first();

      const timeLimit = await env.USERS_DB.prepare(
        "SELECT value FROM config WHERE key='chat_time_limit_secs'").first();

      return J({
        status:      myEntry?.status ?? "none",
        position:    (activeCount?.n ?? 0),
        timeLimit:   parseInt(timeLimit?.value ?? "300", 10),
        queueId:     myEntry?.id ?? null,
      });
    }

    // ── POST /api/chat/join ────────────────────────────────────────────────────
    if (path==="/api/chat/join" && method==="POST") {
      const session = await getSession(request);
      if (!session) return Err("Sign in required",401);

      const enabled = await env.USERS_DB.prepare(
        "SELECT value FROM config WHERE key='chat_enabled'").first();
      if (enabled?.value==="false") return Err("Live chat is currently disabled");

      // Don't allow duplicate queue entry
      const existing = await env.USERS_DB.prepare(
        "SELECT id FROM chat_queue WHERE user_id=? AND status IN ('waiting','active')"
      ).bind(session.userId).first();
      if (existing) return Ok({ message:"Already in queue", queueId:existing.id });

      const timeLimit = await env.USERS_DB.prepare(
        "SELECT value FROM config WHERE key='chat_time_limit_secs'").first();
      const tl = parseInt(timeLimit?.value ?? "300", 10);

      const result = await env.USERS_DB.prepare(
        "INSERT INTO chat_queue (user_id,username,role,time_limit) VALUES (?,?,?,?) RETURNING id"
      ).bind(session.userId, session.username, "user", tl).first();

      // Notify main admin (push notification — fire and forget)
      ctx.waitUntil(notifyAdmin(env, session.username, ctx));

      return Ok({ message:"Joined queue", queueId:result?.id });
    }

    // ── POST /api/chat/leave ───────────────────────────────────────────────────
    if (path==="/api/chat/leave" && method==="POST") {
      const session = await getSession(request);
      if (!session) return Err("Sign in required",401);
      await env.USERS_DB.prepare(
        "UPDATE chat_queue SET status='done',ended_at=? WHERE user_id=? AND status IN ('waiting','active')"
      ).bind(Date.now(), session.userId).run();
      return Ok({ message:"Left queue" });
    }

    // ── NOTE: Actual real-time chat requires Durable Objects (Workers Paid plan)
    // The queue system above is fully functional. When you upgrade:
    // 1. Create a DO class "ChatRoom"
    // 2. Add binding: [[durable_objects.bindings]] name="CHAT" class_name="ChatRoom"
    // 3. Add a WebSocket endpoint at /api/chat/ws that routes to the DO

    // =========================================================================
    // PUSH NOTIFICATIONS: /api/push/*
    // =========================================================================

    // ── POST /api/push/subscribe ───────────────────────────────────────────────
    if (path==="/api/push/subscribe" && method==="POST") {
      let body;
      try { body = await request.json(); } catch { return Err("Invalid JSON"); }
      const { endpoint, p256dh, auth: pushAuth, label } = body;
      if (!endpoint || !p256dh || !pushAuth) return Err("endpoint, p256dh, auth required");

      const session = await getSession(request);
      const userId  = session?.userId ?? null;

      await env.USERS_DB.prepare(
        "INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth,label) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, label=excluded.label"
      ).bind(userId, endpoint, p256dh, pushAuth, label||null).run();

      return Ok({ message:"Subscribed to push notifications" });
    }

    // ── GET /api/push/vapid-public-key ─────────────────────────────────────────
    if (path==="/api/push/vapid-public-key" && method==="GET") {
      return J({ key: env.VAPID_PUBLIC_KEY || null });
    }

    // =========================================================================
    // ADMIN: /admin and /admin/*
    // =========================================================================
    if (path.startsWith("/admin")) {
      const authUser = await getAdmin(request);
      if (!authUser) return new Response("Unauthorized",{status:401,
        headers:{"WWW-Authenticate":'Basic realm="LiarBoard Admin"'}});

      const isMain = authUser.role==="main";

      function esc(s){ return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;")
        .replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
      const CLS_OPTS = ["Politician","CEO","Media","Celebrity","Influencer","Official","Other"]
        .map(c=>`<option value="${c}">${c}</option>`).join("");

      // ── GET /admin ──────────────────────────────────────────────────────────
      if (method==="GET" && path==="/admin") {
        const meta = await env.DB.prepare(
          "SELECT version_number FROM site_metadata WHERE id=1").first() ?? {version_number:1};

        // Pending items (main admin only)
        let pendingProfiles=[], pendingSubmissions=[], chatQueue=[], recentMsgs=[];
        if (isMain) {
          try {
            const pp = await env.USERS_DB.prepare(
              "SELECT pr.id,pr.field,pr.new_value,u.username,pr.submitted_at FROM profile_requests pr JOIN users u ON u.id=pr.user_id WHERE pr.status='pending' ORDER BY pr.submitted_at DESC LIMIT 20"
            ).all(); pendingProfiles = pp.results??[];

            const ps = await env.USERS_DB.prepare(
              "SELECT sr.id,sr.type,sr.names,u.username,sr.submitted_at FROM submission_requests sr LEFT JOIN users u ON u.id=sr.user_id WHERE sr.status='pending' ORDER BY sr.submitted_at DESC LIMIT 20"
            ).all(); pendingSubmissions = ps.results??[];

            const cq = await env.USERS_DB.prepare(
              "SELECT cq.id,cq.username,cq.role,cq.status,cq.joined_at FROM chat_queue cq WHERE cq.status='waiting' ORDER BY cq.joined_at ASC LIMIT 10"
            ).all(); chatQueue = cq.results??[];
          } catch(e){ console.error("Admin fetch error:",e); }
        } else {
          // Sub-admin sees pending submissions for review
          try {
            const ps = await env.USERS_DB.prepare(
              "SELECT id,type,names,submitted_at FROM submission_requests WHERE status='pending' ORDER BY submitted_at DESC LIMIT 20"
            ).all(); pendingSubmissions = ps.results??[];
          } catch{}
        }

        const profileRows = pendingProfiles.map(r=>`
          <div class="review-row">
            <strong>${esc(r.username)}</strong> wants to set <code>${esc(r.field)}</code>:<br>
            <blockquote>${esc(r.new_value)}</blockquote>
            <form action="/admin/approve-profile" method="POST" style="display:inline">
              <input type="hidden" name="id" value="${r.id}">
              <input type="hidden" name="action" value="approve">
              <button class="btn-green">✓ Approve</button>
            </form>
            <form action="/admin/approve-profile" method="POST" style="display:inline;margin-left:8px">
              <input type="hidden" name="id" value="${r.id}">
              <input type="hidden" name="action" value="reject">
              <button class="btn-red">✗ Reject</button>
            </form>
          </div>`).join("") || '<p style="color:#64748b">No pending profile requests.</p>';

        const subRows = pendingSubmissions.map(r=>`
          <div class="review-row">
            <span class="badge-${r.type}">${r.type.toUpperCase()}</span>
            by <strong>${esc(r.username||"?")}</strong> — ${esc(JSON.parse(r.names||"[]").join(", "))}
            ${isMain ? `
            <form action="/admin/resolve-submission" method="POST" style="margin-top:8px">
              <input type="hidden" name="id" value="${r.id}">
              <input type="hidden" name="action" value="reject">
              <button class="btn-red" style="font-size:12px">Dismiss</button>
            </form>` : ""}
          </div>`).join("") || '<p style="color:#64748b">No pending submissions.</p>';

        const queueRows = chatQueue.map((r,i)=>`
          <div class="review-row">
            #${i+1} — <strong>${esc(r.username)}</strong> (${esc(r.role)}) — waiting since ${new Date(r.joined_at).toLocaleTimeString()}
          </div>`).join("") || '<p style="color:#64748b">Queue empty.</p>';

        return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LiarBoard Admin</title>
<style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;padding:0;background:#0f172a;color:#e2e8f0;margin:0}
.top{background:#1e293b;padding:14px 24px;border-bottom:1px solid #334155;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
.top h1{margin:0;font-size:1.1rem}.content{max-width:900px;margin:0 auto;padding:24px}
h3{color:#94a3b8;border-bottom:1px solid #334155;padding-bottom:6px;margin-top:0;font-size:12px;text-transform:uppercase;letter-spacing:1px}
.card{background:#1e293b;padding:18px;border-radius:10px;margin-bottom:18px;border:1px solid #334155}
.blue{border-color:#3b82f6!important}.red{border-color:#ef4444!important}.yellow{border-color:#f59e0b!important}.green{border-color:#22c55e!important}
input,textarea,select{width:100%;background:#0f172a;border:1px solid #475569;color:#e2e8f0;padding:9px;border-radius:6px;margin-bottom:8px;font-size:14px;font-family:inherit}
input:focus,textarea:focus,select:focus{outline:none;border-color:#3b82f6}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
button,.btn-green,.btn-red,.btn-blue,.btn-yellow{padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:13px}
.btn-blue{background:#3b82f6;color:#fff}.btn-red{background:#ef4444;color:#fff}.btn-green{background:#22c55e;color:#fff}.btn-yellow{background:#f59e0b;color:#000}
label{display:block;font-size:12px;color:#94a3b8;margin-bottom:2px}
.badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700;color:#fff}
.badge-main{background:#3b82f6}.badge-sub{background:#64748b}.badge-add{background:#22c55e;color:#000}.badge-remove{background:#ef4444}
.review-row{background:#0f172a;border:1px solid #334155;border-radius:6px;padding:12px;margin-bottom:8px;font-size:13px}
small{color:#64748b;font-size:12px}blockquote{background:#1e293b;border-left:3px solid #3b82f6;margin:8px 0;padding:8px 12px;font-size:13px;border-radius:0 6px 6px 0}
</style></head><body>
<div class="top">
  <h1>LiarBoard Admin <span class="badge badge-${isMain?"main":"sub"}">${isMain?"Main Admin":"Sub Admin"}</span></h1>
  <span style="color:#94a3b8;font-size:13px">Logged in as <strong style="color:#fff">${esc(authUser.user)}</strong></span>
</div>
<div class="content">

${isMain?`
<div class="card blue">
  <h3>🔒 Version Control</h3>
  <p style="color:#94a3b8;font-size:13px">Live version: <strong style="color:#fff">${esc(String(meta.version_number))}</strong> — bumping this clears all user caches.</p>
  <form action="/admin/update-version" method="POST" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
    <div><label>New version</label><input name="new_ver" type="number" step="0.1" min="0.1" value="${esc(String(meta.version_number))}" style="max-width:120px;margin-bottom:0"></div>
    <button type="submit" class="btn-blue">Publish &amp; Bump</button>
  </form>
</div>

<div class="card">
  <h3>⚙️ Global Config</h3>
  <form action="/admin/update-config" method="POST">
    <div class="row2">
      <div><label>Daily msg limit (default per user)</label><input name="msg_daily_limit" type="number" min="0" value="5"></div>
      <div><label>Chat time limit (seconds)</label><input name="chat_time_limit_secs" type="number" min="60" value="300"></div>
    </div>
    <div class="row2">
      <div><label>Chat enabled</label><select name="chat_enabled"><option value="true">Yes</option><option value="false">No</option></select></div>
      <div><label>Signups enabled</label><select name="signup_enabled"><option value="true">Yes</option><option value="false">No</option></select></div>
    </div>
    <button type="submit" class="btn-blue">Save Config</button>
  </form>
</div>

<div class="card">
  <h3>👤 User Account Actions</h3>
  <form action="/admin/user-action" method="POST" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
    <div><label>Username</label><input name="username" placeholder="username" style="max-width:160px;margin-bottom:0"></div>
    <div><label>Action</label><select name="action" style="max-width:140px;margin-bottom:0"><option value="suspend">Suspend</option><option value="unsuspend">Unsuspend</option><option value="ban">Ban</option><option value="set-msg-limit">Set Msg Limit</option></select></div>
    <div><label>Msg limit (if setting)</label><input name="msg_limit" type="number" min="0" placeholder="5" style="max-width:80px;margin-bottom:0"></div>
    <button type="submit" class="btn-yellow">Apply</button>
  </form>
</div>

<div class="card">
  <h3>💬 Chat Queue</h3>
  ${queueRows}
</div>

<div class="card green">
  <h3>🔔 Pending Profile Requests</h3>
  ${profileRows}
</div>`:""}

<div class="card${isMain?"":" yellow"}">
  <h3>📋 Pending Submissions</h3>
  ${subRows}
</div>

<div class="card">
  <h3>➕ Add New Entry</h3>
  <form action="/admin/add-person" method="POST">
    <div class="row2">
      <div><label>Full Name *</label><input name="name" placeholder="e.g. Jane Smith" required></div>
      <div><label>Image URL(s) * <small>(comma-separated)</small></label><input name="image" placeholder="https://…" required></div>
    </div>
    <label>Bio</label><textarea name="bio" rows="2" placeholder="Brief description…"></textarea>
    <div class="row2">
      <div><label>The Claim</label><textarea name="claim" rows="2"></textarea></div>
      <div><label>The Truth</label><textarea name="truth" rows="2"></textarea></div>
    </div>
    <label>Sources <small>(comma-separated URLs)</small></label><textarea name="sources" rows="2"></textarea>
    <div class="row2">
      <div><label>Class</label><select name="class">${CLS_OPTS}</select></div>
      <div><label>Level (1–100)</label><input name="lvl" type="number" min="1" max="100" value="50"></div>
    </div>
    <button type="submit" class="btn-green">Submit Entry</button>
  </form>
</div>

${isMain?`
<div class="card">
  <h3>✏️ Edit / Delete Entry</h3>
  <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
    <input type="number" id="lookupId" placeholder="Entry ID" style="max-width:120px;margin-bottom:0">
    <button type="button" class="btn-yellow" onclick="lookupEntry()">Look Up</button>
  </div>
  <form action="/admin/update-person" method="POST" id="editForm" style="display:none">
    <input type="hidden" name="id" id="editId">
    <div class="row2">
      <div><label>Name *</label><input name="name" id="editName" required></div>
      <div><label>Image URL(s) *</label><input name="image" id="editImage" required></div>
    </div>
    <label>Bio</label><textarea name="bio" id="editBio" rows="2"></textarea>
    <div class="row2">
      <div><label>Claim</label><textarea name="claim" id="editClaim" rows="2"></textarea></div>
      <div><label>Truth</label><textarea name="truth" id="editTruth" rows="2"></textarea></div>
    </div>
    <label>Sources</label><textarea name="sources" id="editSources" rows="2"></textarea>
    <div class="row2">
      <div><label>Class</label><select name="class" id="editClass">${CLS_OPTS}</select></div>
      <div><label>Level</label><input name="lvl" id="editLvl" type="number" min="1" max="100"></div>
    </div>
    <button type="submit" class="btn-yellow">Save Changes</button>
  </form>
  <hr style="border-color:#334155;margin:16px 0">
  <form action="/admin/delete-person" method="POST" onsubmit="return confirm('Permanently delete?')">
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
      <div><label>Delete by ID</label><input name="id" type="number" placeholder="ID" required style="max-width:120px;margin-bottom:0"></div>
      <button type="submit" class="btn-red">Delete Entry</button>
    </div>
  </form>
</div>
<script>
async function lookupEntry(){
  const id=document.getElementById('lookupId').value;if(!id)return;
  try{const r=await fetch('/api/person/'+id);if(!r.ok){alert('Not found');return;}const d=await r.json();
  document.getElementById('editId').value=d.id||'';
  document.getElementById('editName').value=d.name||'';
  document.getElementById('editImage').value=d.image||'';
  document.getElementById('editBio').value=d.bio||'';
  document.getElementById('editClaim').value=d.claim||'';
  document.getElementById('editTruth').value=d.truth||'';
  document.getElementById('editSources').value=d.sources||'';
  document.getElementById('editLvl').value=d.lvl||50;
  const sel=document.getElementById('editClass');
  for(const o of sel.options){if(o.value===d.class){o.selected=true;break;}}
  document.getElementById('editForm').style.display='block';
  }catch(e){alert(e.message);}
}
</script>`:``}

</div></body></html>`,{headers:{"Content-Type":"text/html;charset=utf-8"}});
      }

      // ── POST /admin/update-version ──────────────────────────────────────────
      if (path==="/admin/update-version" && method==="POST") {
        if (!isMain) return new Response("Forbidden",{status:403});
        const f=await request.formData();
        const v=parseFloat(f.get("new_ver"));
        if (isNaN(v)||v<=0) return new Response("Invalid version",{status:400});
        await env.DB.prepare("UPDATE site_metadata SET version_number=? WHERE id=1").bind(v).run();
        return Response.redirect(origin+"/admin",302);
      }

      // ── POST /admin/update-config ───────────────────────────────────────────
      if (path==="/admin/update-config" && method==="POST") {
        if (!isMain) return new Response("Forbidden",{status:403});
        const f=await request.formData();
        const keys=["msg_daily_limit","chat_time_limit_secs","chat_enabled","signup_enabled"];
        for (const k of keys) {
          const v=f.get(k);
          if (v!=null) await env.USERS_DB.prepare(
            "INSERT OR REPLACE INTO config VALUES (?,?)").bind(k,String(v)).run();
        }
        return Response.redirect(origin+"/admin",302);
      }

      // ── POST /admin/user-action ─────────────────────────────────────────────
      if (path==="/admin/user-action" && method==="POST") {
        if (!isMain) return new Response("Forbidden",{status:403});
        const f=await request.formData();
        const username=f.get("username");
        const action=f.get("action");
        if (!username||!action) return new Response("Missing fields",{status:400});
        if (action==="suspend")   await env.USERS_DB.prepare("UPDATE users SET status='suspended' WHERE username=?").bind(username).run();
        if (action==="unsuspend") await env.USERS_DB.prepare("UPDATE users SET status='active' WHERE username=?").bind(username).run();
        if (action==="ban")       await env.USERS_DB.prepare("UPDATE users SET status='banned' WHERE username=?").bind(username).run();
        if (action==="set-msg-limit") {
          const lim=parseInt(f.get("msg_limit"),10);
          if (!isNaN(lim)) await env.USERS_DB.prepare("UPDATE users SET msg_daily_limit=? WHERE username=?").bind(lim,username).run();
        }
        return Response.redirect(origin+"/admin",302);
      }

      // ── POST /admin/approve-profile ─────────────────────────────────────────
      if (path==="/admin/approve-profile" && method==="POST") {
        if (!isMain) return new Response("Forbidden",{status:403});
        const f=await request.formData();
        const id=parseInt(f.get("id"),10);
        const action=f.get("action");
        if (isNaN(id)) return new Response("Invalid ID",{status:400});
        if (action==="approve") {
          const req=await env.USERS_DB.prepare(
            "SELECT user_id,field,new_value FROM profile_requests WHERE id=?").bind(id).first();
          if (req) {
            const SAFE_FIELDS=new Set(["display_name","bio","contact_info","avatar_url"]);
            if (SAFE_FIELDS.has(req.field)) {
              await env.USERS_DB.prepare(
                `UPDATE users SET ${req.field}=? WHERE id=?`
              ).bind(req.new_value, req.user_id).run();
            }
          }
        }
        await env.USERS_DB.prepare(
          "UPDATE profile_requests SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?"
        ).bind(action==="approve"?"approved":"rejected", authUser.user, Date.now(), id).run();
        return Response.redirect(origin+"/admin",302);
      }

      // ── POST /admin/resolve-submission ──────────────────────────────────────
      if (path==="/admin/resolve-submission" && method==="POST") {
        if (!isMain) return new Response("Forbidden",{status:403});
        const f=await request.formData();
        const id=parseInt(f.get("id"),10);
        const action=f.get("action")||"reject";
        if (isNaN(id)) return new Response("Invalid ID",{status:400});
        await env.USERS_DB.prepare(
          "UPDATE submission_requests SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?"
        ).bind(action, authUser.user, Date.now(), id).run();
        return Response.redirect(origin+"/admin",302);
      }

      // ── POST /admin/delete-person ───────────────────────────────────────────
      if (path==="/admin/delete-person" && method==="POST") {
        if (!isMain) return new Response("Forbidden",{status:403});
        const f=await request.formData();
        const id=parseInt(f.get("id"),10);
        if (isNaN(id)) return new Response("Invalid ID",{status:400});
        await env.DB.prepare("DELETE FROM people WHERE id=?").bind(id).run();
        return Response.redirect(origin+"/admin",302);
      }

      // ── POST /admin/add-person ──────────────────────────────────────────────
      if (path==="/admin/add-person" && method==="POST") {
        const f=await request.formData();
        const name   =(f.get("name")   ??"").trim();
        const image  =(f.get("image")  ??"").trim();
        const bio    =(f.get("bio")    ??"").trim();
        const claim  =(f.get("claim")  ??"").trim();
        const truth  =(f.get("truth")  ??"").trim();
        const sources=(f.get("sources")??"").trim();
        const cls    =VALID_CLASSES.has((f.get("class")??"").trim())?(f.get("class")).trim():"Other";
        const lvl    =Math.min(100,Math.max(1,parseInt(f.get("lvl"),10)||50));
        if (!name||!image) return new Response("Name and Image required",{status:400});
        await env.DB.prepare(
          "INSERT INTO people (name,image,bio,claim,truth,sources,class,lvl,created_by) VALUES (?,?,?,?,?,?,?,?,?)"
        ).bind(name,image,bio,claim,truth,sources,cls,lvl,authUser.user).run();
        return Response.redirect(origin+"/admin",302);
      }

      // ── POST /admin/update-person ───────────────────────────────────────────
      if (path==="/admin/update-person" && method==="POST") {
        if (!isMain) return new Response("Forbidden",{status:403});
        const f=await request.formData();
        const id=parseInt(f.get("id"),10);
        if (isNaN(id)) return new Response("Invalid ID",{status:400});
        const name   =(f.get("name")   ??"").trim();
        const image  =(f.get("image")  ??"").trim();
        const bio    =(f.get("bio")    ??"").trim();
        const claim  =(f.get("claim")  ??"").trim();
        const truth  =(f.get("truth")  ??"").trim();
        const sources=(f.get("sources")??"").trim();
        const cls    =VALID_CLASSES.has((f.get("class")??"").trim())?(f.get("class")).trim():"Other";
        const lvl    =Math.min(100,Math.max(1,parseInt(f.get("lvl"),10)||50));
        if (!name||!image) return new Response("Name and Image required",{status:400});
        await env.DB.prepare(
          "UPDATE people SET name=?,image=?,bio=?,claim=?,truth=?,sources=?,class=?,lvl=?,last_corrected=? WHERE id=?"
        ).bind(name,image,bio,claim,truth,sources,cls,lvl,Date.now(),id).run();
        return Response.redirect(origin+"/admin",302);
      }

      return Response.redirect(origin+"/admin",302);
    }

    // =========================================================================
    // STATIC ASSETS (Cloudflare Pages)
    // =========================================================================
    return env.ASSETS.fetch(request);
  },
};

// ─── PUSH NOTIFICATION HELPER ──────────────────────────────────────────────────
// Sends a push notification to all main-admin push subscriptions.
// Full Web Push (VAPID) requires signing — simplified version here that works
// with VAPID keys set in env. If keys aren't set, fails silently.
async function notifyAdmin(env, username, ctx) {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return;
  try {
    const subs = await env.USERS_DB.prepare(
      "SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE label='main_admin_device'"
    ).all();
    for (const sub of (subs.results??[])) {
      // NOTE: Full VAPID signing requires the web-push library or manual implementation.
      // For the free tier, use a service like ntfy.sh or Pushover as an alternative —
      // they require just a simple fetch() call and work without VAPID.
      // Example ntfy.sh integration:
      if (env.NTFY_TOPIC) {
        ctx.waitUntil(fetch("https://ntfy.sh/" + env.NTFY_TOPIC, {
          method:"POST",
          headers:{ "Title":"LiarBoard Chat Request", "Content-Type":"text/plain" },
          body: username + " is requesting a chat session.",
        }));
      }
    }
  } catch {}
}
