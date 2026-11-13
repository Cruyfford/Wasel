"use strict";
const $ = (id) => document.getElementById(id);
const API = location.origin;
const S = {
  token: localStorage.getItem("w_token"),
  me: JSON.parse(localStorage.getItem("w_me") || "null"),
  users: {}, chats: [], msgs: {}, peer: null, ws: null, wsOk: false, retry: 0,
  calls: JSON.parse(localStorage.getItem("w_calls") || "[]"),
};
const SET = Object.assign(
  { wall: "glow", dim: 25, fs: "15.5px", enter: false, lock: null, bio: false, after: 0, secure: false, msgN: true, callN: true, sound: true },
  JSON.parse(localStorage.getItem("w_set") || "{}"));
const saveSet = () => { localStorage.setItem("w_set", JSON.stringify(SET)); applySet(); native({ type: "prefs", msgN: SET.msgN, callN: SET.callN, secure: SET.secure }); };
const COLORS = ["linear-gradient(135deg,#ff6a88,#ff99ac)","linear-gradient(135deg,#43e97b,#38f9d7)","linear-gradient(135deg,#f6d365,#fda085)","linear-gradient(135deg,#4facfe,#00f2fe)","linear-gradient(135deg,#a18cd1,#fbc2eb)","linear-gradient(135deg,#fa709a,#fee140)","linear-gradient(135deg,#30cfd0,#7b5cff)","linear-gradient(135deg,#ff9a44,#fc6076)"];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeImg = (u) => (typeof u === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(u) ? u : null);
function avatar(el, u, dot) {
  const img = safeImg(u?.avatar);
  el.style.background = img ? `center/cover no-repeat url("${img}")` : COLORS[(u?.id || 0) % COLORS.length];
  el.innerHTML = (img ? "" : esc((u?.name || "?").trim().charAt(0).toUpperCase())) + (dot && u?.online ? '<i class="dot"></i>' : "");
}
function toast(t) { const d = document.createElement("div"); d.className = "toast"; d.textContent = t; document.body.append(d); setTimeout(() => d.remove(), 2800); }
const VIEWS = ["auth", "home", "chat", "settings", "profile", "privacy", "security", "chatset", "notifs", "game"];
function show(id) { for (const v of VIEWS) $(v).classList.toggle("hidden", v !== id); S.view = id; }
function go(id) { show(id); history.pushState({ v: id }, ""); }
const pad = (n) => String(n).padStart(2, "0");
const hm = (ts) => { const d = new Date(ts); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
function dayLabel(ts) {
  const d = new Date(ts), n = new Date(), y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === n.toDateString()) return "اليوم";
  if (d.toDateString() === y.toDateString()) return "أمس";
  return d.toLocaleDateString("ar", { day: "numeric", month: "long", year: "numeric" });
}
const shortTime = (ts) => { const d = new Date(ts); return d.toDateString() === new Date().toDateString() ? hm(ts) : dayLabel(ts) === "أمس" ? "أمس" : d.toLocaleDateString("ar", { day: "numeric", month: "numeric" }); };
const fmtDur = (s) => Math.floor(s / 60) + ":" + pad(Math.floor(s % 60));
const fmtSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
function lastSeen(u) {
  if (!u) return "";
  if (u.online) return "متصل الآن";
  if (!u.last_seen) return u.about || "";
  return "آخر ظهور " + (dayLabel(u.last_seen) === "اليوم" ? "اليوم " : dayLabel(u.last_seen) + " ") + hm(u.last_seen);
}

async function api(path, body) {
  const r = await fetch(API + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", authorization: "Bearer " + (S.token || "") },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && S.token && !path.includes("login")) { logout(true); throw new Error("انتهت الجلسة"); }
  if (!r.ok) throw new Error(d.error || "خطأ في الاتصال");
  return d;
}

// ---------- الجسر مع التطبيق (آيفون / أندرويد) ----------
const NAT = {
  ios: !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wasel),
  android: !!window.WaselNative,
};
NAT.any = NAT.ios || NAT.android;
NAT.bio = !!(window.WASEL_BIO || (NAT.android && window.WaselNative.hasBio && window.WaselNative.hasBio()));
function native(o) {
  try {
    if (NAT.ios) window.webkit.messageHandlers.wasel.postMessage(o);
    else if (NAT.android) window.WaselNative.post(JSON.stringify(o));
  } catch {}
}
const nativeWaiters = {};
window.waselNative = (ev) => { const f = nativeWaiters[ev.type]; if (f) { delete nativeWaiters[ev.type]; f(ev); } };
const nativeAsk = (o, type) => new Promise((res) => { nativeWaiters[type] = res; native(o); });

// ---------- التشفير من طرف لطرف ----------
const TE = new TextEncoder(), TD = new TextDecoder();
const b64 = (buf) => { const a = new Uint8Array(buf); let s = ""; for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.subarray(i, i + 8192)); return btoa(s); };
const ub64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const EC = { name: "ECDH", namedCurve: "P-256" };
const pwKey = (pass) => crypto.subtle.importKey("raw", TE.encode(pass), "PBKDF2", false, ["deriveBits", "deriveKey"]);
async function authKey(email, pass) {
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: TE.encode("wasel-auth:" + email.trim().toLowerCase()), iterations: 200000 }, await pwKey(pass), 256);
  return b64(bits);
}
async function wrapKey(pass, salt) {
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 200000 }, await pwKey(pass), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function makeBackup(pass, privB64) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await wrapKey(pass, salt), ub64(privB64));
  return b64(salt) + "." + b64(iv) + "." + b64(ct);
}
async function newIdentity(pass) {
  const kp = await crypto.subtle.generateKey(EC, true, ["deriveKey"]);
  const pub = b64(await crypto.subtle.exportKey("raw", kp.publicKey));
  const priv = b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  return { pub, priv, backup: await makeBackup(pass, priv) };
}
async function openBackup(pass, backup) {
  const [salt, iv, ct] = backup.split(".").map(ub64);
  return b64(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await wrapKey(pass, salt), ct));
}
let PRIV = null; const SK = {}; const PT = new Map();
const myPriv = () => (PRIV ||= crypto.subtle.importKey("pkcs8", ub64(localStorage.getItem("w_priv")), EC, false, ["deriveKey"]));
async function sharedKey(uid) {
  let u = S.users[uid];
  if (!u || !u.pub) { try { u = S.users[uid] = { ...u, ...(await api("/api/user?id=" + uid)).user }; } catch {} }
  if (!u || !u.pub) throw new Error("nokey");
  const id = uid + ":" + u.pub;
  return (SK[id] ||= (async () => {
    const pk = await crypto.subtle.importKey("raw", ub64(u.pub), EC, false, []);
    return crypto.subtle.deriveKey({ name: "ECDH", public: pk }, await myPriv(), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  })());
}
async function enc(uid, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = "e1:" + b64(iv) + ":" + b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sharedKey(uid), TE.encode(text)));
  PT.set(out, text);
  return out;
}
async function dec(uid, body) {
  if (!body || !body.startsWith("e1:")) return body;
  if (PT.has(body)) return PT.get(body);
  try {
    const [, iv, ct] = body.split(":");
    const t = TD.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(iv) }, await sharedKey(uid), ub64(ct)));
    PT.set(body, t); return t;
  } catch { return "🔒 تعذّر فك التشفير"; }
}
const txt = (m) => m.text ?? (PT.has(m.body) ? PT.get(m.body) : m.body && m.body.startsWith("e1:") ? "🔒 …" : m.body);
const meta = (m) => { if (m.meta) return m.meta; try { return (m.meta = JSON.parse(txt(m))); } catch { return null; } };
const decAll = (peer, list) => Promise.all(list.map((m) => dec(peer, m.body)));
async function safetyNumber(uid) {
  const keys = [S.me.pub, S.users[uid].pub].sort();
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", TE.encode(keys.join("|"))));
  const g = [];
  for (let i = 0; i < 12; i++) g.push(String(((h[i * 2] << 8) | h[i * 2 + 1]) % 100000).padStart(5, "0"));
  return g;
}
function preview(m) {
  if (!m) return "";
  if (m.deleted) return "🚫 تم حذف الرسالة";
  if (m.kind === "file") { const x = meta(m); if (!x) return "📎 ملف"; return x.mime?.startsWith("image/") ? "📷 صورة" : x.mime?.startsWith("video/") ? "🎥 فيديو" : "📄 " + x.name; }
  if (m.kind === "voice") return "🎤 رسالة صوتية";
  if (m.kind === "game") return "🎴 دعوة للعب ألوان";
  return (m.kind === "call" ? "📞 " : "") + txt(m);
}

// ---------- الإعدادات المطبّقة ----------
const WALLS = {
  glow: { n: "افتراضي", css: "transparent" },
  night: { n: "ليل", css: "linear-gradient(160deg,#0f2027,#203a43,#2c5364)" },
  ocean: { n: "محيط", css: "linear-gradient(160deg,#1a1a2e,#16213e,#0f3460)" },
  forest: { n: "غابة", css: "linear-gradient(160deg,#0b3d2e,#06251c,#020d0a)" },
  plum: { n: "بنفسجي", css: "linear-gradient(160deg,#41295a,#2f0743)" },
  sunset: { n: "غروب", css: "linear-gradient(160deg,#ff7e5f,#a8336a,#2b1055)" },
  dots: { n: "نقاط", css: "#0b0e14 url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='26' height='26'%3E%3Ccircle cx='13' cy='13' r='1.6' fill='%23ffffff22'/%3E%3C/svg%3E\")" },
  black: { n: "أسود", css: "#000" },
  custom: { n: "صورتك", css: "" },
};
function wallCss(key) {
  if (key === "custom") { const img = localStorage.getItem("w_wall"); return img ? `center/cover no-repeat url("${img}")` : WALLS.glow.css; }
  return (WALLS[key] || WALLS.glow).css;
}
function applySet() {
  document.documentElement.style.setProperty("--fs", SET.fs);
  const bg = wallCss(SET.wall), dim = SET.dim / 100;
  const css = `linear-gradient(rgba(0,0,0,${dim}),rgba(0,0,0,${dim})),${bg}`;
  $("msgs").style.background = css;
  $("wPrev").style.background = css;
}

