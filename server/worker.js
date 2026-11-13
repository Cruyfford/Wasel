// Wasel — سيرفر المراسلة والمكالمات (Cloudflare Worker + Durable Objects)
// السيرفر لا يرى أي محتوى: الرسائل والملفات والإشارات مشفّرة على الجهاز قبل الإرسال.
import APP_HTML from "./app.html";
export { GameRoom } from "./game.js";

const CORS = { "access-control-allow-origin": "*" };
const JSON_H = { "content-type": "application/json; charset=utf-8", ...CORS };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: JSON_H });
const HTML_H = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(self), microphone=(self), geolocation=()",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' wss: https:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
const MAX_CHUNKS = 60; // 60 × 1MB = حد الملف 60MB

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS")
      return new Response(null, { headers: { ...CORS, "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST" } });
    if (url.pathname === "/" || url.pathname === "/index.html") return new Response(APP_HTML, { headers: HTML_H });
    if (url.pathname === "/api/turn") return turn(env);
    if (url.pathname === "/game") {
      const code = (url.searchParams.get("room") || "").toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(code)) return new Response("bad room", { status: 400 });
      return env.GAME.get(env.GAME.idFromName(code)).fetch(req);
    }
    if (url.pathname === "/api/file") return env.HUB.get(env.HUB.idFromName("files")).fetch(req);
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return env.HUB.get(env.HUB.idFromName("main")).fetch(req);
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
const safeEq = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };

