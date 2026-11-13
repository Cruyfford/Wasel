// Wasel — سيرفر المراسلة والمكالمات (Cloudflare Worker + Durable Object)
import APP_HTML from "./app.html";

const JSON_H = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: JSON_H });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS")
      return new Response(null, { headers: { ...JSON_H, "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST" } });
    if (url.pathname === "/" || url.pathname === "/index.html")
      return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    if (url.pathname === "/api/turn") return turn(env);
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws") {
      const hub = env.HUB.get(env.HUB.idFromName("main"));
      return hub.fetch(req);
    }
    return new Response("Not found", { status: 404 });
  },
};

async function turn(env) {
  const stun = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) return json({ iceServers: stun });
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.TURN_KEY_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: 86400 }),
    });
    const d = await r.json();
    const s = Array.isArray(d.iceServers) ? d.iceServers : d.iceServers ? [d.iceServers] : [];
    return json({ iceServers: s.length ? s : stun });
  } catch {
    return json({ iceServers: stun });
  }
}

// ---------- كلمات المرور ----------
const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hashPass(pass, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return hex(bits);
}
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

export class Hub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, name TEXT, about TEXT DEFAULT '', salt TEXT, hash TEXT, created INTEGER, last_seen INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, uid INTEGER, created INTEGER);
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, a INTEGER, b INTEGER, body TEXT, kind TEXT DEFAULT 'text', ts INTEGER, status INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS msg_pair ON messages(a, b, id);
      CREATE INDEX IF NOT EXISTS msg_to ON messages(b, status);
    `);
    // مفاتيح التشفير: المفتاح العام + نسخة مشفّرة من المفتاح الخاص (لا يستطيع السيرفر فتحها)
    for (const c of ["pub TEXT", "backup TEXT"]) { try { this.sql.exec(`ALTER TABLE users ADD COLUMN ${c}`); } catch {} }
  }

  one(q, ...a) { return this.sql.exec(q, ...a).toArray()[0] || null; }
  all(q, ...a) { return this.sql.exec(q, ...a).toArray(); }
  pub(u) { return u && { id: u.id, email: u.email, name: u.name, about: u.about, pub: u.pub || null, online: this.online(u.id), last_seen: u.last_seen }; }
  online(uid) { return this.ctx.getWebSockets(String(uid)).length > 0; }
  sendTo(uid, obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets(String(uid))) { try { ws.send(s); } catch {} }
  }
  auth(req, url) {
    const t = (req.headers.get("authorization") || "").replace(/^Bearer /, "") || url.searchParams.get("token");
    if (!t) return null;
    const s = this.one("SELECT uid FROM sessions WHERE token=?", t);
    return s ? this.one("SELECT * FROM users WHERE id=?", s.uid) : null;
  }
  newSession(uid) {
    const token = randHex(32);
    this.sql.exec("INSERT INTO sessions VALUES(?,?,?)", token, uid, Date.now());
    return token;
  }
  contactsOf(uid) {
    return this.all("SELECT DISTINCT CASE WHEN a=? THEN b ELSE a END AS id FROM messages WHERE a=? OR b=?", uid, uid, uid).map((r) => r.id);
  }
  presence(uid, online) {
    for (const c of this.contactsOf(uid)) this.sendTo(c, { t: "presence", id: uid, online, last_seen: Date.now() });
  }

  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/ws") {
        if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
        const me = this.auth(req, url);
        if (!me) return new Response("unauthorized", { status: 401 });
        const pair = new WebSocketPair();
        const wasOnline = this.online(me.id);
        this.ctx.acceptWebSocket(pair[1], [String(me.id)]);
        pair[1].serializeAttachment({ uid: me.id });
        // الرسائل غير المستلمة أصبحت "وصلت"
        const pending = this.all("SELECT DISTINCT a FROM messages WHERE b=? AND status=0", me.id);
        this.sql.exec("UPDATE messages SET status=1 WHERE b=? AND status=0", me.id);
        for (const r of pending) this.sendTo(r.a, { t: "status", with: me.id, status: 1 });
        if (!wasOnline) this.presence(me.id, true);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }

      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

      if (p === "/api/register") {
        const email = String(body.email || "").trim().toLowerCase();
        const name = String(body.name || "").trim().slice(0, 40);
        const pass = String(body.password || "");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "البريد الإلكتروني غير صحيح" }, 400);
        if (pass.length < 6) return json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" }, 400);
        if (!name) return json({ error: "اكتب اسمك" }, 400);
        if (this.one("SELECT id FROM users WHERE email=?", email)) return json({ error: "هذا البريد مسجّل مسبقاً" }, 409);
        const salt = randHex(16);
        const hash = await hashPass(pass, salt);
        const pubk = typeof body.pub === "string" ? body.pub.slice(0, 200) : null;
        const backup = typeof body.backup === "string" ? body.backup.slice(0, 2000) : null;
        this.sql.exec("INSERT INTO users(email,name,salt,hash,created,pub,backup) VALUES(?,?,?,?,?,?,?)", email, name, salt, hash, Date.now(), pubk, backup);
        const u = this.one("SELECT * FROM users WHERE email=?", email);
        return json({ token: this.newSession(u.id), user: this.pub(u) });
      }

      if (p === "/api/login") {
        const email = String(body.email || "").trim().toLowerCase();
        const u = this.one("SELECT * FROM users WHERE email=?", email);
        if (!u || (await hashPass(String(body.password || ""), u.salt)) !== u.hash)
          return json({ error: "البريد أو كلمة المرور غير صحيحة" }, 401);
        return json({ token: this.newSession(u.id), user: this.pub(u), backup: u.backup || null });
      }

      const me = this.auth(req, url);
      if (!me) return json({ error: "unauthorized" }, 401);

      if (p === "/api/me") {
        if (req.method === "POST") {
          const name = String(body.name ?? me.name).trim().slice(0, 40) || me.name;
          const about = String(body.about ?? me.about).slice(0, 140);
          this.sql.exec("UPDATE users SET name=?, about=? WHERE id=?", name, about, me.id);
        }
        return json({ user: this.pub(this.one("SELECT * FROM users WHERE id=?", me.id)) });
      }

      if (p === "/api/keys") {
        if (me.pub) return json({ error: "المفاتيح موجودة مسبقاً" }, 409);
        this.sql.exec("UPDATE users SET pub=?, backup=? WHERE id=?", String(body.pub || "").slice(0, 200), String(body.backup || "").slice(0, 2000), me.id);
        return json({ user: this.pub(this.one("SELECT * FROM users WHERE id=?", me.id)) });
      }

      if (p === "/api/upgrade") {
        const salt = randHex(16);
        this.sql.exec("UPDATE users SET salt=?, hash=? WHERE id=?", salt, await hashPass(String(body.password || ""), salt), me.id);
        return json({ ok: true });
      }

      if (p === "/api/logout") {
        const t = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
        this.sql.exec("DELETE FROM sessions WHERE token=?", t);
        return json({ ok: true });
      }

      if (p === "/api/find") {
        const q = String(url.searchParams.get("email") || "").trim().toLowerCase();
        const u = this.one("SELECT * FROM users WHERE email=?", q);
        if (!u) return json({ error: "لا يوجد مستخدم بهذا البريد" }, 404);
        return json({ user: this.pub(u) });
      }

      if (p === "/api/user") {
        const u = this.one("SELECT * FROM users WHERE id=?", Number(url.searchParams.get("id")));
        return u ? json({ user: this.pub(u) }) : json({ error: "not found" }, 404);
      }

      if (p === "/api/chats") {
        const rows = this.all(
          `SELECT m.*, CASE WHEN m.a=?1 THEN m.b ELSE m.a END AS peer FROM messages m
           WHERE m.id IN (SELECT MAX(id) FROM messages WHERE a=?1 OR b=?1 GROUP BY CASE WHEN a=?1 THEN b ELSE a END)
           ORDER BY m.id DESC`, me.id);
        const chats = rows.map((m) => {
          const u = this.one("SELECT * FROM users WHERE id=?", m.peer);
          const unread = this.one("SELECT COUNT(*) AS n FROM messages WHERE a=? AND b=? AND status<2", m.peer, me.id).n;
          return { user: this.pub(u), last: m, unread };
        });
        return json({ chats });
      }

      if (p === "/api/messages") {
        const w = Number(url.searchParams.get("with"));
        const before = Number(url.searchParams.get("before")) || 1e15;
        const msgs = this.all(
          "SELECT * FROM messages WHERE ((a=? AND b=?) OR (a=? AND b=?)) AND id<? ORDER BY id DESC LIMIT 60",
          me.id, w, w, me.id, before).reverse();
        return json({ messages: msgs });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }

  async webSocketMessage(ws, raw) {
    const { uid } = ws.deserializeAttachment() || {};
    if (!uid) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const to = Number(m.to);

    switch (m.t) {
      case "ping":
        ws.send('{"t":"pong"}');
        break;
      case "send": {
        if (!to || !this.one("SELECT id FROM users WHERE id=?", to)) return;
        const body = String(m.body || "").slice(0, 16000);
        const kind = m.kind === "call" ? "call" : "text";
        if (!body.trim()) return;
        const status = this.online(to) ? 1 : 0;
        this.sql.exec("INSERT INTO messages(a,b,body,kind,ts,status) VALUES(?,?,?,?,?,?)", uid, to, body, kind, Date.now(), status);
        const msg = this.one("SELECT * FROM messages WHERE id=last_insert_rowid()");
        ws.send(JSON.stringify({ t: "ack", cid: m.cid, m: msg }));
        for (const o of this.ctx.getWebSockets(String(uid))) if (o !== ws) try { o.send(JSON.stringify({ t: "msg", m: msg })); } catch {}
        const me = this.one("SELECT * FROM users WHERE id=?", uid);
        this.sendTo(to, { t: "msg", m: msg, user: this.pub(me) });
        break;
      }
      case "read": {
        if (!to) return;
        this.sql.exec("UPDATE messages SET status=2 WHERE a=? AND b=? AND status<2", to, uid);
        this.sendTo(to, { t: "status", with: uid, status: 2 });
        break;
      }
      case "typing":
        if (to) this.sendTo(to, { t: "typing", from: uid });
        break;
      case "signal": {
        // تمرير إشارات المكالمة (offer/answer/ice/end/reject/busy)
        if (!to) return;
        if (m.data && m.data.kind === "offer" && !this.online(to)) {
          ws.send(JSON.stringify({ t: "signal", from: to, data: { kind: "unavailable", callId: m.data.callId } }));
          return;
        }
        const me = this.one("SELECT * FROM users WHERE id=?", uid);
        this.sendTo(to, { t: "signal", from: uid, user: this.pub(me), data: m.data });
        break;
      }
    }
  }

  async webSocketClose(ws) { this.left(ws); }
  async webSocketError(ws) { this.left(ws); }
  left(ws) {
    const { uid } = ws.deserializeAttachment() || {};
    if (!uid) return;
    try { ws.close(); } catch {}
    const still = this.ctx.getWebSockets(String(uid)).filter((o) => o !== ws && o.readyState === 1).length;
    if (!still) {
      this.sql.exec("UPDATE users SET last_seen=? WHERE id=?", Date.now(), uid);
      this.presence(uid, false);
    }
  }
}