// ---------- قفل التطبيق ----------
async function pinHash(pin, salt) {
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: TE.encode(salt), iterations: 150000 }, await pwKey(pin), 256);
  return b64(bits);
}
let lockEntry = "", locked = false, hiddenAt = 0;
function buildPad() {
  $("lockPad").innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9, "", 0, "⌫"].map((k) => `<button ${k === "" ? 'style="visibility:hidden"' : ""} data-k="${k}">${k}</button>`).join("");
  $("lockPad").onclick = (e) => { const k = e.target.dataset?.k; if (k === undefined || k === "") return; lockKey(k); };
}
function lockDots() { $("lockDots").innerHTML = Array.from({ length: SET.lock?.len || 4 }, (_, i) => `<i class="${i < lockEntry.length ? "f" : ""}"></i>`).join(""); }
async function lockKey(k) {
  if (k === "⌫") lockEntry = lockEntry.slice(0, -1); else if (lockEntry.length < (SET.lock.len || 4)) lockEntry += k;
  lockDots();
  if (lockEntry.length === SET.lock.len) {
    if ((await pinHash(lockEntry, SET.lock.salt)) === SET.lock.hash) unlock();
    else { $("lock").classList.add("shake"); setTimeout(() => $("lock").classList.remove("shake"), 450); lockEntry = ""; lockDots(); $("lockMsg").textContent = "رمز خاطئ"; }
  }
}
function lockNow() {
  if (!SET.lock || locked || C) return;
  locked = true; lockEntry = ""; lockDots(); $("lockMsg").textContent = "أدخل الرمز";
  $("lock").classList.remove("hidden");
  $("lockBio").classList.toggle("hidden", !(SET.bio && NAT.bio));
  if (SET.bio && NAT.bio) setTimeout(tryBio, 300);
}
async function tryBio() { const r = await nativeAsk({ type: "bio", reason: "افتح واصل" }, "bio"); if (r.ok) unlock(); }
function unlock() { locked = false; $("lock").classList.add("hidden"); }
$("lockBio").onclick = tryBio;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenAt = Date.now();
  else {
    if (SET.lock && hiddenAt && Date.now() - hiddenAt >= SET.after * 1000) lockNow();
    if (C && C.state === "incoming") ring("in");
    if (!S.wsOk && S.token) connect();
    if (S.peer && S.view === "chat") wsSend({ t: "read", to: S.peer.id });
  }
});

// ---------- الدخول ----------
let regMode = false;
$("aSwitch").onclick = () => {
  regMode = !regMode;
  $("aName").classList.toggle("hidden", !regMode);
  $("aGo").textContent = regMode ? "إنشاء حساب" : "دخول";
  $("aSwitch").textContent = regMode ? "لديك حساب؟ سجّل الدخول" : "ليس لديك حساب؟ أنشئ حساباً";
  $("authSub").textContent = regMode ? "أنشئ حساباً جديداً" : "سجّل الدخول بالبريد الإلكتروني";
  $("aErr").textContent = "";
};
$("aGo").onclick = async () => {
  $("aErr").textContent = ""; $("aGo").disabled = true;
  try {
    const email = $("aEmail").value.trim(), pass = $("aPass").value;
    if (pass.length < 6) throw new Error("كلمة المرور يجب أن تكون 6 أحرف على الأقل");
    $("aErr").textContent = "🔐 جارٍ تجهيز مفاتيح التشفير…";
    const ak = await authKey(email, pass);
    let d, priv;
    if (regMode) {
      const id = await newIdentity(pass);
      d = await api("/api/register", { email, password: ak, name: $("aName").value, pub: id.pub, backup: id.backup });
      priv = id.priv;
    } else {
      try { d = await api("/api/login", { email, password: ak }); }
      catch (e) {
        if (/دقيقة/.test(e.message)) throw e;
        d = await api("/api/login", { email, password: pass }).catch(() => { throw e; });
        S.token = d.token; await api("/api/upgrade", { password: ak });
      }
      S.token = d.token;
      if (d.backup) priv = await openBackup(pass, d.backup);
      else {
        const id = await newIdentity(pass);
        d.user = (await api("/api/keys", { pub: id.pub, backup: id.backup })).user; priv = id.priv;
      }
    }
    localStorage.setItem("w_priv", priv); PRIV = null;
    $("aErr").textContent = "";
    S.token = d.token; S.me = d.user;
    localStorage.setItem("w_token", d.token); localStorage.setItem("w_me", JSON.stringify(d.user));
    $("aPass").value = "";
    start();
  } catch (e) { $("aErr").textContent = e.message; }
  $("aGo").disabled = false;
};
$("aPass").onkeydown = (e) => { if (e.key === "Enter") $("aGo").click(); };

function logout(silent) {
  if (S.token && !silent) fetch(API + "/api/logout", { method: "POST", headers: { authorization: "Bearer " + S.token } }).catch(() => {});
  native({ type: "logout" });
  const keep = localStorage.getItem("w_set"), wall = localStorage.getItem("w_wall");
  localStorage.clear();
  if (keep) { const s = JSON.parse(keep); delete s.lock; s.bio = false; localStorage.setItem("w_set", JSON.stringify(s)); SET.lock = null; SET.bio = false; }
  if (wall) localStorage.setItem("w_wall", wall);
  PRIV = null; PT.clear(); S.token = null; S.me = null; S.msgs = {}; S.chats = []; S.calls = [];
  try { S.ws && S.ws.close(); } catch {}
  show("auth");
}

// ---------- الاتصال اللحظي ----------
function connect() {
  if (!S.token || (S.ws && S.ws.readyState <= 1)) return;
  const ws = new WebSocket(API.replace(/^http/, "ws") + "/ws?token=" + encodeURIComponent(S.token));
  S.ws = ws;
  ws.onopen = () => { S.wsOk = true; S.retry = 0; $("connBar").classList.add("hidden"); loadChats(); if (S.peer && S.view === "chat") openChat(S.peer.id, true); flushQueue(); };
  ws.onclose = (e) => {
    S.wsOk = false; if (!S.token) return;
    if (e.code === 4001) { logout(true); toast("تم تسجيل خروجك من هذا الجهاز"); return; }
    $("connBar").classList.remove("hidden");
    setTimeout(connect, Math.min(10000, 800 * 2 ** S.retry++));
  };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); S.inq = (S.inq || Promise.resolve()).then(() => onWs(m)).catch(() => {}); };
}
setInterval(() => { if (S.wsOk) S.ws.send('{"t":"ping"}'); }, 25000);
function wsSend(o) { if (S.wsOk) { S.ws.send(JSON.stringify(o)); return true; } return false; }

async function onWs(m) {
  if (m.t === "msg") {
    const msg = m.m, peer = msg.a === S.me.id ? msg.b : msg.a;
    if (m.user) S.users[m.user.id] = { ...S.users[m.user.id], ...m.user };
    await dec(peer, msg.body);
    pushMsg(peer, msg);
    const open = S.peer && S.peer.id === peer && !document.hidden && S.view === "chat";
    if (open) wsSend({ t: "read", to: peer }); else if (msg.a !== S.me.id && SET.sound && !document.hidden) beep();
    bumpChat(peer, msg, msg.a !== S.me.id);
  } else if (m.t === "ack") {
    const peer = m.m.b, list = S.msgs[peer] || [];
    const i = list.findIndex((x) => x.cid === m.cid);
    if (i >= 0) { const old = list[i]; list[i] = Object.assign(m.m, { meta: old.meta, local: old.local }); } else list.push(m.m);
    S.queue = (S.queue || []).filter((q) => q.cid !== m.cid);
    if (S.peer && S.peer.id === peer) renderMsgs();
    bumpChat(peer, m.m, false);
  } else if (m.t === "status") {
    for (const x of S.msgs[m.with] || []) if (x.a === S.me.id && x.status < m.status && x.id) x.status = m.status;
    const c = S.chats.find((c) => c.user.id === m.with); if (c && c.last.a === S.me.id) c.last.status = Math.max(c.last.status, m.status);
    if (S.peer && S.peer.id === m.with) renderMsgs();
    renderChats();
  } else if (m.t === "deleted") {
    const peer = m.a === S.me.id ? m.b : m.a;
    for (const x of S.msgs[peer] || []) if (x.id === m.id) { x.deleted = 1; x.body = ""; x.meta = null; }
    const c = S.chats.find((c) => c.user.id === peer); if (c && c.last.id === m.id) c.last.deleted = 1;
    if (S.peer && S.peer.id === peer) renderMsgs();
    renderChats();
  } else if (m.t === "presence") {
    const u = S.users[m.id]; if (u) { u.online = m.online; u.last_seen = m.last_seen; }
    if (S.peer && S.peer.id === m.id) $("cStatus").textContent = lastSeen(u);
    renderChats();
  } else if (m.t === "profile") {
    S.users[m.user.id] = { ...S.users[m.user.id], ...m.user };
    renderChats();
    if (S.peer && S.peer.id === m.user.id) { avatar($("cAv"), m.user); $("cName").textContent = m.user.name; }
  } else if (m.t === "typing") {
    if (S.peer && S.peer.id === m.from) {
      $("cStatus").textContent = m.rec ? "يسجّل صوتاً… 🎤" : "يكتب…";
      clearTimeout(S.typT); S.typT = setTimeout(() => ($("cStatus").textContent = lastSeen(S.users[m.from])), 3000);
    }
  } else if (m.t === "signal") {
    if (m.user) S.users[m.user.id] = { ...S.users[m.user.id], ...m.user };
    onSignal(m.from, m.data);
  }
}

