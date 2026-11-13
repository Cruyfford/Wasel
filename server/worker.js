// Wasel — سيرفر المراسلة والمكالمات (Cloudflare Worker + Durable Objects)
// السيرفر لا يرى أي محتوى: الرسائل والملفات والحالات والإشارات مشفّرة على الجهاز قبل الإرسال.
import APP_HTML from "./app.html";

const CORS = { "access-control-allow-origin": "*" };
const JSON_H = { "content-type": "application/json; charset=utf-8", ...CORS };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: JSON_H });
const HTML_H = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(self), microphone=(self), geolocation=(self)",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' wss: https:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
const MAX_CHUNKS = 60; // 60 × 1MB
const FILE_DAYS = 30; // الملفات تُحذف من السيرفر بعد 30 يوماً
const MAX_GROUP = 64;
const MAX_GCALL = 8;
const DAY = 86400000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS")
      return new Response(null, { headers: { ...CORS, "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST" } });
    if (url.pathname === "/" || url.pathname === "/index.html") return new Response(APP_HTML, { headers: HTML_H });
    if (url.pathname === "/api/turn") return turn(env);
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

// معاينة الروابط: يطلبها المرسل فقط، وتُرسل مشفّرة داخل الرسالة
async function linkPreview(target) {
  let u;
  try { u = new URL(target); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(u.toString(), { signal: ctl.signal, redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; WaselPreview/1.0)", accept: "text/html" } });
    if (!r.ok || !(r.headers.get("content-type") || "").includes("text/html")) return null;
    const reader = r.body.getReader();
    let html = "", size = 0;
    const td = new TextDecoder();
    while (size < 300000) { const { done, value } = await reader.read(); if (done) break; size += value.length; html += td.decode(value, { stream: true }); if (/<\/head>/i.test(html)) break; }
    try { reader.cancel(); } catch {}
    const meta = (p) => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']*)["']`, "i")) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${p}["']`, "i"));
      return m ? decodeEntities(m[1]).slice(0, 300) : "";
    };
    const title = meta("og:title") || decodeEntities((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "").slice(0, 200);
    const desc = meta("og:description") || meta("description");
    let img = null;
    const imgUrl = meta("og:image");
    if (imgUrl) {
      try {
        const ir = await fetch(new URL(imgUrl, u).toString(), { signal: ctl.signal });
        const ct = ir.headers.get("content-type") || "";
        if (ir.ok && /^image\/(jpeg|png|webp)/.test(ct)) {
          const buf = await ir.arrayBuffer();
          if (buf.byteLength < 180000) img = `data:${ct.split(";")[0]};base64,` + b64(buf);
        }
      } catch {}
    }
    if (!title && !desc) return null;
    return { url: u.toString(), title, desc, img, site: u.hostname };
  } catch { return null; } finally { clearTimeout(t); }
}
const decodeEntities = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
const b64 = (buf) => { const a = new Uint8Array(buf); let s = ""; for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.subarray(i, i + 8192)); return btoa(s); };

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
const okImg = (s) => typeof s === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length < 200000;
const pairKey = (a, b) => "u" + Math.min(a, b) + "-" + Math.max(a, b);

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
      CREATE TABLE IF NOT EXISTS reactions(mid INTEGER, uid INTEGER, e TEXT, PRIMARY KEY(mid, uid));
      CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, avatar TEXT, owner INTEGER, created INTEGER);
      CREATE TABLE IF NOT EXISTS gmembers(gid INTEGER, uid INTEGER, admin INTEGER DEFAULT 0, last_read INTEGER DEFAULT 0, joined INTEGER, PRIMARY KEY(gid, uid));
      CREATE INDEX IF NOT EXISTS gm_uid ON gmembers(uid);
      CREATE TABLE IF NOT EXISTS blocks(uid INTEGER, bid INTEGER, PRIMARY KEY(uid, bid));
      CREATE TABLE IF NOT EXISTS prefs(uid INTEGER, ckey TEXT, pinned INTEGER DEFAULT 0, muted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, PRIMARY KEY(uid, ckey));
      CREATE TABLE IF NOT EXISTS ttl(ckey TEXT PRIMARY KEY, secs INTEGER);
      CREATE TABLE IF NOT EXISTS statuses(id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER, body TEXT, kind TEXT, ts INTEGER, expires INTEGER);
      CREATE TABLE IF NOT EXISTS srecv(sid INTEGER, uid INTEGER, viewed INTEGER DEFAULT 0, PRIMARY KEY(sid, uid));
      CREATE TABLE IF NOT EXISTS ratelimit(k TEXT PRIMARY KEY, n INTEGER, start INTEGER);
      CREATE TABLE IF NOT EXISTS gcalls(gid INTEGER, uid INTEGER, video INTEGER, joined INTEGER, PRIMARY KEY(gid, uid));
    `);
    const ucols = ["pub TEXT", "backup TEXT", "avatar TEXT", "hide_seen INTEGER DEFAULT 0", "receipts INTEGER DEFAULT 1", "pin TEXT"];
    for (const c of ucols) { try { this.sql.exec(`ALTER TABLE users ADD COLUMN ${c}`); } catch {} }
    this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_pin ON users(pin)");
    for (const r of this.all("SELECT id FROM users WHERE pin IS NULL AND hash<>''")) this.sql.exec("UPDATE users SET pin=? WHERE id=?", this.newPin(), r.id);
    const mcols = ["reply INTEGER", "deleted INTEGER DEFAULT 0", "gid INTEGER", "edited INTEGER DEFAULT 0", "fwd INTEGER DEFAULT 0", "expires INTEGER"];
    for (const c of mcols) { try { this.sql.exec(`ALTER TABLE messages ADD COLUMN ${c}`); } catch {} }
    this.sql.exec("CREATE INDEX IF NOT EXISTS msg_gid ON messages(gid, id)");
    ctx.blockConcurrencyWhile(async () => { if (!(await ctx.storage.getAlarm())) await ctx.storage.setAlarm(Date.now() + 60000); });
  }

  // تنظيف دوري: الرسائل المختفية، الحالات المنتهية، الملفات القديمة
  async alarm() {
    const now = Date.now();
    this.sql.exec("DELETE FROM reactions WHERE mid IN (SELECT id FROM messages WHERE expires IS NOT NULL AND expires<?)", now);
    this.sql.exec("DELETE FROM messages WHERE expires IS NOT NULL AND expires<?", now);
    this.sql.exec("DELETE FROM srecv WHERE sid IN (SELECT id FROM statuses WHERE expires<?)", now);
    this.sql.exec("DELETE FROM statuses WHERE expires<?", now);
    this.sql.exec("DELETE FROM pending_calls WHERE ts<?", now - 60000);
    this.sql.exec("DELETE FROM files WHERE ts<?", now - FILE_DAYS * DAY);
    this.sql.exec("DELETE FROM ratelimit WHERE start<?", now - DAY);
    await this.ctx.storage.setAlarm(now + 3600000);
  }

  newPin() {
    for (;;) {
      const pin = randHex(4).toUpperCase();
      if (!/^0/.test(pin) && !this.one("SELECT id FROM users WHERE pin=?", pin)) return pin;
    }
  }
  one(q, ...a) { return this.sql.exec(q, ...a).toArray()[0] || null; }
  all(q, ...a) { return this.sql.exec(q, ...a).toArray(); }
  user(id) { return this.one("SELECT * FROM users WHERE id=?", id); }
  blocked(by, who) { return !!this.one("SELECT 1 AS x FROM blocks WHERE uid=? AND bid=?", by, who); }
  pub(u, self) {
    if (!u) return null;
    const hide = !self && u.hide_seen;
    return {
      id: u.id, pin: u.pin, name: u.name, about: u.about, pub: u.pub || null, avatar: u.avatar || null,
      online: hide ? false : this.online(u.id), last_seen: hide ? 0 : u.last_seen,
      ...(self ? { email: u.email, hide_seen: !!u.hide_seen, receipts: u.receipts !== 0 } : {}),
    };
  }
  online(uid) { return this.ctx.getWebSockets(String(uid)).length > 0; }
  sendTo(uid, obj, except) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets(String(uid))) if (ws !== except) { try { ws.send(s); } catch {} }
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
  limit(k, max, windowMs) {
    const now = Date.now();
    const r = this.one("SELECT * FROM ratelimit WHERE k=?", k);
    if (!r || r.start < now - windowMs) { this.sql.exec("INSERT OR REPLACE INTO ratelimit VALUES(?,?,?)", k, 1, now); return true; }
    if (r.n >= max) return false;
    this.sql.exec("UPDATE ratelimit SET n=n+1 WHERE k=?", k);
    return true;
  }
  contactsOf(uid) {
    return this.all("SELECT DISTINCT CASE WHEN a=? THEN b ELSE a END AS id FROM messages WHERE gid IS NULL AND (a=? OR b=?)", uid, uid, uid).map((r) => r.id);
  }
  members(gid) { return this.all("SELECT uid, admin FROM gmembers WHERE gid=?", gid); }
  isMember(gid, uid) { return this.one("SELECT admin FROM gmembers WHERE gid=? AND uid=?", gid, uid); }
  presence(uid, online) {
    const u = this.user(uid);
    if (!u || u.hide_seen) return;
    for (const c of this.contactsOf(uid)) if (!this.blocked(c, uid) && !this.blocked(uid, c)) this.sendTo(c, { t: "presence", id: uid, online, last_seen: Date.now() });
  }
  // من يستلم أحداث رسالة معينة
  audience(m) { return m.gid ? this.members(m.gid).map((x) => x.uid) : [m.a, m.b]; }
  shape(m, me) {
    if (m.deleted) m.body = "";
    if (!m.gid && m.a === me && m.status === 2) { const p = this.user(m.b); if (p && p.receipts === 0) m.status = 1; }
    const r = this.all("SELECT uid, e FROM reactions WHERE mid=?", m.id);
    if (r.length) m.reacts = Object.fromEntries(r.map((x) => [x.uid, x.e]));
    return m;
  }
  groupInfo(gid, me) {
    const g = this.one("SELECT * FROM groups WHERE id=?", gid);
    if (!g) return null;
    const mem = this.members(gid);
    return { id: g.id, name: g.name, avatar: g.avatar, owner: g.owner, created: g.created, members: mem.map((x) => ({ ...this.pub(this.user(x.uid), x.uid === me), admin: !!x.admin })) };
  }
  prefsOf(uid, ckey) { return this.one("SELECT pinned, muted, archived FROM prefs WHERE uid=? AND ckey=?", uid, ckey) || { pinned: 0, muted: 0, archived: 0 }; }
  ttlOf(ckey) { const r = this.one("SELECT secs FROM ttl WHERE ckey=?", ckey); return r ? r.secs : 0; }
  sysMsg(gid, a, b, text) {
    this.sql.exec("INSERT INTO messages(a,b,body,kind,ts,status,gid) VALUES(?,?,?,?,?,?,?)", a, b, text, "sys", Date.now(), 1, gid || null);
    const m = this.one("SELECT * FROM messages WHERE id=last_insert_rowid()");
    for (const uid of this.audience(m)) this.sendTo(uid, { t: "msg", m, ...(gid ? { group: this.groupInfo(gid, uid) } : { user: this.pub(this.user(a)) }) });
    return m;
  }
  async checkPass(u, pass) { return !!u && !!u.hash && safeEq(await hashPass(String(pass || ""), u.salt), u.hash); }
  ckeyFromClient(c, me) {
    if (/^g\d+$/.test(c)) return this.isMember(Number(c.slice(1)), me) ? c : null;
    if (/^u\d+$/.test(c)) return pairKey(me, Number(c.slice(1)));
    return null;
  }

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
        const pending = this.all("SELECT DISTINCT a FROM messages WHERE b=? AND status=0 AND gid IS NULL", me.id);
        this.sql.exec("UPDATE messages SET status=1 WHERE b=? AND status=0 AND gid IS NULL", me.id);
        for (const r of pending) this.sendTo(r.a, { t: "status", with: me.id, status: 1 });
        const call = this.one("SELECT * FROM pending_calls WHERE callee=? AND ts>?", me.id, Date.now() - 45000);
        if (call) pair[1].send(JSON.stringify({ t: "signal", from: call.caller, user: this.pub(this.user(call.caller)), data: JSON.parse(call.payload) }));
        for (const g of this.all("SELECT DISTINCT c.gid FROM gcalls c JOIN gmembers m ON m.gid=c.gid WHERE m.uid=?", me.id))
          pair[1].send(JSON.stringify({ t: "gcall", a: "state", gid: g.gid, peers: this.all("SELECT uid FROM gcalls WHERE gid=?", g.gid).map((x) => x.uid) }));
        if (!wasOnline) this.presence(me.id, true);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }

      if (p === "/api/upload") {
        const me = this.auth(req, url);
        if (!me) return json({ error: "unauthorized" }, 401);
        const id = url.searchParams.get("id") || "", i = Number(url.searchParams.get("i"));
        if (!/^[a-f0-9]{32}$/.test(id) || !(i >= 0 && i < MAX_CHUNKS)) return json({ error: "bad chunk" }, 400);
        if (!this.limit("up:" + me.id, 600, 3600000)) return json({ error: "رفعت ملفات كثيرة، انتظر قليلاً" }, 429);
        const data = await req.arrayBuffer();
        if (data.byteLength > 1100000) return json({ error: "chunk too large" }, 413);
        const files = this.env.HUB.get(this.env.HUB.idFromName("files"));
        return files.fetch(`https://internal/internal/put?id=${id}&i=${i}`, { method: "POST", body: data });
      }

      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

      if (p === "/api/register") {
        const ip = req.headers.get("cf-connecting-ip") || "x";
        if (!this.limit("reg:" + ip, 10, DAY)) return json({ error: "محاولات تسجيل كثيرة، حاول لاحقاً" }, 429);
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
        this.sql.exec("INSERT INTO users(email,name,salt,hash,created,pub,backup,pin) VALUES(?,?,?,?,?,?,?,?)", email, name, salt, hash, Date.now(), pubk, backup, this.newPin());
        const u = this.one("SELECT * FROM users WHERE email=?", email);
        return json({ token: this.newSession(u.id), user: this.pub(u, true) });
      }

      if (p === "/api/login") {
        const email = String(body.email || "").trim().toLowerCase();
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
            if (avatar && !okImg(avatar)) return json({ error: "صورة غير صالحة" }, 400);
          }
          const hide = body.hide_seen !== undefined ? (body.hide_seen ? 1 : 0) : me.hide_seen;
          const rec = body.receipts !== undefined ? (body.receipts ? 1 : 0) : me.receipts;
          this.sql.exec("UPDATE users SET name=?, about=?, avatar=?, hide_seen=?, receipts=? WHERE id=?", name, about, avatar, hide, rec, me.id);
          const u = this.pub(this.user(me.id));
          const seen = new Set(this.contactsOf(me.id));
          for (const g of this.all("SELECT gid FROM gmembers WHERE uid=?", me.id)) for (const x of this.members(g.gid)) seen.add(x.uid);
          seen.delete(me.id);
          for (const c of seen) this.sendTo(c, { t: "profile", user: u });
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
      if (p === "/api/logout") { this.sql.exec("DELETE FROM sessions WHERE token=?", token); return json({ ok: true }); }
      if (p === "/api/logout-all") {
        this.sql.exec("DELETE FROM sessions WHERE uid=? AND token<>?", me.id, token);
        for (const ws of this.ctx.getWebSockets(String(me.id))) { try { ws.close(4001, "logout"); } catch {} }
        return json({ ok: true });
      }
      if (p === "/api/sessions") return json({ count: this.one("SELECT COUNT(*) AS n FROM sessions WHERE uid=?", me.id).n });
      if (p === "/api/delete-account") {
        if (!(await this.checkPass(me, body.password))) return json({ error: "كلمة المرور غير صحيحة" }, 403);
        this.sql.exec("DELETE FROM sessions WHERE uid=?", me.id);
        this.sql.exec("DELETE FROM messages WHERE (a=? OR b=?) AND gid IS NULL", me.id, me.id);
        this.sql.exec("DELETE FROM gmembers WHERE uid=?", me.id);
        this.sql.exec("DELETE FROM statuses WHERE uid=?", me.id);
        this.sql.exec("UPDATE users SET email=?, name='حساب محذوف', about='', avatar=NULL, pub=NULL, backup=NULL, hash='', pin=NULL WHERE id=?", "deleted-" + me.id + "-" + randHex(4), me.id);
        return json({ ok: true });
      }

      if (p === "/api/find") {
        // حماية من تخمين الأكواد: 30 بحثاً في الساعة
        if (!this.limit("find:" + me.id, 30, 3600000)) return json({ error: "بحثت كثيراً، حاول بعد ساعة" }, 429);
        const q = String(url.searchParams.get("pin") || "").toUpperCase().replace(/[^0-9A-F]/g, "");
        if (q.length !== 8) return json({ error: "الكود يتكون من 8 خانات" }, 400);
        const u = this.one("SELECT * FROM users WHERE pin=?", q);
        if (!u || !u.hash) return json({ error: "لا يوجد مستخدم بهذا الكود" }, 404);
        return json({ user: this.pub(u) });
      }
      if (p === "/api/user") {
        const u = this.user(Number(url.searchParams.get("id")));
        return u ? json({ user: this.pub(u, u.id === me.id), blocked: this.blocked(me.id, u.id) }) : json({ error: "not found" }, 404);
      }
      if (p === "/api/contacts") {
        const ids = this.contactsOf(me.id).filter((id) => !this.blocked(me.id, id));
        return json({ users: ids.map((id) => this.pub(this.user(id))).filter((u) => u && u.pub) });
      }

      if (p === "/api/chats") {
        const rows = this.all(
          `SELECT m.*, CASE WHEN m.a=?1 THEN m.b ELSE m.a END AS peer FROM messages m
           WHERE m.id IN (SELECT MAX(id) FROM messages WHERE gid IS NULL AND (a=?1 OR b=?1) GROUP BY CASE WHEN a=?1 THEN b ELSE a END)`, me.id);
        const chats = rows.map((m) => {
          const ck = pairKey(me.id, m.peer);
          const unread = this.one("SELECT COUNT(*) AS n FROM messages WHERE gid IS NULL AND a=? AND b=? AND status<2 AND deleted=0", m.peer, me.id).n;
          return { key: "u" + m.peer, user: this.pub(this.user(m.peer)), last: this.shape(m, me.id), unread, prefs: this.prefsOf(me.id, ck), ttl: this.ttlOf(ck), blocked: this.blocked(me.id, m.peer) };
        });
        for (const g of this.all("SELECT gid, last_read FROM gmembers WHERE uid=?", me.id)) {
          const last = this.one("SELECT * FROM messages WHERE gid=? ORDER BY id DESC LIMIT 1", g.gid);
          const unread = this.one("SELECT COUNT(*) AS n FROM messages WHERE gid=? AND id>? AND a<>? AND deleted=0 AND kind<>'sys'", g.gid, g.last_read, me.id).n;
          chats.push({ key: "g" + g.gid, group: this.groupInfo(g.gid, me.id), last: last ? this.shape(last, me.id) : null, unread, prefs: this.prefsOf(me.id, "g" + g.gid), ttl: this.ttlOf("g" + g.gid) });
        }
        return json({ chats });
      }

      if (p === "/api/messages" || p === "/api/media") {
        const c = String(url.searchParams.get("c") || "");
        const before = Number(url.searchParams.get("before")) || 1e15;
        const media = p === "/api/media" ? " AND kind IN ('file','voice') AND deleted=0" : "";
        const lim = media ? 300 : 80;
        const now = Date.now();
        let msgs;
        if (c[0] === "g") {
          const gid = Number(c.slice(1));
          if (!this.isMember(gid, me.id)) return json({ error: "لست عضواً" }, 403);
          msgs = this.all(`SELECT * FROM messages WHERE gid=? AND id<? AND (expires IS NULL OR expires>?)${media} ORDER BY id DESC LIMIT ?`, gid, before, now, lim);
        } else {
          const w = Number(c.slice(1));
          msgs = this.all(`SELECT * FROM messages WHERE gid IS NULL AND ((a=? AND b=?) OR (a=? AND b=?)) AND id<? AND (expires IS NULL OR expires>?)${media} ORDER BY id DESC LIMIT ?`, me.id, w, w, me.id, before, now, lim);
        }
        return json({ messages: msgs.reverse().map((m) => this.shape(m, me.id)) });
      }

      if (p === "/api/prefs") {
        const ck = this.ckeyFromClient(String(body.c || ""), me.id);
        if (!ck) return json({ error: "bad" }, 400);
        const cur = this.prefsOf(me.id, ck);
        const v = (k) => (body[k] !== undefined ? (body[k] ? 1 : 0) : cur[k]);
        this.sql.exec("INSERT OR REPLACE INTO prefs VALUES(?,?,?,?,?)", me.id, ck, v("pinned"), v("muted"), v("archived"));
        return json({ prefs: this.prefsOf(me.id, ck) });
      }

      if (p === "/api/ttl") {
        const c = String(body.c || "");
        const ck = this.ckeyFromClient(c, me.id);
        if (!ck) return json({ error: "bad" }, 400);
        const secs = [0, 86400, 604800, 7776000].includes(Number(body.secs)) ? Number(body.secs) : 0;
        this.sql.exec("INSERT OR REPLACE INTO ttl VALUES(?,?)", ck, secs);
        const label = { 0: "أوقف الرسائل المختفية", 86400: "فعّل الرسائل المختفية: 24 ساعة", 604800: "فعّل الرسائل المختفية: 7 أيام", 7776000: "فعّل الرسائل المختفية: 90 يوماً" }[secs];
        if (c[0] === "g") this.sysMsg(Number(c.slice(1)), me.id, 0, `⏱️ ${me.name} ${label}`);
        else this.sysMsg(null, me.id, Number(c.slice(1)), `⏱️ ${me.name} ${label}`);
        return json({ ok: true, secs });
      }

      if (p === "/api/block") {
        const bid = Number(body.uid);
        if (!bid || bid === me.id) return json({ error: "bad" }, 400);
        if (body.on) this.sql.exec("INSERT OR IGNORE INTO blocks VALUES(?,?)", me.id, bid);
        else this.sql.exec("DELETE FROM blocks WHERE uid=? AND bid=?", me.id, bid);
        return json({ ok: true, blocked: !!body.on });
      }
      if (p === "/api/blocks") return json({ users: this.all("SELECT bid FROM blocks WHERE uid=?", me.id).map((r) => this.pub(this.user(r.bid))).filter(Boolean) });

      if (p === "/api/preview") {
        if (!this.limit("pv:" + me.id, 120, 3600000)) return json({ preview: null });
        return json({ preview: await linkPreview(String(url.searchParams.get("url") || "")) });
      }

      // ---------- المجموعات ----------
      if (p === "/api/group/create") {
        const name = String(body.name || "").trim().slice(0, 60);
        if (!name) return json({ error: "اكتب اسم المجموعة" }, 400);
        if (!this.limit("gc:" + me.id, 20, DAY)) return json({ error: "أنشأت مجموعات كثيرة اليوم" }, 429);
        const ids = [...new Set((body.members || []).map(Number))].filter((id) => id && id !== me.id && this.user(id)).slice(0, MAX_GROUP - 1);
        const avatar = okImg(body.avatar) ? body.avatar : null;
        this.sql.exec("INSERT INTO groups(name, avatar, owner, created) VALUES(?,?,?,?)", name, avatar, me.id, Date.now());
        const gid = this.one("SELECT last_insert_rowid() AS id").id;
        this.sql.exec("INSERT INTO gmembers(gid,uid,admin,joined) VALUES(?,?,1,?)", gid, me.id, Date.now());
        for (const id of ids) if (!this.blocked(id, me.id)) this.sql.exec("INSERT OR IGNORE INTO gmembers(gid,uid,admin,joined) VALUES(?,?,0,?)", gid, id, Date.now());
        this.sysMsg(gid, me.id, 0, `${me.name} أنشأ المجموعة "${name}"`);
        return json({ group: this.groupInfo(gid, me.id) });
      }
      if (p.startsWith("/api/group/")) {
        const gid = Number(body.gid ?? url.searchParams.get("gid"));
        const mine = this.isMember(gid, me.id);
        if (!mine) return json({ error: "لست عضواً في المجموعة" }, 403);
        const broadcast = () => { const info = this.groupInfo(gid); for (const x of this.members(gid)) this.sendTo(x.uid, { t: "group", group: info }); };
        if (p === "/api/group/info") return json({ group: this.groupInfo(gid, me.id) });
        if (p === "/api/group/update") {
          if (!mine.admin) return json({ error: "للمشرفين فقط" }, 403);
          const g = this.one("SELECT * FROM groups WHERE id=?", gid);
          const name = body.name !== undefined ? String(body.name).trim().slice(0, 60) || g.name : g.name;
          let avatar = g.avatar;
          if (body.avatar !== undefined) { avatar = body.avatar === null ? null : body.avatar; if (avatar && !okImg(avatar)) return json({ error: "صورة غير صالحة" }, 400); }
          this.sql.exec("UPDATE groups SET name=?, avatar=? WHERE id=?", name, avatar, gid);
          if (name !== g.name) this.sysMsg(gid, me.id, 0, `${me.name} غيّر اسم المجموعة إلى "${name}"`);
          broadcast();
          return json({ group: this.groupInfo(gid, me.id) });
        }
        if (p === "/api/group/add") {
          if (!mine.admin) return json({ error: "للمشرفين فقط" }, 403);
          const u = this.user(Number(body.uid));
          if (!u || !u.hash) return json({ error: "المستخدم غير موجود" }, 404);
          if (this.isMember(gid, u.id)) return json({ error: "موجود في المجموعة" }, 409);
          if (this.members(gid).length >= MAX_GROUP) return json({ error: `الحد الأقصى ${MAX_GROUP} عضواً` }, 400);
          if (this.blocked(u.id, me.id)) return json({ error: "لا يمكن إضافة هذا المستخدم" }, 403);
          this.sql.exec("INSERT INTO gmembers(gid,uid,admin,joined,last_read) VALUES(?,?,0,?,(SELECT IFNULL(MAX(id),0) FROM messages WHERE gid=?))", gid, u.id, Date.now(), gid);
          broadcast();
          this.sysMsg(gid, me.id, 0, `${me.name} أضاف ${u.name}`);
          return json({ group: this.groupInfo(gid, me.id) });
        }
        if (p === "/api/group/remove") {
          const uid = Number(body.uid);
          if (uid !== me.id && !mine.admin) return json({ error: "للمشرفين فقط" }, 403);
          const u = this.user(uid);
          this.sql.exec("DELETE FROM gmembers WHERE gid=? AND uid=?", gid, uid);
          this.sql.exec("DELETE FROM gcalls WHERE gid=? AND uid=?", gid, uid);
          const rest = this.members(gid);
          this.sendTo(uid, { t: "group-removed", gid });
          if (!rest.length) { this.sql.exec("DELETE FROM messages WHERE gid=?", gid); this.sql.exec("DELETE FROM groups WHERE id=?", gid); return json({ ok: true }); }
          if (!rest.some((x) => x.admin)) this.sql.exec("UPDATE gmembers SET admin=1 WHERE gid=? AND uid=?", gid, rest[0].uid);
          this.sysMsg(gid, me.id, 0, uid === me.id ? `${me.name} غادر المجموعة` : `${me.name} أزال ${u ? u.name : ""}`);
          broadcast();
          return json({ ok: true });
        }
        if (p === "/api/group/admin") {
          if (!mine.admin) return json({ error: "للمشرفين فقط" }, 403);
          this.sql.exec("UPDATE gmembers SET admin=? WHERE gid=? AND uid=?", body.admin ? 1 : 0, gid, Number(body.uid));
          broadcast();
          return json({ group: this.groupInfo(gid, me.id) });
        }
      }

      // ---------- الحالات ----------
      if (p === "/api/status" && req.method === "POST") {
        if (!this.limit("st:" + me.id, 50, DAY)) return json({ error: "نشرت حالات كثيرة اليوم" }, 429);
        const b = String(body.body || "").slice(0, 64000);
        if (!b) return json({ error: "فارغة" }, 400);
        const now = Date.now();
        this.sql.exec("INSERT INTO statuses(uid, body, kind, ts, expires) VALUES(?,?,?,?,?)", me.id, b, body.kind === "image" ? "image" : "text", now, now + DAY);
        const sid = this.one("SELECT last_insert_rowid() AS id").id;
        const allowed = new Set(this.contactsOf(me.id));
        for (const uid of (body.to || []).map(Number)) if (allowed.has(uid) && !this.blocked(me.id, uid) && !this.blocked(uid, me.id)) {
          this.sql.exec("INSERT OR IGNORE INTO srecv(sid, uid) VALUES(?,?)", sid, uid);
          this.sendTo(uid, { t: "status-new", uid: me.id });
        }
        return json({ id: sid });
      }
      if (p === "/api/statuses") {
        const now = Date.now();
        const mineS = this.all("SELECT * FROM statuses WHERE uid=? AND expires>? ORDER BY id", me.id, now).map((s) => ({ ...s, views: this.all("SELECT uid FROM srecv WHERE sid=? AND viewed>0", s.id).map((r) => this.pub(this.user(r.uid))) }));
        const others = this.all("SELECT s.*, r.viewed FROM statuses s JOIN srecv r ON r.sid=s.id WHERE r.uid=? AND s.expires>? ORDER BY s.id", me.id, now).filter((s) => !this.blocked(me.id, s.uid));
        const byUser = {};
        for (const s of others) (byUser[s.uid] ||= { user: this.pub(this.user(s.uid)), items: [] }).items.push(s);
        return json({ mine: mineS, others: Object.values(byUser) });
      }
      if (p === "/api/status/view") {
        const sid = Number(body.sid);
        this.sql.exec("UPDATE srecv SET viewed=? WHERE sid=? AND uid=? AND viewed=0", Date.now(), sid, me.id);
        const s = this.one("SELECT uid FROM statuses WHERE id=?", sid);
        if (s) this.sendTo(s.uid, { t: "status-view", sid });
        return json({ ok: true });
      }
      if (p === "/api/status/delete") {
        const sid = Number(body.sid);
        this.sql.exec("DELETE FROM srecv WHERE sid IN (SELECT id FROM statuses WHERE id=? AND uid=?)", sid, me.id);
        this.sql.exec("DELETE FROM statuses WHERE id=? AND uid=?", sid, me.id);
        return json({ ok: true });
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
    const gid = Number(m.gid) || 0;

    switch (m.t) {
      case "ping":
        ws.send('{"t":"pong"}');
        break;
      case "send": {
        const body = String(m.body || "").slice(0, 64000);
        const kind = ["text", "call", "file", "voice", "loc", "contact", "link"].includes(m.kind) ? m.kind : "text";
        const reply = Number(m.reply) || null;
        if (!body.trim()) return;
        if (!this.limit("msg:" + uid, 600, 60000)) return;
        const now = Date.now();
        if (gid) {
          if (!this.isMember(gid, uid)) return;
          const t = this.ttlOf("g" + gid);
          this.sql.exec("INSERT INTO messages(a,b,body,kind,ts,status,reply,gid,fwd,expires) VALUES(?,?,?,?,?,?,?,?,?,?)", uid, 0, body, kind, now, 1, reply, gid, m.fwd ? 1 : 0, t ? now + t * 1000 : null);
          const msg = this.one("SELECT * FROM messages WHERE id=last_insert_rowid()");
          this.sql.exec("UPDATE gmembers SET last_read=? WHERE gid=? AND uid=?", msg.id, gid, uid);
          ws.send(JSON.stringify({ t: "ack", cid: m.cid, m: msg }));
          const sender = this.pub(this.user(uid));
          const gname = (this.one("SELECT name FROM groups WHERE id=?", gid) || {}).name;
          for (const x of this.members(gid)) {
            if (x.uid === uid) { this.sendTo(uid, { t: "msg", m: msg }, ws); continue; }
            this.sendTo(x.uid, { t: "msg", m: msg, user: sender, group: { id: gid, name: gname }, muted: !!this.prefsOf(x.uid, "g" + gid).muted });
          }
          break;
        }
        if (!to || to === uid || !this.user(to)) return;
        if (this.blocked(to, uid) || this.blocked(uid, to)) {
          // المحظور لا تصل رسائله؛ يرى علامة واحدة فقط
          ws.send(JSON.stringify({ t: "ack", cid: m.cid, m: { id: -now, a: uid, b: to, body, kind, ts: now, status: 0, reply } }));
          return;
        }
        const ck = pairKey(uid, to), t = this.ttlOf(ck);
        const status = this.online(to) ? 1 : 0;
        this.sql.exec("INSERT INTO messages(a,b,body,kind,ts,status,reply,fwd,expires) VALUES(?,?,?,?,?,?,?,?,?)", uid, to, body, kind, now, status, reply, m.fwd ? 1 : 0, t ? now + t * 1000 : null);
        const msg = this.one("SELECT * FROM messages WHERE id=last_insert_rowid()");
        ws.send(JSON.stringify({ t: "ack", cid: m.cid, m: msg }));
        this.sendTo(uid, { t: "msg", m: msg }, ws);
        this.sendTo(to, { t: "msg", m: msg, user: this.pub(this.user(uid)), muted: !!this.prefsOf(to, ck).muted });
        break;
      }
      case "read": {
        if (gid) {
          if (!this.isMember(gid, uid)) return;
          const mx = this.one("SELECT IFNULL(MAX(id),0) AS x FROM messages WHERE gid=?", gid).x;
          this.sql.exec("UPDATE gmembers SET last_read=? WHERE gid=? AND uid=?", mx, gid, uid);
          return;
        }
        if (!to) return;
        this.sql.exec("UPDATE messages SET status=2 WHERE gid IS NULL AND a=? AND b=? AND status<2", to, uid);
        const me = this.user(uid);
        if (me && me.receipts !== 0 && !this.blocked(uid, to)) this.sendTo(to, { t: "status", with: uid, status: 2 });
        break;
      }
      case "delete": {
        const msg = this.one("SELECT * FROM messages WHERE id=? AND a=?", Number(m.id), uid);
        if (!msg) return;
        this.sql.exec("UPDATE messages SET deleted=1, body='' WHERE id=?", msg.id);
        this.sql.exec("DELETE FROM reactions WHERE mid=?", msg.id);
        for (const u of this.audience(msg)) this.sendTo(u, { t: "deleted", id: msg.id, a: msg.a, b: msg.b, gid: msg.gid });
        break;
      }
      case "edit": {
        const msg = this.one("SELECT * FROM messages WHERE id=? AND a=? AND deleted=0 AND kind IN ('text','link')", Number(m.id), uid);
        if (!msg || Date.now() - msg.ts > 2 * DAY) return;
        const body = String(m.body || "").slice(0, 64000);
        if (!body) return;
        this.sql.exec("UPDATE messages SET body=?, edited=1, kind=? WHERE id=?", body, m.kind === "link" ? "link" : "text", msg.id);
        const nm = this.shape(this.one("SELECT * FROM messages WHERE id=?", msg.id), uid);
        for (const u of this.audience(nm)) this.sendTo(u, { t: "edited", m: nm });
        break;
      }
      case "react": {
        const msg = this.one("SELECT * FROM messages WHERE id=? AND deleted=0", Number(m.id));
        if (!msg) return;
        const aud = this.audience(msg);
        if (!aud.includes(uid)) return;
        const e = typeof m.e === "string" ? [...m.e].slice(0, 2).join("") : "";
        if (e) this.sql.exec("INSERT OR REPLACE INTO reactions VALUES(?,?,?)", msg.id, uid, e);
        else this.sql.exec("DELETE FROM reactions WHERE mid=? AND uid=?", msg.id, uid);
        for (const u of aud) this.sendTo(u, { t: "react", id: msg.id, uid, e, gid: msg.gid, a: msg.a, b: msg.b });
        break;
      }
      case "typing":
        if (gid) { if (this.isMember(gid, uid)) for (const x of this.members(gid)) if (x.uid !== uid) this.sendTo(x.uid, { t: "typing", from: uid, gid, rec: !!m.rec }); }
        else if (to && !this.blocked(to, uid)) this.sendTo(to, { t: "typing", from: uid, rec: !!m.rec });
        break;
      case "signal": {
        if (!to || !m.data || typeof m.data.kind !== "string") return;
        const kind = m.data.kind;
        if (kind === "offer") {
          if (!this.online(to) || this.blocked(to, uid) || this.blocked(uid, to)) {
            ws.send(JSON.stringify({ t: "signal", from: to, data: { kind: "unavailable", callId: m.data.callId } }));
            return;
          }
          this.sql.exec("INSERT OR REPLACE INTO pending_calls VALUES(?,?,?,?)", to, uid, JSON.stringify(m.data), Date.now());
        } else if (["answer", "end", "reject", "busy"].includes(kind)) {
          this.sql.exec("DELETE FROM pending_calls WHERE (callee=? AND caller=?) OR (callee=? AND caller=?)", to, uid, uid, to);
        }
        this.sendTo(to, { t: "signal", from: uid, user: this.pub(this.user(uid)), data: m.data });
        if (["answer", "reject"].includes(kind)) this.sendTo(uid, { t: "signal", from: to, data: { kind: "handled", callId: m.data.callId } }, ws);
        break;
      }
      // ---------- المكالمات الجماعية (شبكة مباشرة بين المشاركين) ----------
      case "gsignal": {
        if (!gid || !to || !this.isMember(gid, uid) || !this.isMember(gid, to) || !m.data) return;
        this.sendTo(to, { t: "gsignal", from: uid, gid, data: m.data });
        break;
      }
      case "gcall": {
        if (!gid || !this.isMember(gid, uid)) return;
        const peers = () => this.all("SELECT uid FROM gcalls WHERE gid=?", gid).map((x) => x.uid);
        if (m.a === "join") {
          const cur = peers().filter((p) => p !== uid);
          if (cur.length >= MAX_GCALL) { ws.send(JSON.stringify({ t: "gcall", a: "full", gid })); return; }
          this.sql.exec("INSERT OR REPLACE INTO gcalls VALUES(?,?,?,?)", gid, uid, m.video ? 1 : 0, Date.now());
          ws.serializeAttachment({ uid, gcall: gid });
          ws.send(JSON.stringify({ t: "gcall", a: "joined", gid, peers: cur }));
          for (const p of cur) this.sendTo(p, { t: "gcall", a: "peer-joined", gid, uid, user: this.pub(this.user(uid)) });
          if (!cur.length) {
            const g = this.one("SELECT name FROM groups WHERE id=?", gid);
            const caller = this.pub(this.user(uid));
            for (const x of this.members(gid)) if (x.uid !== uid) this.sendTo(x.uid, { t: "gcall", a: "ring", gid, from: uid, user: caller, video: !!m.video, group: { id: gid, name: g ? g.name : "" }, muted: !!this.prefsOf(x.uid, "g" + gid).muted });
            this.sysMsg(gid, uid, 0, `📞 ${caller.name} بدأ مكالمة ${m.video ? "فيديو" : "صوتية"} جماعية`);
          }
          for (const x of this.members(gid)) this.sendTo(x.uid, { t: "gcall", a: "state", gid, peers: peers() });
        } else if (m.a === "leave") {
          this.sql.exec("DELETE FROM gcalls WHERE gid=? AND uid=?", gid, uid);
          ws.serializeAttachment({ uid });
          const left = peers();
          for (const p of left) this.sendTo(p, { t: "gcall", a: "peer-left", gid, uid });
          for (const x of this.members(gid)) this.sendTo(x.uid, { t: "gcall", a: "state", gid, peers: left });
        }
        break;
      }
    }
  }

  async webSocketClose(ws) { this.left(ws); }
  async webSocketError(ws) { this.left(ws); }
  leaveGcall(gid, uid) {
    this.sql.exec("DELETE FROM gcalls WHERE gid=? AND uid=?", gid, uid);
    const left = this.all("SELECT uid FROM gcalls WHERE gid=?", gid).map((x) => x.uid);
    for (const p of left) this.sendTo(p, { t: "gcall", a: "peer-left", gid, uid });
    for (const x of this.members(gid)) this.sendTo(x.uid, { t: "gcall", a: "state", gid, peers: left });
  }
  left(ws) {
    const { uid, gcall } = ws.deserializeAttachment() || {};
    if (!uid) return;
    try { ws.close(); } catch {}
    if (gcall) this.leaveGcall(gcall, uid);
    const still = this.ctx.getWebSockets(String(uid)).filter((o) => o !== ws && o.readyState === 1).length;
    if (!still) {
      this.sql.exec("UPDATE users SET last_seen=? WHERE id=?", Date.now(), uid);
      this.presence(uid, false);
      for (const c of this.all("SELECT gid FROM gcalls WHERE uid=?", uid)) this.leaveGcall(c.gid, uid);
    }
  }
}
