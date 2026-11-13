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
  { wall: "glow", dim: 25, fs: "15.5px", enter: false, lock: null, bio: false, after: 0, secure: false, msgN: true, callN: true, sound: true, lp: true },
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
const VIEWS = ["auth", "home", "chat", "settings", "profile", "privacy", "security", "chatset", "notifs", "blocked"];
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
const txt = (m) => m.text ?? (PT.has(m.body) ? PT.get(m.body) : m.body && /^(e1|g1):/.test(m.body) ? "🔒 …" : m.body);
const meta = (m) => { if (m.meta) return m.meta; try { return (m.meta = JSON.parse(txt(m))); } catch { return null; } };
// ظرف مشفّر لعدة مستلمين (المجموعات والحالات): مفتاح عشوائي يُشفَّر لكل مستلم بمفتاحه
async function encEnv(ids, text) {
  const raw = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ck = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const ct = b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ck, TE.encode(text)));
  const k = {};
  const all = [...new Set([...ids, S.me.id])];
  S.users[S.me.id] = { ...S.users[S.me.id], ...S.me };
  await Promise.all(all.map(async (id) => { try { k[id] = await enc(id, b64(raw)); } catch {} }));
  const out = "g1:" + b64(TE.encode(JSON.stringify({ iv: b64(iv), ct, k })));
  PT.set(out, text);
  return out;
}
async function decEnv(sender, body) {
  if (PT.has(body)) return PT.get(body);
  try {
    const o = JSON.parse(TD.decode(ub64(body.slice(3))));
    const w = o.k[S.me.id]; if (!w) throw 0;
    S.users[S.me.id] = { ...S.users[S.me.id], ...S.me };
    const raw = await dec(sender, w);
    if (raw.startsWith("🔒")) throw 0;
    const ck = await crypto.subtle.importKey("raw", ub64(raw), "AES-GCM", false, ["decrypt"]);
    const t = TD.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(o.iv) }, ck, ub64(o.ct)));
    PT.set(body, t); return t;
  } catch { return "🔒 تعذّر فك التشفير"; }
}
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
  if (m.kind === "sys") return m.body;
  if (m.kind === "loc") return "📍 موقع";
  if (m.kind === "contact") return "👤 " + (meta(m)?.name || "جهة اتصال");
  if (m.kind === "link") return meta(m)?.t || "🔗 رابط";
  if (m.kind === "file") { const x = meta(m); if (!x) return "📎 ملف"; return x.mime?.startsWith("image/") ? "📷 صورة" : x.mime?.startsWith("video/") ? "🎥 فيديو" : "📄 " + x.name; }
  if (m.kind === "voice") return "🎤 رسالة صوتية";
  if (m.kind === "game") return "🎴 دعوة لعبة";
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
    if (S.cur && S.view === "chat") markRead(S.cur);
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
  PRIV = null; PT.clear(); S.token = null; S.me = null; S.msgs = {}; S.convs = new Map(); S.cur = null; S.calls = [];
  try { S.ws && S.ws.close(); } catch {}
  show("auth");
}