// ---------- الدردشات ----------
async function loadChats() {
  try {
    const d = await api("/api/chats");
    for (const c of d.chats) S.users[c.user.id] = { ...S.users[c.user.id], ...c.user };
    await Promise.all(d.chats.map((c) => dec(c.user.id, c.last.body)));
    S.chats = d.chats;
    renderChats();
  } catch {}
}
function bumpChat(peer, msg, incoming) {
  let c = S.chats.find((c) => c.user.id === peer);
  if (!c) { c = { user: S.users[peer] || { id: peer, name: "…" }, last: msg, unread: 0 }; S.chats.unshift(c); if (!S.users[peer]) fetchUser(peer); }
  c.last = msg;
  if (incoming && !(S.peer && S.peer.id === peer && S.view === "chat")) c.unread++;
  S.chats.sort((a, b) => (b.last.ts || 0) - (a.last.ts || 0));
  renderChats();
}
async function fetchUser(id) { try { const d = await api("/api/user?id=" + id); S.users[id] = d.user; renderChats(); } catch {} }
function ticks(m) {
  if (m.a !== S.me.id || m.deleted) return "";
  if (!m.id) return '<span class="tick">🕓</span>';
  return m.status >= 2 ? '<span class="tick r">✓✓</span>' : m.status === 1 ? '<span class="tick">✓✓</span>' : '<span class="tick">✓</span>';
}
function renderChats() {
  const el = $("chatList"), q = $("hSearch").value.trim().toLowerCase();
  const list = S.chats.filter((c) => { if (!q) return true; const u = S.users[c.user.id] || c.user; return (u.name || "").toLowerCase().includes(q) || preview(c.last).toLowerCase().includes(q); });
  if (!list.length) { el.innerHTML = `<div class="empty">${q ? "لا توجد نتائج" : "لا توجد دردشات بعد.<br>اضغط + وابدأ دردشة ببريد صديقك."}</div>`; return; }
  el.innerHTML = ""; let i = 0;
  for (const c of list) {
    const u = S.users[c.user.id] || c.user;
    const r = document.createElement("div"); r.className = "row";
    if (!el.dataset.shown) r.style.animationDelay = Math.min(i++, 12) * 30 + "ms"; else r.style.animation = "none";
    r.innerHTML = `<div class="av"></div><div class="mid"><div class="top"><span class="nm">${esc(u.name)}</span><span class="tm ${c.unread ? "u" : ""}">${shortTime(c.last.ts)}</span></div>
      <div class="sub"><span class="pv">${ticks(c.last)} ${esc(preview(c.last))}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ""}</div></div>`;
    avatar(r.querySelector(".av"), u, true);
    r.onclick = () => openChat(u.id);
    el.append(r);
  }
  el.dataset.shown = 1;
}
$("hSearch").oninput = renderChats;
function pushMsg(peer, msg) {
  const list = (S.msgs[peer] ||= []);
  if (msg.id && list.some((x) => x.id === msg.id)) return;
  list.push(msg);
  if (S.peer && S.peer.id === peer) renderMsgs(true);
}

async function openChat(id, refresh) {
  const u = S.users[id] || { id, name: "…" };
  S.peer = u;
  if (!refresh) {
    avatar($("cAv"), u); $("cName").textContent = u.name; $("cStatus").textContent = lastSeen(u);
    setReply(null); go("chat"); renderMsgs(true);
  }
  try {
    const [d, ud] = await Promise.all([api("/api/messages?with=" + id), api("/api/user?id=" + id)]);
    S.users[id] = ud.user; S.peer = ud.user;
    await decAll(id, d.messages);
    const pending = (S.msgs[id] || []).filter((m) => !m.id);
    S.msgs[id] = d.messages.concat(pending);
    avatar($("cAv"), ud.user); $("cName").textContent = ud.user.name; $("cStatus").textContent = lastSeen(ud.user);
    renderMsgs(true);
  } catch {}
  wsSend({ t: "read", to: id });
  const c = S.chats.find((c) => c.user.id === id); if (c) { c.unread = 0; renderChats(); }
}

function bubbleBody(m) {
  if (m.deleted) return "🚫 تم حذف هذه الرسالة";
  const x = m.kind === "file" || m.kind === "voice" || m.kind === "game" ? meta(m) : null;
  const prog = m.prog !== undefined ? `<div class="prog">${m.prog}%</div>` : "";
  if (m.kind === "voice" && x) {
    return `<div class="mvoice" data-fid="${esc(x.fid)}"><button class="vp">▶</button><div class="vbar"><i></i></div><span>${fmtDur(x.dur || 0)}</span></div>${prog}`;
  }
  if (m.kind === "game" && x) {
    return `<div class="gameinv"><div class="gt"><span style="font-size:30px">🎴</span><span>دعوة للعب ألوان<br><small style="font-weight:400;opacity:.8" dir="ltr">${esc(x.code)}</small></span></div><button class="btn" data-join="${esc(x.code)}">انضم للعبة</button></div>`;
  }
  if (m.kind === "file" && x) {
    const url = FILES.get(x.fid)?.url || m.local;
    if (x.mime?.startsWith("image/"))
      return `<div style="position:relative"><img class="mimg" data-fid="${esc(x.fid)}" src="${esc(url || safeImg(x.thumb) || "")}">${prog}</div>`;
    if (x.mime?.startsWith("video/"))
      return `<div class="mvid" data-fid="${esc(x.fid)}" style="position:relative"><img class="mthumb" src="${esc(safeImg(x.thumb) || "")}"><span class="play">▶</span>${prog}</div>`;
    return `<div class="mfile" data-fid="${esc(x.fid)}" style="position:relative"><span class="fi">📄</span><span><b>${esc(x.name)}</b><small>${fmtSize(x.size)}</small></span>${prog}</div>`;
  }
  return (m.kind === "call" ? "📞 " : "") + esc(txt(m));
}
function renderMsgs(scroll) {
  if (!S.peer) return;
  const box = $("msgs"), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const list = S.msgs[S.peer.id] || [];
  let html = '<div class="e2e" id="e2eNote">🔒 الرسائل والمكالمات والملفات مشفّرة من طرف لطرف. لا أحد غيركما يقدر يقرأها أو يسمعها، ولا حتى السيرفر. اضغط للتحقق.</div>';
  let lastDay = "", idx = 0;
  const prev = (S.rc ||= {})[S.peer.id] ?? list.length;
  const byId = {}; for (const m of list) if (m.id) byId[m.id] = m;
  for (const m of list) {
    const dl = dayLabel(m.ts);
    if (dl !== lastDay) { html += `<div class="day clr"><span>${dl}</span></div>`; lastDay = dl; }
    const mine = m.a === S.me.id, media = !m.deleted && (m.kind === "file" || m.kind === "voice");
    let rq = "";
    if (m.reply && byId[m.reply]) { const r = byId[m.reply]; rq = `<span class="rq"><b>${r.a === S.me.id ? "أنت" : esc(S.peer.name)}</b>${esc(preview(r)).slice(0, 90)}</span>`; }
    html += `<div class="b ${idx++ >= prev ? "a " : ""}${mine ? "o" : "i"}${m.kind === "call" ? " call" : ""}${m.deleted ? " del" : ""}${media ? " media" : ""}" data-i="${idx - 1}">${rq}${bubbleBody(m)}<span class="meta">${hm(m.ts)}${ticks(m)}</span></div>`;
  }
  S.rc[S.peer.id] = list.length;
  box.innerHTML = html + '<div class="clr"></div>';
  if (scroll || atBottom) box.scrollTop = box.scrollHeight;
  // تحميل الصور تلقائياً
  for (const img of box.querySelectorAll("img.mimg")) {
    const fid = img.dataset.fid;
    if (FILES.get(fid)?.url) continue;
    const m = list.find((x) => meta(x)?.fid === fid);
    if (m && m.id) loadFile(meta(m)).then((f) => { for (const el of document.querySelectorAll(`img.mimg[data-fid="${CSS.escape(fid)}"]`)) el.src = f.url; }).catch(() => {});
  }
}

// تفاعل مع الفقاعات: ضغط مطوّل = خيارات، ضغط = فتح الوسائط
(function bubbleEvents() {
  const box = $("msgs");
  let t = null, startY = 0;
  const msgOf = (el) => { const b = el.closest(".b"); return b ? (S.msgs[S.peer.id] || [])[Number(b.dataset.i)] : null; };
  box.addEventListener("pointerdown", (e) => {
    const m = msgOf(e.target); if (!m) return; startY = e.clientY;
    t = setTimeout(() => { t = null; msgActions(m); if (navigator.vibrate) navigator.vibrate(15); }, 450);
  });
  const cancel = () => { clearTimeout(t); t = null; };
  box.addEventListener("pointerup", cancel); box.addEventListener("pointercancel", cancel);
  box.addEventListener("pointermove", (e) => { if (Math.abs(e.clientY - startY) > 8) cancel(); });
  box.addEventListener("contextmenu", (e) => { const m = msgOf(e.target); if (m) { e.preventDefault(); msgActions(m); } });
  box.addEventListener("click", async (e) => {
    if (e.target.closest("#e2eNote")) return showInfo();
    const j = e.target.closest("[data-join]"); if (j) return joinGame(j.dataset.join);
    const m = msgOf(e.target); if (!m || m.deleted) return;
    const x = meta(m); if (!x || !m.id) return;
    if (e.target.closest(".vp")) return playVoice(e.target.closest(".mvoice"), x);
    if (e.target.closest(".mimg,.mvid")) return openViewer(x);
    if (e.target.closest(".mfile")) { toast("⏬ جارٍ التحميل…"); try { saveFile(await loadFile(x), x); } catch { toast("تعذّر تحميل الملف"); } }
  });
})();