export class Hub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, name TEXT, about TEXT DEFAULT '', salt TEXT, hash TEXT, created INTEGER, last_seen INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, uid INTEGER, created INTEGER);
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, a INTEGER, b INTEGER, body TEXT, kind TEXT DEFAULT 'text', ts INTEGER, status INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS msg_pair ON messages(a, b, id);
      CREATE INDEX IF NOT EXISTS msg_to ON messages(b, status);
      CREATE TABLE IF NOT EXISTS pending_calls(callee INTEGER PRIMARY KEY, caller INTEGER, payload TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS attempts(email TEXT PRIMARY KEY, n INTEGER, until INTEGER);
      CREATE TABLE IF NOT EXISTS files(id TEXT, i INTEGER, data BLOB, ts INTEGER, PRIMARY KEY(id, i));
    `);
    const cols = ["pub TEXT", "backup TEXT", "avatar TEXT", "hide_seen INTEGER DEFAULT 0", "receipts INTEGER DEFAULT 1"];
    for (const c of cols) { try { this.sql.exec(`ALTER TABLE users ADD COLUMN ${c}`); } catch {} }
    for (const c of ["reply INTEGER", "deleted INTEGER DEFAULT 0"]) { try { this.sql.exec(`ALTER TABLE messages ADD COLUMN ${c}`); } catch {} }
  }

  one(q, ...a) { return this.sql.exec(q, ...a).toArray()[0] || null; }
  all(q, ...a) { return this.sql.exec(q, ...a).toArray(); }
  user(id) { return this.one("SELECT * FROM users WHERE id=?", id); }
  pub(u, self) {
    if (!u) return null;
    const hide = !self && u.hide_seen;
    return {
      id: u.id, email: u.email, name: u.name, about: u.about, pub: u.pub || null, avatar: u.avatar || null,
      online: hide ? false : this.online(u.id), last_seen: hide ? 0 : u.last_seen,
      ...(self ? { hide_seen: !!u.hide_seen, receipts: u.receipts !== 0 } : {}),
    };
  }
  online(uid) { return this.ctx.getWebSockets(String(uid)).length > 0; }
  sendTo(uid, obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets(String(uid))) { try { ws.send(s); } catch {} }
  }
  auth(req, url) {
    const t = (req.headers.get("authorization") || "").replace(/^Bearer /, "") || url.searchParams.get("token");
    if (!t) return null;
    const s = this.one("SELECT uid FROM sessions WHERE token=?", t);
    return s ? this.user(s.uid) : null;
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
    const u = this.user(uid);
    if (!u || u.hide_seen) return;
    for (const c of this.contactsOf(uid)) this.sendTo(c, { t: "presence", id: uid, online, last_seen: Date.now() });
  }
  // رسائلي إلى شخص أطفأ "علامات القراءة" لا تظهر كمقروءة
  shape(m, me) {
    if (m.deleted) m.body = "";
    if (m.a === me && m.status === 2) { const p = this.user(m.b); if (p && p.receipts === 0) m.status = 1; }
    return m;
  }
  async checkPass(u, pass) { return !!u && !!u.hash && safeEq(await hashPass(String(pass || ""), u.salt), u.hash); }

  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      // ---------- الملفات (نسخة "files" فقط) ----------
      if (p === "/internal/put") {
        const id = url.searchParams.get("id"), i = Number(url.searchParams.get("i"));
        const data = await req.arrayBuffer();
        this.sql.exec("INSERT OR REPLACE INTO files VALUES(?,?,?,?)", id, i, data, Date.now());
        return json({ ok: true });
      }
      if (p === "/api/file") {
        const id = url.searchParams.get("id") || "", i = Number(url.searchParams.get("i"));
        if (!/^[a-f0-9]{32}$/.test(id)) return new Response("bad id", { status: 400 });
        const r = this.one("SELECT data FROM files WHERE id=? AND i=?", id, i);
        if (!r) return new Response("not found", { status: 404, headers: CORS });
        return new Response(r.data, { headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=31536000, immutable", ...CORS } });
      }

      if (p === "/ws") {
        if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
        const me = this.auth(req, url);
        if (!me) return new Response("unauthorized", { status: 401 });
        const pair = new WebSocketPair();
        const wasOnline = this.online(me.id);
        this.ctx.acceptWebSocket(pair[1], [String(me.id)]);
        pair[1].serializeAttachment({ uid: me.id });
        const pending = this.all("SELECT DISTINCT a FROM messages WHERE b=? AND status=0", me.id);
        this.sql.exec("UPDATE messages SET status=1 WHERE b=? AND status=0", me.id);
        for (const r of pending) this.sendTo(r.a, { t: "status", with: me.id, status: 1 });
        // مكالمة ترن الآن؟ نعيد إرسالها للجهاز الذي اتصل للتو
        const call = this.one("SELECT * FROM pending_calls WHERE callee=? AND ts>?", me.id, Date.now() - 45000);
        if (call) pair[1].send(JSON.stringify({ t: "signal", from: call.caller, user: this.pub(this.user(call.caller)), data: JSON.parse(call.payload) }));
        if (!wasOnline) this.presence(me.id, true);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }

      if (p === "/api/upload") {
        const me = this.auth(req, url);
        if (!me) return json({ error: "unauthorized" }, 401);
        const id = url.searchParams.get("id") || "", i = Number(url.searchParams.get("i"));
        if (!/^[a-f0-9]{32}$/.test(id) || !(i >= 0 && i < MAX_CHUNKS)) return json({ error: "bad chunk" }, 400);
        const data = await req.arrayBuffer();
        if (data.byteLength > 1100000) return json({ error: "chunk too large" }, 413);
        const files = this.env.HUB.get(this.env.HUB.idFromName("files"));
        return files.fetch(`https://internal/internal/put?id=${id}&i=${i}`, { method: "POST", body: data });
      }

      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

      if (p === "/api/register") {
        const email = String(body.email || "").trim().toLowerCase();
        const name = String(body.name || "").trim().slice(0, 40);
        const pass = String(body.password || "");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return json({ error: "البريد الإلكتروني غير صحيح" }, 400);
        if (pass.length < 6) return json({ error: "كلمة المرور قصيرة" }, 400);
        if (!name) return json({ error: "اكتب اسمك" }, 400);
        if (this.one("SELECT id FROM users WHERE email=?", email)) return json({ error: "هذا البريد مسجّل مسبقاً" }, 409);
        const salt = randHex(16);
        const hash = await hashPass(pass, salt);
        const pubk = typeof body.pub === "string" ? body.pub.slice(0, 200) : null;
        const backup = typeof body.backup === "string" ? body.backup.slice(0, 2000) : null;
        this.sql.exec("INSERT INTO users(email,name,salt,hash,created,pub,backup) VALUES(?,?,?,?,?,?,?)", email, name, salt, hash, Date.now(), pubk, backup);
        const u = this.one("SELECT * FROM users WHERE email=?", email);
        return json({ token: this.newSession(u.id), user: this.pub(u, true) });
      }

      if (p === "/api/login") {
        const email = String(body.email || "").trim().toLowerCase();
        // حماية من تخمين كلمة المرور: 8 محاولات خاطئة = قفل 15 دقيقة
        const at = this.one("SELECT * FROM attempts WHERE email=?", email);
        if (at && at.until > Date.now()) return json({ error: `محاولات خاطئة كثيرة. حاول بعد ${Math.ceil((at.until - Date.now()) / 60000)} دقيقة` }, 429);
        const u = this.one("SELECT * FROM users WHERE email=?", email);
        if (!(await this.checkPass(u, body.password))) {
          const n = (at ? at.n : 0) + 1;
          this.sql.exec("INSERT OR REPLACE INTO attempts VALUES(?,?,?)", email, n >= 8 ? 0 : n, n >= 8 ? Date.now() + 15 * 60000 : 0);
          return json({ error: "البريد أو كلمة المرور غير صحيحة" }, 401);
        }
        this.sql.exec("DELETE FROM attempts WHERE email=?", email);
        return json({ token: this.newSession(u.id), user: this.pub(u, true), backup: u.backup || null });
      }

      const me = this.auth(req, url);
      if (!me) return json({ error: "unauthorized" }, 401);
      const token = (req.headers.get("authorization") || "").replace(/^Bearer /, "");

      if (p === "/api/me") {
        if (req.method === "POST") {
          const name = body.name !== undefined ? String(body.name).trim().slice(0, 40) || me.name : me.name;
          const about = body.about !== undefined ? String(body.about).slice(0, 140) : me.about;
          let avatar = me.avatar;
          if (body.avatar !== undefined) {
            avatar = body.avatar === null ? null : String(body.avatar);
            if (avatar && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar) || avatar.length > 200000)) return json({ error: "صورة غير صالحة" }, 400);
          }
          const hide = body.hide_seen !== undefined ? (body.hide_seen ? 1 : 0) : me.hide_seen;
          const rec = body.receipts !== undefined ? (body.receipts ? 1 : 0) : me.receipts;
          this.sql.exec("UPDATE users SET name=?, about=?, avatar=?, hide_seen=?, receipts=? WHERE id=?", name, about, avatar, hide, rec, me.id);
          const u = this.pub(this.user(me.id));
          for (const c of this.contactsOf(me.id)) this.sendTo(c, { t: "profile", user: u });
        }
        return json({ user: this.pub(this.user(me.id), true) });
      }

      if (p === "/api/keys") {
        if (me.pub) return json({ error: "المفاتيح موجودة مسبقاً" }, 409);
        this.sql.exec("UPDATE users SET pub=?, backup=? WHERE id=?", String(body.pub || "").slice(0, 200), String(body.backup || "").slice(0, 2000), me.id);
        return json({ user: this.pub(this.user(me.id), true) });
      }

      if (p === "/api/upgrade") {
        const salt = randHex(16);
        this.sql.exec("UPDATE users SET salt=?, hash=? WHERE id=?", salt, await hashPass(String(body.password || ""), salt), me.id);
        return json({ ok: true });
      }

      if (p === "/api/password") {
        if (!(await this.checkPass(me, body.old))) return json({ error: "كلمة المرور الحالية غير صحيحة" }, 403);
        if (String(body.password || "").length < 6 || typeof body.backup !== "string") return json({ error: "بيانات ناقصة" }, 400);
        const salt = randHex(16);
        this.sql.exec("UPDATE users SET salt=?, hash=?, backup=? WHERE id=?", salt, await hashPass(String(body.password), salt), body.backup.slice(0, 2000), me.id);
        this.sql.exec("DELETE FROM sessions WHERE uid=? AND token<>?", me.id, token);
        return json({ ok: true });
      }

      if (p === "/api/logout") {
        this.sql.exec("DELETE FROM sessions WHERE token=?", token);
        return json({ ok: true });
      }
      if (p === "/api/logout-all") {
        this.sql.exec("DELETE FROM sessions WHERE uid=? AND token<>?", me.id, token);
        for (const ws of this.ctx.getWebSockets(String(me.id))) { try { ws.close(4001, "logout"); } catch {} }
        return json({ ok: true });
      }
      if (p === "/api/sessions") return json({ count: this.one("SELECT COUNT(*) AS n FROM sessions WHERE uid=?", me.id).n });

      if (p === "/api/delete-account") {
        if (!(await this.checkPass(me, body.password))) return json({ error: "كلمة المرور غير صحيحة" }, 403);
        this.sql.exec("DELETE FROM sessions WHERE uid=?", me.id);
        this.sql.exec("DELETE FROM messages WHERE a=? OR b=?", me.id, me.id);
        this.sql.exec("UPDATE users SET email=?, name='حساب محذوف', about='', avatar=NULL, pub=NULL, backup=NULL, hash='' WHERE id=?", "deleted-" + me.id + "-" + randHex(4), me.id);
        return json({ ok: true });
      }

      if (p === "/api/find") {
        const q = String(url.searchParams.get("email") || "").trim().toLowerCase();
        const u = this.one("SELECT * FROM users WHERE email=?", q);
        if (!u) return json({ error: "لا يوجد مستخدم بهذا البريد" }, 404);
        return json({ user: this.pub(u) });
      }

      if (p === "/api/user") {
        const u = this.user(Number(url.searchParams.get("id")));
        return u ? json({ user: this.pub(u, u.id === me.id) }) : json({ error: "not found" }, 404);
      }

      if (p === "/api/chats") {
        const rows = this.all(
          `SELECT m.*, CASE WHEN m.a=?1 THEN m.b ELSE m.a END AS peer FROM messages m
           WHERE m.id IN (SELECT MAX(id) FROM messages WHERE a=?1 OR b=?1 GROUP BY CASE WHEN a=?1 THEN b ELSE a END)
           ORDER BY m.id DESC`, me.id);
        const chats = rows.map((m) => {
          const unread = this.one("SELECT COUNT(*) AS n FROM messages WHERE a=? AND b=? AND status<2 AND deleted=0", m.peer, me.id).n;
          return { user: this.pub(this.user(m.peer)), last: this.shape(m, me.id), unread };
        });
        return json({ chats });
      }

      if (p === "/api/messages") {
        const w = Number(url.searchParams.get("with"));
        const before = Number(url.searchParams.get("before")) || 1e15;
        const msgs = this.all(
          "SELECT * FROM messages WHERE ((a=? AND b=?) OR (a=? AND b=?)) AND id<? ORDER BY id DESC LIMIT 80",
          me.id, w, w, me.id, before).reverse();
        return json({ messages: msgs.map((m) => this.shape(m, me.id)) });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }

  async webSocketMessage(ws, raw) {
    const { uid } = ws.deserializeAttachment() || {};
    if (!uid || typeof raw !== "string" || raw.length > 70000) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const to = Number(m.to);

    switch (m.t) {
      case "ping":
        ws.send('{"t":"pong"}');
        break;
      case "send": {
        if (!to || to === uid || !this.user(to)) return;
        const body = String(m.body || "").slice(0, 64000);
        const kind = ["text", "call", "file", "voice"].includes(m.kind) ? m.kind : "text";
        const reply = Number(m.reply) || null;
        if (!body.trim()) return;
        const status = this.online(to) ? 1 : 0;
        this.sql.exec("INSERT INTO messages(a,b,body,kind,ts,status,reply) VALUES(?,?,?,?,?,?,?)", uid, to, body, kind, Date.now(), status, reply);
        const msg = this.one("SELECT * FROM messages WHERE id=last_insert_rowid()");
        ws.send(JSON.stringify({ t: "ack", cid: m.cid, m: msg }));
        for (const o of this.ctx.getWebSockets(String(uid))) if (o !== ws) try { o.send(JSON.stringify({ t: "msg", m: msg })); } catch {}
        this.sendTo(to, { t: "msg", m: msg, user: this.pub(this.user(uid)) });
        break;
      }
      case "read": {
        if (!to) return;
        this.sql.exec("UPDATE messages SET status=2 WHERE a=? AND b=? AND status<2", to, uid);
        const me = this.user(uid);
        if (me && me.receipts !== 0) this.sendTo(to, { t: "status", with: uid, status: 2 });
        break;
      }
      case "delete": {
        const msg = this.one("SELECT * FROM messages WHERE id=? AND a=?", Number(m.id), uid);
        if (!msg) return;
        this.sql.exec("UPDATE messages SET deleted=1, body='' WHERE id=?", msg.id);
        const ev = { t: "deleted", id: msg.id, a: msg.a, b: msg.b };
        this.sendTo(msg.a, ev); this.sendTo(msg.b, ev);
        break;
      }
      case "typing":
        if (to) this.sendTo(to, { t: "typing", from: uid, rec: !!m.rec });
        break;
      case "signal": {
        if (!to || !m.data || typeof m.data.kind !== "string") return;
        const kind = m.data.kind;
        if (kind === "offer") {
          if (!this.online(to)) {
            ws.send(JSON.stringify({ t: "signal", from: to, data: { kind: "unavailable", callId: m.data.callId } }));
            return;
          }
          this.sql.exec("INSERT OR REPLACE INTO pending_calls VALUES(?,?,?,?)", to, uid, JSON.stringify(m.data), Date.now());
        } else if (["answer", "end", "reject", "busy"].includes(kind)) {
          this.sql.exec("DELETE FROM pending_calls WHERE (callee=? AND caller=?) OR (callee=? AND caller=?)", to, uid, uid, to);
        }
        this.sendTo(to, { t: "signal", from: uid, user: this.pub(this.user(uid)), data: m.data });
        // أجهزتي الأخرى: أوقف الرنين إذا رددت/رفضت من جهاز آخر
        if (["answer", "reject"].includes(kind))
          for (const o of this.ctx.getWebSockets(String(uid))) if (o !== ws) try { o.send(JSON.stringify({ t: "signal", from: to, data: { kind: "handled", callId: m.data.callId } })); } catch {}
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