function msgActions(m) {
  if (m.deleted || !m.id) return;
  const mine = m.a === S.me.id;
  const items = [["↩️", "رد", () => setReply(m)]];
  if (m.kind === "text") items.push(["📋", "نسخ", () => { navigator.clipboard?.writeText(txt(m)).then(() => toast("تم النسخ")).catch(() => toast("تعذّر النسخ")); }]);
  if (m.kind === "file") items.push(["⬇️", "حفظ", async () => { try { saveFile(await loadFile(meta(m)), meta(m)); } catch { toast("تعذّر التحميل"); } }]);
  if (mine) items.push(["🗑️", "حذف عند الجميع", () => wsSend({ t: "delete", id: m.id }), "dz"]);
  $("acts").innerHTML = items.map((it, i) => `<button data-a="${i}" class="${it[3] || ""}"><span class="em">${it[0]}</span>${it[1]}</button>`).join("");
  $("acts").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; closeSheets(); items[Number(b.dataset.a)][2](); };
  openSheet("actSheet");
}
function setReply(m) {
  S.reply = m || null;
  $("replyBar").classList.toggle("hidden", !m);
  if (m) { $("rbName").textContent = m.a === S.me.id ? "أنت" : S.peer.name; $("rbText").textContent = preview(m); $("cInput").focus(); }
}
$("rbX").onclick = () => setReply(null);

// ---------- الإرسال ----------
function updateSendBtn() {
  const has = $("cInput").value.trim().length > 0 || REC.on;
  $("cSend").innerHTML = `<svg><use href="#i-${has ? "send" : "mic"}"/></svg>`;
}
async function send(text, kind, extra = {}) {
  if (!S.peer || !text.trim()) return;
  const peer = S.peer.id, cid = Math.random().toString(36).slice(2);
  const reply = S.reply?.id || null; setReply(null);
  const m = { cid, a: S.me.id, b: peer, body: "", text, kind: kind || "text", ts: Date.now(), status: 0, reply, ...extra };
  pushMsg(peer, m); renderMsgs(true);
  let body;
  try { body = await enc(peer, text); }
  catch { toast("هذا المستخدم يحتاج تحديث التطبيق لاستقبال الرسائل المشفّرة"); S.msgs[peer] = S.msgs[peer].filter((x) => x !== m); renderMsgs(); return; }
  const q = { t: "send", to: peer, body, kind, cid, reply };
  (S.queue ||= []).push(q);
  wsSend(q);
  return m;
}
async function sendTo(peer, text, kind) {
  try { wsSend({ t: "send", to: peer, body: await enc(peer, text), kind, cid: Math.random().toString(36).slice(2) }); } catch {}
}
function flushQueue() { for (const q of S.queue || []) wsSend(q); }

const inp = $("cInput");
inp.oninput = () => {
  inp.style.height = "auto"; inp.style.height = Math.min(120, inp.scrollHeight) + "px";
  updateSendBtn();
  const now = Date.now(); if (now - (S.lastTyp || 0) > 2000) { S.lastTyp = now; wsSend({ t: "typing", to: S.peer.id }); }
};
inp.onkeydown = (e) => { if (SET.enter && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("cSend").click(); } };
$("cSend").onclick = () => {
  if (REC.on) return stopRec(true);
  const v = inp.value;
  if (!v.trim()) return startRec();
  inp.value = ""; inp.style.height = "auto"; updateSendBtn(); send(v); inp.focus();
};
$("cBack").onclick = () => history.back();
for (const b of document.querySelectorAll("[data-back]")) b.onclick = () => history.back();
window.onpopstate = () => {
  if (!$("call").classList.contains("hidden")) return;
  if (!$("viewer").classList.contains("hidden")) { closeViewer(); return; }
  if (S.view === "game") leaveGameView();
  const v = history.state?.v || "home";
  if (v === "chat" && S.peer) show("chat");
  else if (VIEWS.includes(v) && v !== "auth" && v !== "chat") { show(v); if (v === "settings") renderSettings(); }
  else { S.peer = null; show("home"); renderChats(); }
};

// ---------- الملفات (مشفّرة) ----------
const FILES = new Map();
const CHUNK = 1000000;
const randHexJS = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, "0")).join("");
async function makeThumb(file) {
  try {
    const url = URL.createObjectURL(file);
    let src;
    if (file.type.startsWith("image/")) { src = new Image(); src.src = url; await src.decode(); }
    else if (file.type.startsWith("video/")) {
      src = document.createElement("video"); src.muted = true; src.playsInline = true; src.preload = "auto"; src.src = url;
      await new Promise((res, rej) => { src.onloadeddata = res; src.onerror = rej; setTimeout(res, 4000); });
      src.currentTime = Math.min(0.5, (src.duration || 1) / 2);
      await new Promise((res) => { src.onseeked = res; setTimeout(res, 2000); });
    } else return null;
    const w = src.naturalWidth || src.videoWidth, h = src.naturalHeight || src.videoHeight;
    if (!w || !h) return null;
    const sc = Math.min(1, 320 / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    return { thumb: c.toDataURL("image/jpeg", 0.6), w, h, dur: src.duration || 0 };
  } catch { return null; }
}
async function sendFile(file, kind = "file", extra = {}) {
  if (!S.peer) return;
  if (file.size > 58 * 1048576) return toast("الحد الأقصى للملف 58MB");
  const peer = S.peer.id;
  try { await sharedKey(peer); } catch { return toast("هذا المستخدم يحتاج تحديث التطبيق"); }
  const th = kind === "file" ? await makeThumb(file) : null;
  const fid = randHexJS(16);
  const key = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const x = { fid, k: b64(key), iv: b64(iv), name: file.name || "file", mime: file.type || "application/octet-stream", size: file.size, n: 0, ...(th || {}), ...extra };
  const local = URL.createObjectURL(file);
  FILES.set(fid, { url: local, blob: file });
  const cid = Math.random().toString(36).slice(2);
  const m = { cid, a: S.me.id, b: peer, body: "", kind, ts: Date.now(), status: 0, meta: x, local, prog: 0 };
  pushMsg(peer, m); renderMsgs(true);
  try {
    const ck = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ck, await file.arrayBuffer()));
    x.n = Math.ceil(ct.length / CHUNK);
    for (let i = 0; i < x.n; i++) {
      const r = await fetch(`${API}/api/upload?id=${fid}&i=${i}`, { method: "POST", headers: { authorization: "Bearer " + S.token }, body: ct.subarray(i * CHUNK, (i + 1) * CHUNK) });
      if (!r.ok) throw new Error("upload");
      m.prog = Math.round(((i + 1) / x.n) * 100);
      if (S.peer && S.peer.id === peer) { const el = document.querySelector(`.b[data-i="${S.msgs[peer].indexOf(m)}"] .prog`); if (el) el.textContent = m.prog + "%"; }
    }
    delete m.prog;
    const body = await enc(peer, JSON.stringify(x));
    const q = { t: "send", to: peer, body, kind, cid };
    (S.queue ||= []).push(q); wsSend(q);
    renderMsgs();
  } catch {
    S.msgs[peer] = S.msgs[peer].filter((y) => y !== m); renderMsgs();
    toast("فشل رفع الملف");
  }
}
async function loadFile(x) {
  const have = FILES.get(x.fid);
  if (have?.url) return have;
  if (have?.p) return have.p;
  const p = (async () => {
    const parts = [];
    for (let i = 0; i < x.n; i++) {
      const r = await fetch(`${API}/api/file?id=${x.fid}&i=${i}`);
      if (!r.ok) throw new Error("dl");
      parts.push(new Uint8Array(await r.arrayBuffer()));
    }
    const all = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
    let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    const ck = await crypto.subtle.importKey("raw", ub64(x.k), "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(x.iv) }, ck, all);
    const blob = new Blob([plain], { type: x.mime });
    const f = { blob, url: URL.createObjectURL(blob) };
    FILES.set(x.fid, f);
    return f;
  })();
  FILES.set(x.fid, { p });
  p.catch(() => FILES.delete(x.fid));
  return p;
}
async function saveFile(f, x) {
  if (NAT.any) {
    native({ type: "save", name: x.name || "file", mime: x.mime, data: b64(await f.blob.arrayBuffer()) });
    return;
  }
  const a = document.createElement("a"); a.href = f.url; a.download = x.name || "file"; a.click();
}
async function openViewer(x) {
  $("viewer").classList.remove("hidden");
  $("vBody").innerHTML = '<div style="color:#fff">⏳</div>';
  history.pushState({ v: S.view, viewer: 1 }, "");
  try {
    const f = await loadFile(x);
    $("vBody").innerHTML = x.mime.startsWith("video/") ? `<video src="${f.url}" controls autoplay playsinline></video>` : `<img src="${f.url}">`;
    $("vSave").onclick = () => saveFile(f, x);
  } catch { $("vBody").innerHTML = '<div style="color:#fff">تعذّر التحميل</div>'; }
}
function closeViewer() { $("viewer").classList.add("hidden"); $("vBody").innerHTML = ""; }
$("vX").onclick = () => history.back();

// المرفقات
$("cAttach").onclick = () => {
  const items = [["🖼️", "صور وفيديو", () => $("fMedia").click()], ["📸", "الكاميرا", () => $("fCam").click()], ["📄", "ملف", () => $("fAny").click()], ["🎴", "دعوة للعب ألوان", () => inviteToGame(S.peer.id)]];
  $("acts").innerHTML = items.map((it, i) => `<button data-a="${i}"><span class="em">${it[0]}</span>${it[1]}</button>`).join("");
  $("acts").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; closeSheets(); items[Number(b.dataset.a)][2](); };
  openSheet("actSheet");
};
for (const id of ["fMedia", "fAny", "fCam"]) $(id).onchange = async (e) => { const fs = [...e.target.files]; e.target.value = ""; for (const f of fs) await sendFile(f); };

// ---------- الرسائل الصوتية ----------
const REC = { on: false };
async function startRec() {
  if (!S.peer) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    Object.assign(REC, { on: true, rec, stream, chunks: [], t0: Date.now(), mime: rec.mimeType || mime || "audio/mp4" });
    rec.ondataavailable = (e) => e.data.size && REC.chunks.push(e.data);
    rec.start(250);
    $("cInput").classList.add("hidden"); $("cAttach").classList.add("hidden"); $("recBox").classList.remove("hidden");
    updateSendBtn();
    REC.timer = setInterval(() => { $("recT").textContent = fmtDur((Date.now() - REC.t0) / 1000); wsSend({ t: "typing", to: S.peer.id, rec: true }); }, 1000);
    $("recT").textContent = "0:00";
  } catch { toast("اسمح للتطبيق باستخدام المايك"); }
}
function stopRec(sendIt) {
  if (!REC.on) return;
  const { rec, stream, t0 } = REC;
  clearInterval(REC.timer);
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const dur = (Date.now() - t0) / 1000;
    if (sendIt && dur >= 0.8) {
      const blob = new Blob(REC.chunks, { type: REC.mime.split(";")[0] });
      const ext = blob.type.includes("webm") ? "webm" : "m4a";
      sendFile(new File([blob], `voice.${ext}`, { type: blob.type }), "voice", { dur });
    }
  };
  rec.stop();
  REC.on = false;
  $("cInput").classList.remove("hidden"); $("cAttach").classList.remove("hidden"); $("recBox").classList.add("hidden");
  updateSendBtn();
}
$("recX").onclick = () => stopRec(false);
let VA = null, VEL = null;
async function playVoice(el, x) {
  if (VA && VEL === el) { if (VA.paused) VA.play(); else VA.pause(); return; }
  if (VA) { VA.pause(); if (VEL) VEL.querySelector(".vp").textContent = "▶"; }
  el.querySelector(".vp").textContent = "⏳";
  try {
    const f = await loadFile(x);
    VA = new Audio(f.url); VEL = el;
    VA.onplay = () => (el.querySelector(".vp").textContent = "⏸");
    VA.onpause = () => (el.querySelector(".vp").textContent = "▶");
    VA.ontimeupdate = () => { const d = VA.duration && isFinite(VA.duration) ? VA.duration : x.dur || 1; el.querySelector(".vbar i").style.width = (VA.currentTime / d) * 100 + "%"; el.querySelector("span").textContent = fmtDur(VA.currentTime); };
    VA.onended = () => { el.querySelector(".vp").textContent = "▶"; el.querySelector(".vbar i").style.width = "0"; el.querySelector("span").textContent = fmtDur(x.dur || 0); VA = null; VEL = null; };
    await VA.play();
  } catch { el.querySelector(".vp").textContent = "▶"; toast("تعذّر تشغيل الرسالة الصوتية"); }
}

// ---------- الأوراق المنبثقة ----------
function openSheet(id) { $(id).classList.remove("hidden"); }
function closeSheets() { for (const s of document.querySelectorAll(".sheet")) s.classList.add("hidden"); }
for (const s of document.querySelectorAll(".sheet")) s.addEventListener("click", (e) => { if (e.target === s || e.target.closest("[data-close]")) { s.classList.add("hidden"); if (s.id === "askSheet" && S.askRes) { S.askRes(null); S.askRes = null; } } });
function ask(title, fields, ok) {
  $("askT").textContent = title; $("askE").textContent = ""; $("askOk").textContent = ok;
  $("askF").innerHTML = fields.map((f, i) => `<input class="field" data-i="${i}" type="${f.type || "text"}" placeholder="${esc(f.ph)}" ${f.type === "password" ? 'dir="ltr"' : ""} ${f.mode ? `inputmode="${f.mode}"` : ""} maxlength="${f.max || 100}">`).join("");
  openSheet("askSheet");
  setTimeout(() => $("askF").querySelector("input")?.focus(), 80);
  return new Promise((res) => {
    S.askRes = res;
    $("askOk").onclick = () => { const v = [...$("askF").querySelectorAll("input")].map((x) => x.value); $("askSheet").classList.add("hidden"); S.askRes = null; res(v); };
    $("askNo").onclick = () => { $("askSheet").classList.add("hidden"); S.askRes = null; res(null); };
  });
}

// معلومات جهة الاتصال + رقم الأمان
async function showInfo() {
  if (!S.peer) return;
  const u = S.users[S.peer.id] || S.peer;
  avatar($("iAv"), u); $("iName").textContent = u.name; $("iAbout").textContent = u.about || ""; $("iEmail").textContent = u.email || "";
  $("sNum").innerHTML = "…";
  openSheet("infoSheet");
  try { if (!u.pub) await sharedKey(u.id); $("sNum").innerHTML = (await safetyNumber(u.id)).map((g) => `<span>${g}</span>`).join(""); }
  catch { $("sNum").textContent = "هذا المستخدم لم يفعّل التشفير بعد"; }
}
$("cWho").onclick = showInfo; $("cAv").onclick = showInfo;
$("iCall").onclick = () => { closeSheets(); startCall(false); };
$("iVid").onclick = () => { closeSheets(); startCall(true); };

// دردشة جديدة
$("newChat").onclick = () => { openSheet("newSheet"); $("nErr").textContent = ""; $("nEmail").value = ""; setTimeout(() => $("nEmail").focus(), 50); };
$("nGo").onclick = async () => {
  try {
    const d = await api("/api/find?email=" + encodeURIComponent($("nEmail").value.trim()));
    if (d.user.id === S.me.id) throw new Error("هذا بريدك أنت");
    S.users[d.user.id] = d.user; closeSheets(); openChat(d.user.id);
  } catch (e) { $("nErr").textContent = e.message; }
};

// تبويبات
for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => {
  for (const x of document.querySelectorAll(".tabs button")) x.classList.toggle("on", x === b);
  const chats = b.dataset.tab === "chats";
  $("chatList").classList.toggle("hidden", !chats); $("callList").classList.toggle("hidden", chats);
  $("newChat").classList.toggle("hidden", !chats); document.querySelector(".search").classList.toggle("hidden", !chats);
  renderCalls();
};

// ---------- الإعدادات ----------
function sw(id, on) { $(id).querySelector(".sw").classList.toggle("on", !!on); }
function renderSettings() {
  avatar($("sAv"), S.me); $("sName").textContent = S.me.name; $("sAbout").textContent = S.me.about || S.me.email;
}
$("hSettings").onclick = () => { renderSettings(); go("settings"); };
$("sLogout").onclick = async () => { const r = await ask("تسجيل الخروج؟", [], "خروج"); if (r) logout(); };
for (const b of document.querySelectorAll("[data-go]")) b.onclick = () => { const v = b.dataset.go; go(v); ({ privacy: renderPrivacy, security: renderSecurity, chatset: renderChatSet, notifs: renderNotifs })[v]?.(); };

// الملف الشخصي
$("sMe").onclick = () => { avatar($("pAv"), S.me); $("pName").value = S.me.name; $("pAbout").value = S.me.about || ""; $("pEmail").value = S.me.email; go("profile"); };
$("pAv").onclick = () => $("fAvatar").click();
document.querySelector(".bigav .cam").onclick = () => $("fAvatar").click();
async function resizeImage(file, max, square, q = 0.82) {
  const url = URL.createObjectURL(file); const img = new Image(); img.src = url; await img.decode();
  let sx = 0, sy = 0, sw2 = img.naturalWidth, sh = img.naturalHeight;
  if (square) { const m = Math.min(sw2, sh); sx = (sw2 - m) / 2; sy = (sh - m) / 2; sw2 = sh = m; }
  const sc = Math.min(1, max / Math.max(sw2, sh));
  const c = document.createElement("canvas"); c.width = Math.round(sw2 * sc); c.height = Math.round(sh * sc);
  c.getContext("2d").drawImage(img, sx, sy, sw2, sh, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url);
  return c.toDataURL("image/jpeg", q);
}
async function setMe(patch) {
  const d = await api("/api/me", patch);
  S.me = { ...S.me, ...d.user }; localStorage.setItem("w_me", JSON.stringify(S.me));
  native({ type: "auth", token: S.token, me: S.me.id, server: API, name: S.me.name });
}
$("fAvatar").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try { await setMe({ avatar: await resizeImage(f, 320, true, 0.8) }); avatar($("pAv"), S.me); renderSettings(); toast("تم تحديث الصورة"); }
  catch (er) { toast(er.message || "تعذّر رفع الصورة"); }
};
$("pRmAv").onclick = async () => { await setMe({ avatar: null }); avatar($("pAv"), S.me); renderSettings(); };
$("pSave").onclick = async () => { try { await setMe({ name: $("pName").value, about: $("pAbout").value }); toast("تم الحفظ"); renderSettings(); } catch (e) { toast(e.message); } };

// الخصوصية
function renderPrivacy() { sw("prSeen", S.me.hide_seen); sw("prRead", S.me.receipts !== false); }
$("prSeen").onclick = async () => { await setMe({ hide_seen: !S.me.hide_seen }); renderPrivacy(); };
$("prRead").onclick = async () => { await setMe({ receipts: S.me.receipts === false }); renderPrivacy(); };

// الأمان
function renderSecurity() {
  sw("scLock", SET.lock); sw("scBio", SET.bio); sw("scSecure", SET.secure);
  $("scBio").classList.toggle("hidden", !NAT.bio || !SET.lock);
  $("scAfterRow").classList.toggle("hidden", !SET.lock);
  $("scSecure").classList.toggle("hidden", !NAT.android);
  for (const b of $("scAfter").children) b.classList.toggle("on", Number(b.dataset.v) === SET.after);
  api("/api/sessions").then((d) => ($("scSess").textContent = `مسجّل في ${d.count} ${d.count === 1 ? "جهاز" : "أجهزة"}`)).catch(() => {});
}
$("scLock").onclick = async () => {
  if (SET.lock) { const r = await ask("إيقاف قفل التطبيق؟", [{ ph: "الرمز الحالي", type: "password", mode: "numeric", max: 6 }], "إيقاف"); if (!r) return; if ((await pinHash(r[0], SET.lock.salt)) !== SET.lock.hash) return toast("رمز خاطئ"); SET.lock = null; SET.bio = false; saveSet(); return renderSecurity(); }
  const r = await ask("رمز القفل", [{ ph: "رمز من 4 إلى 6 أرقام", type: "password", mode: "numeric", max: 6 }, { ph: "أعد كتابة الرمز", type: "password", mode: "numeric", max: 6 }], "تفعيل");
  if (!r) return;
  if (!/^\d{4,6}$/.test(r[0])) return toast("الرمز يجب أن يكون 4 إلى 6 أرقام");
  if (r[0] !== r[1]) return toast("الرمزان غير متطابقين");
  const salt = randHexJS(16);
  SET.lock = { salt, hash: await pinHash(r[0], salt), len: r[0].length };
  saveSet(); renderSecurity(); toast("🔒 تم تفعيل القفل");
};
$("scBio").onclick = async () => { if (!SET.bio) { const r = await nativeAsk({ type: "bio", reason: "تفعيل البصمة" }, "bio"); if (!r.ok) return; } SET.bio = !SET.bio; saveSet(); renderSecurity(); };
$("scAfter").onclick = (e) => { const v = e.target.dataset.v; if (v === undefined) return; SET.after = Number(v); saveSet(); renderSecurity(); };
$("scSecure").onclick = () => { SET.secure = !SET.secure; saveSet(); renderSecurity(); };
$("scPass").onclick = async () => {
  const r = await ask("تغيير كلمة المرور", [{ ph: "كلمة المرور الحالية", type: "password" }, { ph: "كلمة المرور الجديدة", type: "password" }, { ph: "أعد كتابة الجديدة", type: "password" }], "تغيير");
  if (!r) return;
  if (r[1].length < 6) return toast("كلمة المرور قصيرة");
  if (r[1] !== r[2]) return toast("كلمتا المرور غير متطابقتين");
  try {
    toast("🔐 جارٍ إعادة تشفير المفاتيح…");
    const backup = await makeBackup(r[1], localStorage.getItem("w_priv"));
    await api("/api/password", { old: await authKey(S.me.email, r[0]), password: await authKey(S.me.email, r[1]), backup });
    toast("✅ تم تغيير كلمة المرور"); renderSecurity();
  } catch (e) { toast(e.message); }
};
$("scAll").onclick = async () => { const r = await ask("تسجيل الخروج من كل الأجهزة الأخرى؟", [], "تأكيد"); if (!r) return; await api("/api/logout-all", {}); toast("تم"); renderSecurity(); };
$("scDel").onclick = async () => {
  const r = await ask("⚠️ حذف الحساب وكل الرسائل نهائياً", [{ ph: "اكتب كلمة المرور للتأكيد", type: "password" }], "حذف نهائياً");
  if (!r) return;
  try { await api("/api/delete-account", { password: await authKey(S.me.email, r[0]) }); logout(true); toast("تم حذف الحساب"); } catch (e) { toast(e.message); }
};

// إعدادات الدردشة
function renderChatSet() {
  $("walls").innerHTML = Object.entries(WALLS).map(([k, w]) => `<button data-w="${k}" class="${SET.wall === k ? "on" : ""}" style="background:${k === "glow" ? "radial-gradient(circle at 30% 20%,#00d1a055,transparent 60%),radial-gradient(circle at 80% 70%,#00a3ff44,transparent 60%),#07090f" : k === "custom" ? (localStorage.getItem("w_wall") ? wallCss("custom") : "#ffffff14") : w.css}">${k === "custom" ? "📷<br>" : ""}${w.n}</button>`).join("");
  $("wDim").value = SET.dim;
  for (const b of $("fsSeg").children) b.classList.toggle("on", b.dataset.v === SET.fs);
  sw("csEnter", SET.enter);
  applySet();
}
$("walls").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; if (b.dataset.w === "custom") return $("fWall").click(); SET.wall = b.dataset.w; saveSet(); renderChatSet(); };
$("fWall").onchange = async (e) => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; try { localStorage.setItem("w_wall", await resizeImage(f, 1400, false, 0.8)); SET.wall = "custom"; saveSet(); renderChatSet(); } catch { toast("الصورة كبيرة جداً"); } };
$("wDim").oninput = () => { SET.dim = Number($("wDim").value); saveSet(); };
$("fsSeg").onclick = (e) => { const v = e.target.dataset.v; if (!v) return; SET.fs = v; saveSet(); renderChatSet(); };
$("csEnter").onclick = () => { SET.enter = !SET.enter; saveSet(); renderChatSet(); };

// الإشعارات
function renderNotifs() { sw("nMsg", SET.msgN); sw("nCall", SET.callN); sw("nSound", SET.sound); }
$("nMsg").onclick = () => { SET.msgN = !SET.msgN; saveSet(); renderNotifs(); };
$("nCall").onclick = () => { SET.callN = !SET.callN; saveSet(); renderNotifs(); };
$("nSound").onclick = () => { SET.sound = !SET.sound; saveSet(); renderNotifs(); };

// ---------- الأصوات ----------
let AC;
const ac = () => (AC ||= new (window.AudioContext || window.webkitAudioContext)());
function tone(f, d, v = 0.15) { try { const a = ac(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = f; g.gain.value = v; o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + d); } catch {} }
function beep() { tone(880, 0.08); setTimeout(() => tone(1175, 0.1), 110); }
let ringT;
function ring(kind) {
  stopRing();
  const f = () => kind === "in" ? (tone(660, 0.35, 0.2), setTimeout(() => tone(880, 0.35, 0.2), 400)) : tone(440, 0.9, 0.08);
  f(); ringT = setInterval(f, kind === "in" ? 1800 : 3000);
  if (kind === "in" && navigator.vibrate) navigator.vibrate([400, 200, 400]);
}
function stopRing() { clearInterval(ringT); }
document.addEventListener("touchstart", () => { try { ac().resume(); } catch {} }, { once: true });

// ---------- المكالمات (WebRTC) ----------
let C = null;
let ICE = null;
async function iceServers() {
  if (ICE && ICE.t > Date.now() - 3600e3) return ICE.s;
  try { const d = await (await fetch(API + "/api/turn")).json(); ICE = { s: d.iceServers, t: Date.now() }; return d.iceServers; }
  catch { return [{ urls: "stun:stun.l.google.com:19302" }]; }
}
const getMedia = (video, facing = "user") => navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: video ? { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
});
function callUI(state) {
  const u = S.users[C.peer] || { id: C.peer, name: "…" };
  $("call").classList.remove("hidden");
  $("call").classList.toggle("vid", C.video);
  $("call").classList.toggle("live", state === "live");
  avatar($("kAv"), u); $("kName").textContent = u.name;
  $("kIncoming").classList.toggle("hidden", state !== "incoming");
  $("kActive").classList.toggle("hidden", state === "incoming");
  for (const b of document.querySelectorAll(".vidonly")) b.classList.toggle("hidden", !C.video);
  $("lv").classList.toggle("hidden", !C.video || state === "incoming");
  $("rv").classList.toggle("hidden", !C.video || state !== "live");
  const t = { incoming: C.video ? "مكالمة فيديو واردة…" : "مكالمة صوتية واردة…", calling: "جارٍ الاتصال…", ringing: "يرن…", connecting: "جارٍ التوصيل…", live: "00:00" };
  $("kState").textContent = t[state] || state;
  native({ type: "call", active: true });
}
function makePC(servers) {
  const pc = new RTCPeerConnection({ iceServers: servers });
  pc.onicecandidate = (e) => { if (e.candidate) sig({ kind: "ice", c: e.candidate.toJSON() }); };
  pc.ontrack = (e) => {
    const st = e.streams[0] || new MediaStream([e.track]);
    if (C.video) { $("rv").srcObject = st; $("rv").play().catch(() => {}); }
    $("ra").srcObject = st; $("ra").play().catch(() => {});
    if (C.video) $("ra").muted = true;
  };
  pc.onconnectionstatechange = () => {
    if (!C || C.pc !== pc) return;
    const s = pc.connectionState;
    if (s === "connected" && C.state !== "live") goLive();
    if (s === "failed") { toast("تعذّر الاتصال"); endCall(true); }
    if (s === "disconnected") $("kState").textContent = "إعادة الاتصال…";
  };
  return pc;
}
function sig(data) {
  const to = C.peer, callId = C.id, { kind, ...rest } = data;
  S.sigQ = (S.sigQ || Promise.resolve()).then(async () => {
    const payload = Object.keys(rest).length ? { e: await enc(to, JSON.stringify(rest)) } : {};
    wsSend({ t: "signal", to, data: { kind, callId, ...payload } });
  }).catch(() => {});
  return S.sigQ;
}
function goLive() {
  C.state = "live"; C.start = Date.now(); stopRing(); callUI("live");
  clearInterval(C.timer);
  C.timer = setInterval(() => { $("kState").textContent = fmtDur((Date.now() - C.start) / 1000).padStart(5, "0"); }, 1000);
}
async function startCall(video) {
  if (C || !S.peer) return;
  if (!S.wsOk) return toast("غير متصل بالسيرفر");
  const peer = S.peer.id;
  try { await sharedKey(peer); } catch { return toast("هذا المستخدم يحتاج تحديث التطبيق"); }
  C = { peer, id: Math.random().toString(36).slice(2), video, out: true, state: "calling", pendingIce: [] };
  callUI("calling"); ring("out");
  try {
    const local = await getMedia(video);
    if (!C || C.peer !== peer) { local.getTracks().forEach((t) => t.stop()); return; }
    C.local = local;
    if (video) { $("lv").srcObject = C.local; $("lv").play().catch(() => {}); }
    C.pc = makePC(await iceServers());
    C.local.getTracks().forEach((t) => C.pc.addTrack(t, C.local));
    const offer = await C.pc.createOffer();
    await C.pc.setLocalDescription(offer);
    sig({ kind: "offer", sdp: offer.sdp, video });
    C.noAns = setTimeout(() => { if (C && C.state !== "live") { toast("لا يوجد رد"); endCall(true, "noanswer"); } }, 45000);
  } catch { toast("لم يُسمح بالمايك/الكاميرا"); cleanup(); }
}
$("cVoice").onclick = () => startCall(false);
$("cVideo").onclick = () => startCall(true);

async function onSignal(from, d) {
  if (d.e) {
    const plain = await dec(from, d.e);
    try { Object.assign(d, JSON.parse(plain)); } catch { return; }
    delete d.e;
  }
  if (d.kind === "offer") {
    if (C && C.id === d.callId) return;
    if (C) { wsSend({ t: "signal", to: from, data: { kind: "busy", callId: d.callId } }); return; }
    if (!d.sdp) return;
    C = { peer: from, id: d.callId, video: !!d.video, out: false, state: "incoming", offer: d.sdp, pendingIce: [] };
    if (locked) unlock();
    callUI("incoming");
    if (!(document.hidden && NAT.any)) ring("in");
    if (window.WASEL_AUTOANSWER === d.callId) { window.WASEL_AUTOANSWER = null; setTimeout(() => $("kAccept").click(), 400); }
    wsSend({ t: "signal", to: from, data: { kind: "ringing", callId: d.callId } });
    C.missT = setTimeout(() => { if (C && C.state === "incoming") { logCall("missed"); cleanup(); } }, 45000);
    return;
  }
  if (!C || d.callId !== C.id) return;
  switch (d.kind) {
    case "ringing": if (C.state === "calling") { C.state = "ringing"; $("kState").textContent = "يرن…"; } break;
    case "answer":
      clearTimeout(C.noAns); stopRing(); C.state = "connecting"; callUI("connecting");
      await C.pc.setRemoteDescription({ type: "answer", sdp: d.sdp });
      for (const c of C.pendingIce) C.pc.addIceCandidate(c).catch(() => {});
      C.pendingIce = [];
      break;
    case "ice":
      if (C.pc && C.pc.remoteDescription) C.pc.addIceCandidate(d.c).catch(() => {}); else C.pendingIce.push(d.c);
      break;
    case "handled": if (C.state === "incoming") cleanup(); break;
    case "reject": toast("تم رفض المكالمة"); endCall(false, "rejected"); break;
    case "busy": toast("الطرف الآخر في مكالمة"); endCall(false, "busy"); break;
    case "unavailable": toast("غير متصل حالياً"); endCall(false, "unavailable"); break;
    case "end":
      if (C.state === "incoming") { logCall("missed"); cleanup(); } else endCall(false);
      break;
  }
}
$("kAccept").onclick = async () => {
  if (!C || C.state !== "incoming") return;
  clearTimeout(C.missT); stopRing(); C.state = "connecting"; callUI("connecting");
  try {
    const local = await getMedia(C.video);
    if (!C) { local.getTracks().forEach((t) => t.stop()); return; }
    C.local = local;
    if (C.video) { $("lv").srcObject = C.local; $("lv").play().catch(() => {}); }
    C.pc = makePC(await iceServers());
    C.local.getTracks().forEach((t) => C.pc.addTrack(t, C.local));
    await C.pc.setRemoteDescription({ type: "offer", sdp: C.offer });
    for (const c of C.pendingIce) C.pc.addIceCandidate(c).catch(() => {});
    C.pendingIce = [];
    const ans = await C.pc.createAnswer();
    await C.pc.setLocalDescription(ans);
    sig({ kind: "answer", sdp: ans.sdp });
  } catch { toast("لم يُسمح بالمايك/الكاميرا"); sig({ kind: "reject" }); cleanup(); }
};
$("kReject").onclick = () => { if (!C) return; sig({ kind: "reject" }); logCall("declined"); cleanup(); };
$("kHang").onclick = () => endCall(true);
$("kMute").onclick = () => {
  if (!C?.local) return;
  const t = C.local.getAudioTracks()[0]; t.enabled = !t.enabled;
  $("kMute").classList.toggle("on", !t.enabled);
  $("kMute").innerHTML = `<svg><use href="#i-${t.enabled ? "mic" : "micoff"}"/></svg>`;
};
$("kCam").onclick = () => {
  const t = C?.local?.getVideoTracks()[0]; if (!t) return; t.enabled = !t.enabled;
  $("kCam").classList.toggle("on", !t.enabled);
  $("kCam").innerHTML = `<svg><use href="#i-${t.enabled ? "video" : "camoff"}"/></svg>`;
};
$("kFlip").onclick = async () => {
  if (!C?.pc || !C.video) return;
  C.facing = C.facing === "environment" ? "user" : "environment";
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: C.facing } });
    const nt = s.getVideoTracks()[0];
    const sender = C.pc.getSenders().find((x) => x.track && x.track.kind === "video");
    await sender.replaceTrack(nt);
    const old = C.local.getVideoTracks()[0]; C.local.removeTrack(old); old.stop(); C.local.addTrack(nt);
    $("lv").srcObject = C.local; $("lv").style.transform = C.facing === "user" ? "scaleX(-1)" : "none";
  } catch { toast("تعذّر تبديل الكاميرا"); }
};
function endCall(notify, reason) {
  if (!C) return;
  if (notify) sig({ kind: "end" });
  const dur = C.start ? Math.floor((Date.now() - C.start) / 1000) : 0;
  logCall(C.out ? (dur ? "out" : reason === "noanswer" ? "noanswer" : "cancelled") : dur ? "in" : "missed", dur);
  if (C.out) sendTo(C.peer, (C.video ? "مكالمة فيديو" : "مكالمة صوتية") + (dur ? " • " + fmtDur(dur) : " • لم يتم الرد"), "call");
  cleanup();
}
function cleanup() {
  if (!C) return;
  stopRing(); clearTimeout(C.noAns); clearTimeout(C.missT); clearInterval(C.timer);
  try { C.local && C.local.getTracks().forEach((t) => t.stop()); } catch {}
  try { C.pc && C.pc.close(); } catch {}
  $("rv").srcObject = null; $("lv").srcObject = null; $("ra").srcObject = null; $("ra").muted = false;
  $("kMute").classList.remove("on"); $("kMute").innerHTML = '<svg><use href="#i-mic"/></svg>';
  $("kCam").classList.remove("on"); $("kCam").innerHTML = '<svg><use href="#i-video"/></svg>';
  $("lv").style.transform = "";
  $("call").classList.add("hidden");
  C = null;
  native({ type: "call", active: false });
}
function logCall(type, dur = 0) {
  if (!C) return;
  S.calls.unshift({ peer: C.peer, type, video: C.video, ts: Date.now(), dur });
  S.calls = S.calls.slice(0, 100);
  localStorage.setItem("w_calls", JSON.stringify(S.calls));
  renderCalls();
}
function renderCalls() {
  const el = $("callList");
  if (!S.calls.length) { el.innerHTML = '<div class="empty">لا توجد مكالمات بعد.</div>'; return; }
  const L = { out: ["↗", "صادرة", ""], in: ["↙", "واردة", ""], missed: ["↙", "فائتة", "var(--red)"], declined: ["↙", "مرفوضة", "var(--red)"], noanswer: ["↗", "لم يتم الرد", "var(--red)"], cancelled: ["↗", "ملغاة", ""], rejected: ["↗", "مرفوضة", "var(--red)"], busy: ["↗", "مشغول", ""], unavailable: ["↗", "غير متصل", ""] };
  el.innerHTML = "";
  for (const c of S.calls) {
    const u = S.users[c.peer] || { id: c.peer, name: "…" }; const l = L[c.type] || L.out;
    const r = document.createElement("div"); r.className = "row"; r.style.animation = "none";
    r.innerHTML = `<div class="av"></div><div class="mid"><div class="top"><span class="nm" style="color:${l[2] || "inherit"}">${esc(u.name)}</span><span class="tm">${shortTime(c.ts)} ${hm(c.ts)}</span></div>
      <div class="sub"><span class="pv">${l[0]} ${l[1]}${c.dur ? " • " + fmtDur(c.dur) : ""}</span><span>${c.video ? "📹" : "📞"}</span></div></div>`;
    avatar(r.querySelector(".av"), u);
    r.onclick = () => { S.peer = u; S.users[u.id] ||= u; startCall(c.video); };
    el.append(r);
  }
}

// ---------- لعبة ألوان ----------
const G = { ws: null, s: null, code: null };
const CARD_SYM = { S: "⊘", R: "⇄", D: "+2", W: "✦", 4: "+4" };
const COLOR_NAMES = { r: "أحمر", y: "أصفر", g: "أخضر", b: "أزرق" };
function cardHtml(c, cls = "") {
  if (!c) return "";
  const k = c[0], v = c[1], sym = CARD_SYM[v] || v;
  return `<div class="kc ${k} ${cls}" data-c="${esc(c)}"><i>${sym}</i><span>${sym}</span><i class="br">${sym}</i></div>`;
}
const genCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (x) => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[x % 31]).join("");
$("hGame").onclick = $("sGame").onclick = async () => {
  const r = await ask("🎴 لعبة ألوان", [{ ph: "رمز الغرفة للانضمام (اتركه فارغاً لإنشاء غرفة)", max: 8 }], "متابعة");
  if (!r) return;
  joinGame(r[0].trim().toUpperCase() || genCode());
};
function joinGame(code) {
  if (!/^[A-Z0-9]{4,8}$/.test(code)) return toast("رمز غير صحيح");
  if (G.ws) { try { G.ws.close(); } catch {} }
  G.code = code; G.s = null;
  $("gCode").textContent = code; $("gCodeTop").textContent = code;
  go("game");
  $("gLobby").classList.remove("hidden"); $("gTable").classList.add("hidden"); $("gHandWrap").classList.add("hidden");
  $("gPlayers").innerHTML = '<div class="empty">⏳ جارٍ الاتصال…</div>';
  const ws = new WebSocket(API.replace(/^http/, "ws") + `/game?room=${code}&token=${encodeURIComponent(S.token)}`);
  G.ws = ws;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "state") { G.s = m.s; renderGame(); }
    else if (m.t === "err") toast(m.msg);
    else if (m.t === "fx") gameFx(m);
  };
  ws.onclose = (e) => { if (G.ws === ws && S.view === "game" && e.code !== 1000) { if (e.code === 4000) { toast("لا يمكن الدخول"); history.back(); } else setTimeout(() => G.ws === ws && joinGame(code), 1500); } };
}
const gSend = (o) => G.ws && G.ws.readyState === 1 && G.ws.send(JSON.stringify(o));
function leaveGameView() { if (G.ws) { const w = G.ws; G.ws = null; try { w.send(JSON.stringify({ a: "leave" })); } catch {} setTimeout(() => { try { w.close(1000); } catch {} }, 200); } clearInterval(G.tick); }
$("gBack").onclick = async () => { if (G.s?.status === "play") { const r = await ask("مغادرة اللعبة؟", [], "مغادرة"); if (!r) return; } history.back(); };
$("gStart").onclick = () => gSend({ a: "start" });
$("gInvite").onclick = () => inviteToGame();
async function inviteToGame(peerId) {
  if (!peerId) {
    const opts = S.chats.slice(0, 30);
    if (!opts.length) return toast("لا توجد دردشات — ارسل الرمز لصديقك: " + G.code);
    $("acts").innerHTML = opts.map((c, i) => `<button data-a="${i}"><span class="em">👤</span>${esc((S.users[c.user.id] || c.user).name)}</button>`).join("");
    $("acts").onclick = async (e) => { const b = e.target.closest("button"); if (!b) return; closeSheets(); const u = opts[Number(b.dataset.a)].user; await sendGameInvite(u.id, G.code); toast("📨 تم إرسال الدعوة"); };
    return openSheet("actSheet");
  }
  const code = genCode();
  await sendGameInvite(peerId, code);
  joinGame(code);
}
async function sendGameInvite(peerId, code) {
  const prevPeer = S.peer;
  S.peer = S.users[peerId] || { id: peerId };
  await send(JSON.stringify({ code }), "game", { meta: { code } });
  S.peer = prevPeer;
}
function renderGame() {
  const s = G.s; if (!s) return;
  const me = S.me.id, isHost = s.host === me;
  const lobby = s.status === "lobby";
  $("gLobby").classList.toggle("hidden", !lobby);
  $("gTable").classList.toggle("hidden", lobby);
  $("gHandWrap").classList.toggle("hidden", lobby);
  if (lobby) {
    $("gCount").textContent = `اللاعبون ${s.players.length}/8`;
    $("gPlayers").innerHTML = s.players.map((p) => `<div class="it"><div class="av sm" data-av="${p.id}"></div><span class="tx">${esc(p.name)}${p.id === s.host ? " 👑" : ""}${p.wins ? ` <small>🏆 ${p.wins}</small>` : ""}</span>${isHost && p.id !== me ? `<button class="link" data-kick="${p.id}">إخراج</button>` : ""}</div>`).join("");
    for (const el of $("gPlayers").querySelectorAll("[data-av]")) { const p = s.players.find((x) => x.id == el.dataset.av); avatar(el, p); }
    $("gPlayers").onclick = (e) => { const k = e.target.dataset.kick; if (k) gSend({ a: "kick", target: Number(k) }); };
    $("gStart").classList.toggle("hidden", !isHost);
    $("gStart").disabled = s.players.length < 2;
    $("gStart").textContent = s.players.length < 2 ? "بانتظار لاعب آخر…" : "▶️ ابدأ اللعبة";
    return;
  }
  // الطاولة: اللاعبون حول الدائرة بدءاً مني
  const table = $("gTable");
  for (const el of table.querySelectorAll(".opp")) el.remove();
  const ps = s.players, myIdx = Math.max(0, ps.findIndex((p) => p.id === me)), n = ps.length;
  ps.forEach((p, i) => {
    if (p.id === me) return;
    const rel = (i - myIdx + n) % n;
    const ang = Math.PI / 2 + (rel / n) * Math.PI * 2;
    const x = 50 + Math.cos(ang) * 40, y = 44 + Math.sin(ang) * 36;
    const el = document.createElement("div");
    el.className = `opp${s.turn === p.id ? " turn" : ""}${p.left || !p.online ? " off" : ""}`;
    el.style.left = x + "%"; el.style.top = y + "%"; el.dataset.pid = p.id;
    el.innerHTML = `<div class="av"></div><div class="nm">${esc(p.name)}</div><div class="cnt">🂠 ${p.count}</div>${p.said1 ? '<span class="one">واحدة!</span>' : ""}${s.vuln === p.id ? `<button class="catch" data-catch="${p.id}">امسكه!</button>` : ""}`;
    avatar(el.querySelector(".av"), p);
    table.append(el);
  });
  table.onclick = (e) => { const c = e.target.closest("[data-catch]"); if (c) gSend({ a: "catch", target: Number(c.dataset.catch) }); };
  $("gTop").innerHTML = cardHtml(s.top, "big");
  const cc = { r: "#ff5f6d", y: "#ffd84a", g: "#3ee08f", b: "#4facfe" }[s.color];
  $("gColor").style.background = cc; $("gColor").style.color = cc;
  $("gRing").classList.toggle("ccw", s.dir < 0);
  $("gLog").textContent = s.log || "";
  const myTurn = s.turn === me;
  const meP = ps.find((p) => p.id === me);
  if (s.status === "over") {
    const w = ps.find((p) => p.id === s.winner);
    $("gLog").textContent = `🏆 ${w ? w.name : ""} فاز!`;
    $("gTimer").textContent = isHost ? "" : "بانتظار صاحب الغرفة…";
    if (isHost) { $("gTimer").innerHTML = '<button class="btn" id="gAgain" style="padding:8px 18px;font-size:14px">🔁 جولة جديدة</button>'; $("gAgain").onclick = () => gSend({ a: "lobby" }); }
  }
  // يدي
  const playable = new Set(s.playable);
  $("gHand").innerHTML = s.hand.map((c) => cardHtml(c, myTurn ? (playable.has(c) ? "ok" : "no") : "")).join("");
  $("gHand").onclick = (e) => {
    const k = e.target.closest(".kc"); if (!k || !myTurn) return;
    const c = k.dataset.c;
    if (!playable.has(c)) return toast("لا يمكن لعب هذا الكرت");
    if (c[0] === "w") return pickColor(c);
    gSend({ a: "play", card: c });
  };
  $("gDraw").disabled = !myTurn || s.drew; $("gDraw").textContent = myTurn ? "سحب 🂠" : "ليس دورك";
  $("gPass").classList.toggle("hidden", !(myTurn && s.drew));
  $("gOne").classList.toggle("hidden", !meP || meP.count > 2 || meP.said1 || s.status !== "play");
  clearInterval(G.tick);
  const tick = () => { if (s.status !== "play") return; const left = Math.max(0, Math.ceil((s.deadline - Date.now()) / 1000)); const who = ps.find((p) => p.id === s.turn); $("gTimer").textContent = (myTurn ? "دورك! " : `دور ${who ? who.name : ""} `) + `⏱️ ${left}`; };
  tick(); G.tick = setInterval(tick, 500);
  if (myTurn && SET.sound && G.lastTurn !== s.turn + ":" + s.deadline) tone(990, 0.12);
  G.lastTurn = s.turn + ":" + s.deadline;
}
function pickColor(card) {
  $("colorPick").innerHTML = ["r", "y", "g", "b"].map((k) => `<button class="kc ${k}" data-k="${k}" style="width:58px;height:58px;border-radius:50%"><span style="font-size:13px">${COLOR_NAMES[k]}</span></button>`).join("");
  $("colorPick").onclick = (e) => { const b = e.target.closest("[data-k]"); if (!b) return; closeSheets(); gSend({ a: "play", card, color: b.dataset.k }); };
  openSheet("colorSheet");
}
$("gDraw").onclick = () => gSend({ a: "draw" });
$("gPass").onclick = () => gSend({ a: "pass" });
$("gOne").onclick = () => gSend({ a: "one" });
$("gEmojis").innerHTML = ["😂", "😡", "😎", "🔥", "👏", "😭"].map((e) => `<button>${e}</button>`).join("");
$("gEmojis").onclick = (e) => { if (e.target.tagName === "BUTTON") gSend({ a: "emoji", e: e.target.textContent }); };
function gameFx(m) {
  if (m.kind === "emoji" || m.kind === "one" || m.kind === "catch") {
    const el = document.querySelector(`.opp[data-pid="${m.by}"]`);
    const txtE = m.kind === "emoji" ? m.e : m.kind === "one" ? "☝️" : "🫵";
    if (el) { const b = document.createElement("div"); b.className = "bubble"; b.textContent = txtE; el.append(b); setTimeout(() => b.remove(), 1800); }
    else if (m.by === S.me.id) toast(txtE);
    if (m.kind === "catch" && m.target === S.me.id) toast("🫵 مسكوك! تسحب 2");
  }
  if (m.kind === "play" && SET.sound) tone(520, 0.06, 0.1);
}

// ---------- البدء ----------
function start() {
  show("home"); renderChats(); renderCalls(); loadChats(); connect(); applySet();
  history.replaceState({ v: "home" }, "");
  native({ type: "auth", token: S.token, me: S.me.id, server: API, name: S.me.name });
  native({ type: "prefs", msgN: SET.msgN, callN: SET.callN, secure: SET.secure });
  api("/api/me").then((d) => { S.me = { ...S.me, ...d.user }; localStorage.setItem("w_me", JSON.stringify(S.me)); }).catch(() => {});
}
buildPad(); applySet();
if (S.token && S.me && localStorage.getItem("w_priv")) { start(); if (SET.lock) lockNow(); } else { if (S.token) logout(true); show("auth"); }
