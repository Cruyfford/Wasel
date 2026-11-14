// ---------- المحادثات (فردية u<id> وجماعية g<id>) ----------
S.convs = new Map();
const keyOfMsg = (m) => (m.gid ? "g" + m.gid : "u" + (m.a === S.me.id ? m.b : m.a));
const cur = () => S.convs.get(S.cur);
function ensureConv(key, extra = {}) {
  let c = S.convs.get(key);
  if (!c) {
    c = { key, type: key[0], id: Number(key.slice(1)), last: null, unread: 0, prefs: { pinned: 0, muted: 0, archived: 0 }, ttl: 0 };
    S.convs.set(key, c);
  }
  Object.assign(c, extra);
  if (c.group) for (const u of c.group.members || []) S.users[u.id] = { ...S.users[u.id], ...u };
  if (c.user) S.users[c.user.id] = { ...S.users[c.user.id], ...c.user };
  return c;
}
function convName(c) { if (c.type === "u" && c.id === S.me?.id) return "⭐ الرسائل المحفوظة"; return c.type === "g" ? c.group?.name || "مجموعة" : (S.users[c.id] || c.user || {}).name || "…"; }
function convAv(c) { return c.type === "g" ? { id: c.id + 3, name: c.group?.name || "؟", avatar: c.group?.avatar } : S.users[c.id] || c.user || { id: c.id, name: "…" }; }
const memberIds = (c) => (c.group?.members || []).map((m) => m.id);
const isAdmin = (c) => !!(c.group?.members || []).find((m) => m.id === S.me.id && m.admin);

// التشفير حسب نوع المحادثة
async function encFor(key, text) {
  const c = S.convs.get(key) || ensureConv(key);
  if (c.type === "u") return enc(c.id, text);
  return encEnv(memberIds(c), text);
}
async function decMsg(m) {
  if (!m || !m.body || m.kind === "sys") return m && m.body;
  if (PT.has(m.body)) return PT.get(m.body);
  if (m.body.startsWith("e1:")) return dec(m.a === S.me.id ? m.b : m.a, m.body);
  if (m.body.startsWith("g1:")) return decEnv(m.a, m.body);
  return m.body;
}
const decList = (list) => Promise.all(list.map(decMsg));

// ---------- الاتصال اللحظي ----------
function connect() {
  if (!S.token || (S.ws && S.ws.readyState <= 1)) return;
  const ws = new WebSocket(API.replace(/^http/, "ws") + "/ws?token=" + encodeURIComponent(S.token));
  S.ws = ws;
  ws.onopen = () => { S.wsOk = true; S.retry = 0; $("connBar").classList.add("hidden"); loadChats(); if (S.cur && S.view === "chat") openChat(S.cur, true); flushQueue(); };
  ws.onclose = (e) => {
    S.wsOk = false; if (!S.token) return;
    if (e.code === 4001) { logout(true); toast("تم تسجيل خروجك من هذا الجهاز"); return; }
    $("connBar").classList.remove("hidden");
    setTimeout(connect, Math.min(10000, 800 * 2 ** S.retry++));
  };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); S.inq = (S.inq || Promise.resolve()).then(() => onWs(m)).catch((er) => console.warn(er)); };
}
setInterval(() => { if (S.wsOk) S.ws.send('{"t":"ping"}'); }, 25000);
function wsSend(o) { if (S.wsOk) { S.ws.send(JSON.stringify(o)); return true; } return false; }
const isOpen = (key) => S.cur === key && S.view === "chat" && !document.hidden;

async function onWs(m) {
  switch (m.t) {
    case "msg": {
      const msg = m.m, key = keyOfMsg(msg);
      if (m.user) S.users[m.user.id] = { ...S.users[m.user.id], ...m.user };
      const c = ensureConv(key, m.group && m.group.members ? { group: m.group } : m.group ? { group: { ...(S.convs.get(key)?.group || {}), ...m.group } } : m.user && key[0] === "u" ? { user: m.user } : {});
      if (key[0] === "g" && !c.group?.members) loadGroup(c.id);
      await decMsg(msg);
      pushMsg(key, msg);
      if (isOpen(key)) markRead(key);
      else if (msg.a !== S.me.id && msg.kind !== "sys" && SET.sound && !document.hidden && (!c.prefs.muted || mentionsMe(PT.get(msg.body), c))) beep();
      bumpConv(key, msg, msg.a !== S.me.id && msg.kind !== "sys");
      break;
    }
    case "ack": {
      const key = keyOfMsg(m.m), list = S.msgs[key] || [];
      const i = list.findIndex((x) => x.cid === m.cid);
      if (i >= 0) { const old = list[i]; list[i] = Object.assign(m.m, { meta: old.meta, local: old.local, text: old.text }); } else list.push(m.m);
      S.queue = (S.queue || []).filter((q) => q.cid !== m.cid);
      if (S.cur === key) renderMsgs();
      bumpConv(key, m.m, false);
      break;
    }
    case "status": {
      const key = "u" + m.with;
      for (const x of S.msgs[key] || []) if (x.a === S.me.id && x.status < m.status && x.id > 0) x.status = m.status;
      const c = S.convs.get(key); if (c && c.last && c.last.a === S.me.id) c.last.status = Math.max(c.last.status, m.status);
      if (S.cur === key) renderMsgs();
      renderChats();
      break;
    }
    case "deleted": case "edited": case "react": {
      const mm = m.m || m, key = keyOfMsg(mm);
      const list = S.msgs[key] || [];
      const x = list.find((y) => y.id === (m.id || mm.id));
      if (m.t === "deleted" && x) { x.deleted = 1; x.body = ""; x.meta = null; x.text = undefined; }
      if (m.t === "edited") { await decMsg(m.m); if (x) { Object.assign(x, m.m); x.meta = null; x.text = undefined; } }
      if (m.t === "react" && x) { x.reacts = { ...(x.reacts || {}) }; if (m.e) x.reacts[m.uid] = m.e; else delete x.reacts[m.uid]; }
      const c = S.convs.get(key);
      if (c && c.last && c.last.id === (m.id || mm.id) && m.t !== "react") { if (m.t === "deleted") c.last.deleted = 1; else c.last = m.m; }
      if (S.cur === key) renderMsgs();
      renderChats();
      break;
    }
    case "presence": {
      const u = S.users[m.id]; if (u) { u.online = m.online; u.last_seen = m.last_seen; }
      if (S.cur === "u" + m.id) setHeader();
      renderChats();
      break;
    }
    case "profile":
      S.users[m.user.id] = { ...S.users[m.user.id], ...m.user };
      for (const c of S.convs.values()) if (c.group) for (const mem of c.group.members || []) if (mem.id === m.user.id) Object.assign(mem, m.user);
      renderChats(); if (S.cur) setHeader();
      break;
    case "group": {
      const c = ensureConv("g" + m.group.id, { group: m.group });
      if (S.cur === c.key) { setHeader(); if (!$("infoSheet").classList.contains("hidden")) showInfo(); }
      renderChats();
      break;
    }
    case "group-removed": {
      S.convs.delete("g" + m.gid); delete S.msgs["g" + m.gid];
      if (S.cur === "g" + m.gid) { toast("لم تعد عضواً في هذه المجموعة"); history.back(); }
      renderChats();
      break;
    }
    case "typing": {
      const key = m.gid ? "g" + m.gid : "u" + m.from;
      if (S.cur === key) {
        const who = m.gid ? (S.users[m.from]?.name || "") + " " : "";
        $("cStatus").textContent = who + (m.rec ? "يسجّل صوتاً… 🎤" : "يكتب…");
        clearTimeout(S.typT); S.typT = setTimeout(setHeader, 3000);
      }
      break;
    }
    case "signal":
      if (m.user) S.users[m.user.id] = { ...S.users[m.user.id], ...m.user };
      onSignal(m.from, m.data);
      break;
    case "gsignal": onGSignal(m.from, m.gid, m.data); break;
    case "gcall": onGCall(m); break;
    case "status-new": case "status-view": loadStatuses(); break;
    case "votes": {
      const key = keyOfMsg(m), x = (S.msgs[key] || []).find((y) => y.id === m.id);
      if (x) { x.votes = m.votes; if (S.cur === key) renderMsgs(); }
      break;
    }
    case "scheduled": toast("تمت الجدولة: " + new Date(m.at).toLocaleString("ar", { dateStyle: "short", timeStyle: "short" })); break;
    case "err": toast(m.msg); break;
  }
}

// ---------- قائمة الدردشات ----------
async function loadChats() {
  try {
    const d = await api("/api/chats");
    const seen = new Set();
    for (const c of d.chats) {
      seen.add(c.key);
      if (c.last) await decMsg(c.last);
      ensureConv(c.key, c);
    }
    for (const k of [...S.convs.keys()]) if (!seen.has(k) && !(S.msgs[k] || []).length) S.convs.delete(k);
    renderChats();
  } catch {}
}
async function loadGroup(gid) { try { const d = await api("/api/group/info?gid=" + gid); ensureConv("g" + gid, { group: d.group }); renderChats(); if (S.cur === "g" + gid) setHeader(); } catch {} }
function bumpConv(key, msg, incoming) {
  const c = ensureConv(key);
  if (c.type === "u" && !S.users[c.id]) fetchUser(c.id);
  c.last = msg;
  if (incoming && !isOpen(key)) c.unread++;
  if (incoming && c.prefs.archived && !c.prefs.muted) { c.prefs.archived = 0; api("/api/prefs", { c: key, archived: false }).catch(() => {}); }
  renderChats();
}
async function fetchUser(id) { try { const d = await api("/api/user?id=" + id); S.users[id] = d.user; renderChats(); } catch {} }
function ticks(m) {
  if (!m || m.a !== S.me.id || m.deleted || m.kind === "sys") return "";
  if (!m.id) return '<span class="tick">🕓</span>';
  if (m.gid) return '<span class="tick">✓</span>';
  return m.status >= 2 ? '<span class="tick r">✓✓</span>' : m.status === 1 ? '<span class="tick">✓✓</span>' : '<span class="tick">✓</span>';
}
function renderChats() {
  const el = $("chatList"), q = $("hSearch").value.trim().toLowerCase();
  const all = [...S.convs.values()].filter((c) => c.last || c.type === "g");
  const archivedN = all.filter((c) => c.prefs.archived).length;
  let list = all.filter((c) => !!c.prefs.archived === !!S.showArchived);
  if (q) list = list.filter((c) => convName(c).toLowerCase().includes(q) || preview(c.last).toLowerCase().includes(q));
  list.sort((a, b) => (b.prefs.pinned - a.prefs.pinned) || ((b.last?.ts || b.group?.created || 0) - (a.last?.ts || a.group?.created || 0)));
  let html = "";
  if (S.showArchived) html += `<div class="row arch" data-arch="0"><span class="em">${ICO("reply")}</span><div class="mid"><b>رجوع للدردشات</b></div></div>`;
  else if (archivedN && !q) html += `<div class="row arch" data-arch="1"><span class="em">${ICO("archive")}</span><div class="mid"><b>المؤرشفة</b> <small>(${archivedN})</small></div></div>`;
  el.innerHTML = html;
  if (!list.length) { el.innerHTML += `<div class="empty">${q ? "لا توجد نتائج" : S.showArchived ? "لا توجد دردشات مؤرشفة" : "لا توجد دردشات بعد.<br>اضغط + وأضف صديقك بكوده الخاص."}</div>`; bindRows(); return; }
  let i = 0;
  for (const c of list) {
    const r = document.createElement("div"); r.className = "row"; r.dataset.key = c.key;
    if (!el.dataset.shown) r.style.animationDelay = Math.min(i++, 12) * 30 + "ms"; else r.style.animation = "none";
    const lastSender = c.type === "g" && c.last && c.last.kind !== "sys" ? (c.last.a === S.me.id ? "أنت: " : (S.users[c.last.a]?.name || "").split(" ")[0] + ": ") : "";
    const icons = (c.prefs.pinned ? ICO("pin") : "") + (c.prefs.muted ? ICO("bell-off") : "") + (c.ttl ? ICO("timer") : "");
    const gc = c.type === "g" && (S.gcallState[c.id] || []).length ? ICO("call") + " " : "";
    r.innerHTML = `<div class="av"></div><div class="mid"><div class="top"><span class="nm">${gc}${esc(convName(c))}</span><span class="tm ${c.unread && !c.prefs.muted ? "u" : ""}">${c.last ? shortTime(c.last.ts) : ""}</span></div>
      <div class="sub"><span class="pv">${ticks(c.last)} ${esc(lastSender + preview(c.last))}</span><span class="ics">${icons}${c.unread ? `<span class="badge${c.prefs.muted ? " mut" : ""}">${c.unread}</span>` : ""}</span></div></div>`;
    avatar(r.querySelector(".av"), convAv(c), c.type === "u");
    el.append(swipeable(r, () => clearChat(c, true)));
  }
  el.dataset.shown = 1;
  bindRows();
}
function bindRows() {
  const el = $("chatList");
  el.onclick = (e) => {
    const a = e.target.closest("[data-arch]"); if (a) { S.showArchived = a.dataset.arch === "1"; renderChats(); return; }
    const r = e.target.closest(".row[data-key]"); if (r && !S.lpFired && !S.swiping) openChat(r.dataset.key);
  };
  longPress(el, ".row[data-key]", (r) => chatActions(S.convs.get(r.dataset.key)));
}
// السحب لليمين يكشف زر حذف أحمر
function swipeable(row, onDelete) {
  const w = document.createElement("div"); w.className = "swrap";
  const del = document.createElement("button"); del.className = "sdel"; del.innerHTML = ICO("trash") + "<span>حذف</span>";
  w.append(del, row);
  let x0 = 0, y0 = 0, dx = 0, drag = false, decided = false, open = false;
  const set = (x, anim) => { row.style.transition = anim ? "transform .25s cubic-bezier(.2,.9,.25,1)" : "none"; row.style.transform = x ? `translateX(${x}px)` : ""; };
  const close = () => { open = false; set(0, true); };
  row.addEventListener("pointerdown", (e) => { x0 = e.clientX; y0 = e.clientY; dx = 0; drag = true; decided = false; });
  row.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (!decided) { if (Math.abs(mx) < 8 && Math.abs(my) < 8) return; decided = true; if (Math.abs(my) > Math.abs(mx)) { drag = false; return; } S.swiping = true; }
    dx = Math.max(0, Math.min(140, (open ? 96 : 0) + mx));
    set(dx);
  });
  const end = () => {
    if (!drag) return; drag = false;
    if (!decided) return;
    open = dx > 60; set(open ? 96 : 0, true);
    if (open) { for (const o of document.querySelectorAll(".swrap.open")) if (o !== w) o.querySelector(".row").style.transform = ""; }
    w.classList.toggle("open", open);
    setTimeout(() => (S.swiping = false), 50);
  };
  row.addEventListener("pointerup", end); row.addEventListener("pointercancel", end);
  row.addEventListener("click", (e) => { if (S.swiping) { e.stopPropagation(); return; } if (open) { e.stopPropagation(); close(); w.classList.remove("open"); } }, true);
  del.onclick = (e) => { e.stopPropagation(); close(); w.classList.remove("open"); onDelete(); };
  return w;
}
function longPress(root, sel, fn) {
  if (root.dataset.lp) return; root.dataset.lp = 1;
  let t = null, y0 = 0, x0 = 0;
  root.addEventListener("pointerdown", (e) => { const el = e.target.closest(sel); if (!el) return; S.lpFired = false; y0 = e.clientY; x0 = e.clientX; t = setTimeout(() => { t = null; S.lpFired = true; if (navigator.vibrate) navigator.vibrate(15); fn(el); setTimeout(() => (S.lpFired = false), 400); }, 480); });
  const cancel = () => { clearTimeout(t); t = null; };
  root.addEventListener("pointerup", cancel); root.addEventListener("pointercancel", cancel);
  root.addEventListener("pointermove", (e) => { if (Math.abs(e.clientY - y0) > 8 || Math.abs(e.clientX - x0) > 8) cancel(); });
  root.addEventListener("scroll", cancel, true);
  root.addEventListener("contextmenu", (e) => { const el = e.target.closest(sel); if (el) { e.preventDefault(); fn(el); } });
}
async function setPref(c, patch) {
  Object.assign(c.prefs, Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v ? 1 : 0])));
  renderChats();
  try { await api("/api/prefs", { c: c.key, ...patch }); } catch (e) { toast(e.message); }
}
function chatActions(c) {
  if (!c) return;
  sheetMenu([
    [c.prefs.pinned ? "pin" : "pin", c.prefs.pinned ? "إلغاء التثبيت" : "تثبيت في الأعلى", () => setPref(c, { pinned: !c.prefs.pinned })],
    [c.prefs.muted ? "bell" : "bell-off", c.prefs.muted ? "إلغاء الكتم" : "كتم الإشعارات", () => setPref(c, { muted: !c.prefs.muted })],
    [c.prefs.archived ? "archive" : "archive", c.prefs.archived ? "إلغاء الأرشفة" : "أرشفة", () => setPref(c, { archived: !c.prefs.archived })],
    ["eraser", "مسح محتوى المحادثة", () => clearChat(c, false), "dz"],
    ["trash", "حذف الدردشة", () => clearChat(c, true), "dz"],
  ], convName(c));
}
$("hSearch").oninput = renderChats;
function pushMsg(key, msg) {
  const list = (S.msgs[key] ||= []);
  if (msg.id && list.some((x) => x.id === msg.id)) return;
  list.push(msg);
  if (S.cur === key && S.view === "chat") renderMsgs(true);
}
function markRead(key) {
  const c = S.convs.get(key); if (!c) return;
  wsSend(c.type === "g" ? { t: "read", gid: c.id } : { t: "read", to: c.id });
  if (c.unread) { c.unread = 0; renderChats(); }
}

// ---------- فتح محادثة ----------
function setHeader() {
  const c = cur(); if (!c) return;
  avatar($("cAv"), convAv(c)); $("cName").textContent = (c.ttl ? "⏱️ " : "") + convName(c);
  $("cVoice").classList.toggle("hidden", isSelf(c)); $("cVideo").classList.toggle("hidden", isSelf(c));
  if (isSelf(c)) { $("cStatus").textContent = "رسائلك لنفسك — ملاحظات وملفات"; $("composer").classList.remove("hidden"); $("blockedBar").classList.add("hidden"); return; }
  if (c.type === "g") {
    const mem = c.group?.members || [];
    const live = (S.gcallState[c.id] || []).length;
    $("cStatus").textContent = live ? `مكالمة جارية (${live}) — اضغط للانضمام` : mem.map((m) => (m.id === S.me.id ? "أنت" : m.name)).join("، ");
  } else $("cStatus").textContent = c.blocked ? "🚫 محظور" : lastSeen(S.users[c.id]);
  $("composer").classList.toggle("hidden", !!c.blocked);
  $("blockedBar").classList.toggle("hidden", !c.blocked);
}
async function openChat(key, refresh) {
  if (typeof key === "number") key = "u" + key;
  const c = ensureConv(key);
  S.cur = key;
  if (!refresh) {
    S.search = ""; $("chatSearch").classList.add("hidden"); $("csInput").value = "";
    setHeader(); setReply(null); setEdit(null);
    if (S.view === "chat") history.replaceState({ v: "chat" }, ""); else go("chat");
    show("chat"); renderMsgs(true);
  }
  try {
    const reqs = [api("/api/messages?c=" + key)];
    reqs.push(c.type === "u" ? api("/api/user?id=" + c.id) : api("/api/group/info?gid=" + c.id));
    const [d, info] = await Promise.all(reqs);
    if (c.type === "u") { S.users[c.id] = info.user; c.user = info.user; c.blocked = info.blocked; } else ensureConv(key, { group: info.group });
    await decList(d.messages);
    const pending = (S.msgs[key] || []).filter((m) => !m.id);
    S.msgs[key] = d.messages.concat(pending);
    S.more = S.more || {}; S.more[key] = d.messages.length >= 80;
    if (S.cur === key) { setHeader(); renderMsgs(!refresh); }
  } catch {}
  if (S.cur === key) markRead(key);
}
async function loadOlder() {
  const key = S.cur, list = S.msgs[key] || [];
  const first = list.find((m) => m.id > 0); if (!first) return;
  try {
    const d = await api(`/api/messages?c=${key}&before=${first.id}`);
    await decList(d.messages);
    S.msgs[key] = d.messages.concat(list);
    S.more[key] = d.messages.length >= 80;
    const box = $("msgs"), h = box.scrollHeight;
    S.rc[key] = S.msgs[key].length; renderMsgs(); box.scrollTop = box.scrollHeight - h;
  } catch {}
}

// ---------- عرض الرسائل ----------
const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
function linkify(s) {
  return esc(s).replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi, (u) => `<a href="${u}" ${NAT.any ? "" : 'target="_blank" rel="noopener noreferrer"'}>${u}</a>`);
}
function textOf(m) { if (m.kind === "link") return meta(m)?.t ?? ""; return txt(m); }
function bubbleBody(m) {
  if (m.deleted) return "🚫 تم حذف هذه الرسالة";
  const k = m.kind;
  const x = ["file", "voice", "loc", "contact", "link", "game", "sticker", "poll", "vnote"].includes(k) ? meta(m) : null;
  const prog = m.prog !== undefined ? `<div class="prog">${m.prog}%</div>` : "";
  if (k === "voice" && x) return `<div class="mvoice" data-fid="${esc(x.fid)}"><button class="vp">▶</button><div class="vbar"><i></i></div><span>${fmtDur(x.dur || 0)}</span><button class="vspd">${SET.vspeed || 1}×</button></div>${prog}`;
  if (k === "game") return "🎴 دعوة لعبة (لم تعد متاحة)";
  if (k === "sticker" && x) return `<span class="stk big ${esc(x.a || "")}">${esc(x.e || "")}</span>`;
  if (k === "poll" && x) return pollHtml(m, x);
  if (k === "vnote" && x) return `<div class="mvn" data-fid="${esc(x.fid)}"><video playsinline poster="${esc(safeImg(x.thumb) || "")}" ${m.local ? `src="${m.local}"` : ""}></video><span class="play">▶</span><span class="vnd">${fmtDur(x.dur || 0)}</span>${prog}</div>`;
  if (k === "loc" && x) return `<div class="mloc"><div class="mapic">${ICO("mappin")}</div><b>موقع</b><small dir="ltr">${(+x.lat).toFixed(5)}, ${(+x.lng).toFixed(5)}</small><a class="btn sm" href="${mapsUrl(x.lat, x.lng)}" ${NAT.any ? "" : 'target="_blank" rel="noopener"'}>فتح في الخرائط</a></div>`;
  if (k === "contact" && x) return `<div class="mcontact"><div class="av sm" data-cav='${esc(JSON.stringify({ id: x.id, name: x.name, avatar: safeImg(x.avatar) }))}'></div><span><b>${esc(x.name)}</b><small dir="ltr">PIN ${esc(x.pin)}</small></span><button class="btn sm" data-msgto="${esc(x.id)}">مراسلة</button></div>`;
  if (k === "link" && x) {
    const p = x.p || {};
    return `${p.url ? `<a class="lprev" href="${esc(p.url)}" ${NAT.any ? "" : 'target="_blank" rel="noopener"'}>${safeImg(p.img) ? `<img src="${safeImg(p.img)}">` : ""}<b>${esc(p.title || "")}</b><small>${esc((p.desc || "").slice(0, 140))}</small><i>${esc(p.site || "")}</i></a>` : ""}${linkify(x.t || "")}`;
  }
  if (k === "file" && x) {
    const url = FILES.get(x.fid)?.url || m.local;
    if (x.mime?.startsWith("image/")) return `<div style="position:relative"><img class="mimg" data-fid="${esc(x.fid)}" src="${esc(url || safeImg(x.thumb) || "")}">${prog}</div>`;
    if (x.mime?.startsWith("video/")) return `<div class="mvid" data-fid="${esc(x.fid)}" style="position:relative"><img class="mthumb" src="${esc(safeImg(x.thumb) || "")}"><span class="play">▶</span>${prog}</div>`;
    return `<div class="mfile" data-fid="${esc(x.fid)}" style="position:relative"><span class="fi">${ICO("file")}</span><span><b>${esc(x.name)}</b><small>${fmtSize(x.size)}</small></span>${prog}</div>`;
  }
  if (k === "call") return "📞 " + esc(txt(m));
  return mentionsHtml(linkify(txt(m)), S.convs.get(keyOfMsg(m)));
}
const mapsUrl = (lat, lng) => (window.WASEL_PLATFORM === "ios" ? `https://maps.apple.com/?q=${+lat},${+lng}` : `https://www.google.com/maps?q=${+lat},${+lng}`);
const NAME_COLORS = ["#ff8fa3", "#7ee0a1", "#ffd36e", "#7cc8ff", "#c7a6ff", "#ff9e6e", "#6ee7e0", "#f9a8d4"];
function renderMsgs(scroll) {
  const c = cur(); if (!c) return;
  const box = $("msgs"), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const now = Date.now();
  let list = (S.msgs[S.cur] || []).filter((m) => !m.expires || m.expires > now);
  const q = (S.search || "").trim().toLowerCase();
  let html = "";
  if (!q) {
    if (S.more?.[S.cur]) html += '<button class="older" id="olderBtn">تحميل رسائل أقدم</button>';
    html += '<div class="e2e" id="e2eNote">الرسائل والمكالمات والملفات مشفّرة من طرف لطرف. لا أحد غيركم يقدر يقرأها أو يسمعها، ولا حتى السيرفر.' + (c.type === "u" ? " اضغط للتحقق." : "") + "</div>";
  }
  if (q) { list = list.filter((m) => !m.deleted && preview(m).toLowerCase().includes(q)); html += `<div class="day clr"><span>${list.length} نتيجة</span></div>`; }
  let lastDay = "", idx = 0, prevA = null;
  const all = S.msgs[S.cur] || [];
  const prev = (S.rc ||= {})[S.cur] ?? all.length;
  const byId = {}; for (const m of all) if (m.id) byId[m.id] = m;
  for (const m of list) {
    const i = all.indexOf(m);
    const dl = dayLabel(m.ts);
    if (dl !== lastDay) { html += `<div class="day clr"><span>${dl}</span></div>`; lastDay = dl; prevA = null; }
    if (m.kind === "sys") { html += `<div class="sys clr"><span>${esc(m.body)}</span></div>`; prevA = null; continue; }
    const mine = m.a === S.me.id, media = !m.deleted && ["file", "voice", "vnote"].includes(m.kind);
    const bare = !m.deleted && ["sticker", "vnote"].includes(m.kind);
    let head = "";
    if (c.type === "g" && !mine && prevA !== m.a) { const u = S.users[m.a] || {}; head = `<span class="snd" style="color:${NAME_COLORS[m.a % NAME_COLORS.length]}">${esc(u.name || "…")}</span>`; }
    prevA = m.a;
    let rq = "";
    if (m.reply && byId[m.reply]) { const r = byId[m.reply]; rq = `<span class="rq" data-goto="${r.id}"><b>${r.a === S.me.id ? "أنت" : esc(S.users[r.a]?.name || "")}</b>${esc(preview(r)).slice(0, 90)}</span>`; }
    const fw = m.fwd && !m.deleted ? '<span class="fwd">${ICO("forward")} محوّلة</span>' : "";
    const re = m.reacts && Object.keys(m.reacts).length ? `<span class="reacts">${reactSummary(m.reacts)}</span>` : "";
    html += `<div class="b ${i >= prev ? "a " : ""}${mine ? "o" : "i"}${m.kind === "call" ? " call" : ""}${m.deleted ? " del" : ""}${media ? " media" : ""}${bare ? " bare" : ""}${m.kind === "poll" ? " pollb" : ""}${re ? " hasr" : ""}" data-i="${i}" data-id="${m.id || ""}">${head}${fw}${rq}${bubbleBody(m)}<span class="meta">${m.edited ? "معدّلة · " : ""}${m.expires ? "⏱️ " : ""}${hm(m.ts)}${ticks(m)}</span>${re}</div>`;
    idx++;
  }
  S.rc[S.cur] = all.length;
  box.style.setProperty("--bub", bubbleColor(S.cur) || "var(--grad)");
  box.innerHTML = html + '<div class="clr"></div>';
  if ($("olderBtn")) $("olderBtn").onclick = loadOlder;
  for (const el of box.querySelectorAll("[data-cav]")) { try { avatar(el, JSON.parse(el.dataset.cav)); } catch {} }
  if ((scroll || atBottom) && !q) box.scrollTop = box.scrollHeight;
  for (const img of box.querySelectorAll("img.mimg")) {
    const fid = img.dataset.fid;
    if (FILES.get(fid)?.url) continue;
    const m = all.find((x) => meta(x)?.fid === fid);
    if (m && m.id) loadFile(meta(m)).then((f) => { for (const el of document.querySelectorAll(`img.mimg[data-fid="${CSS.escape(fid)}"]`)) el.src = f.url; }).catch(() => img.classList.add("gone"));
  }
}
function reactSummary(r) {
  const cnt = {}; for (const e of Object.values(r)) cnt[e] = (cnt[e] || 0) + 1;
  return Object.entries(cnt).map(([e, n]) => e + (n > 1 ? n : "")).join(" ");
}

// تفاعل مع الفقاعات
(function bubbleEvents() {
  const box = $("msgs");
  const msgOf = (el) => { const b = el.closest(".b"); return b ? (S.msgs[S.cur] || [])[Number(b.dataset.i)] : null; };
  longPress(box, ".b", (b) => { const m = (S.msgs[S.cur] || [])[Number(b.dataset.i)]; if (m) msgActions(m); });
  box.addEventListener("click", async (e) => {
    if (S.lpFired) return;
    if (e.target.closest("#e2eNote")) return cur()?.type === "u" && showInfo();
    const go2 = e.target.closest("[data-goto]"); if (go2) { const el = box.querySelector(`.b[data-id="${go2.dataset.goto}"]`); if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1200); } return; }
    const mt = e.target.closest("[data-msgto]"); if (mt) { const id = Number(mt.dataset.msgto); if (id === S.me.id) return; return openChat("u" + id); }
    if (e.target.closest(".reacts")) { const m = msgOf(e.target); if (m) return showReacts(m); }
    if (e.target.closest("a")) return;
    const m = msgOf(e.target); if (!m || m.deleted) return;
    if (e.target.closest(".vspd")) return cycleSpeed();
    if (m.kind === "poll" && m.id > 0) { const v = e.target.closest("[data-vote]"); if (v) return vote(m, Number(v.dataset.vote)); if (e.target.closest("[data-voters]")) return showVoters(m); return; }
    const x = meta(m); if (!x || !m.id) return;
    if (e.target.closest(".vp")) return playVoice(e.target.closest(".mvoice"), x);
    if (e.target.closest(".mvn")) return playVnote(e.target.closest(".mvn"), x);
    if (e.target.closest(".mimg,.mvid")) return openViewer(x);
    if (e.target.closest(".mfile")) { toast("جارٍ التحميل…"); try { saveFile(await loadFile(x), x); } catch { toast("الملف غير متاح (ربما انتهت صلاحيته)"); } }
  });
})();
function showReacts(m) {
  sheetMenu(Object.entries(m.reacts || {}).map(([uid, e]) => [e, uid == S.me.id ? "أنت (اضغط للإزالة)" : S.users[uid]?.name || "…", () => { if (uid == S.me.id) wsSend({ t: "react", id: m.id, e: "" }); }]), "التفاعلات");
}
const QUICK = ["❤️", "😂", "👍", "😮", "😢", "🙏"];
function msgActions(m) {
  if (m.deleted || !(m.id > 0) || m.kind === "sys") return;
  const mine = m.a === S.me.id;
  const items = [["reply", "رد", () => setReply(m)], ["forward", "تحويل", () => forward(m)]];
  if (["text", "link"].includes(m.kind)) items.push(["copy", "نسخ", () => { navigator.clipboard?.writeText(textOf(m)).then(() => toast("تم النسخ")).catch(() => toast("تعذّر النسخ")); }]);
  if (mine && ["text", "link"].includes(m.kind) && Date.now() - m.ts < 2 * 86400000) items.push(["edit", "تعديل", () => setEdit(m)]);
  if (["file", "vnote"].includes(m.kind)) items.push(["download", "حفظ", async () => { try { saveFile(await loadFile(meta(m)), meta(m)); } catch { toast("تعذّر التحميل"); } }]);
  if (mine) items.push(["trash", "حذف عند الجميع", async () => { if (await ask("حذف الرسالة عند الجميع؟", [], "حذف")) wsSend({ t: "delete", id: m.id }); }, "dz"]);
  const myR = m.reacts?.[S.me.id];
  sheetMenu(items, null, `<div class="qreact">${QUICK.map((e) => `<button data-e="${e}" class="${myR === e ? "on" : ""}">${e}</button>`).join("")}</div>`, (e) => { closeSheets(); wsSend({ t: "react", id: m.id, e: myR === e ? "" : e }); });
}
function setReply(m) {
  S.reply = m || null;
  if (m) setEdit(null);
  $("replyBar").classList.toggle("hidden", !m);
  if (m) { $("rbName").textContent = m.a === S.me.id ? "أنت" : (S.users[m.a]?.name || ""); $("rbText").textContent = preview(m); $("cInput").focus(); }
}
function setEdit(m) {
  S.editing = m || null;
  if (m) { S.reply = null; $("replyBar").classList.remove("hidden"); $("rbName").textContent = "تعديل الرسالة"; $("rbText").textContent = textOf(m); $("cInput").value = textOf(m); $("cInput").focus(); updateSendBtn(); }
  else if (!S.reply) $("replyBar").classList.add("hidden");
}
$("rbX").onclick = () => { if (S.editing) { $("cInput").value = ""; updateSendBtn(); } setReply(null); setEdit(null); };

// ---------- الإرسال ----------
function updateSendBtn() {
  const has = $("cInput").value.trim().length > 0 || REC.on;
  $("cSend").innerHTML = `<svg><use href="#i-${has ? "send" : "mic"}"/></svg>`;
}
function wsTarget(key) { const c = S.convs.get(key); return c.type === "g" ? { gid: c.id } : { to: c.id }; }
async function sendRaw(key, plain, kind = "text", opts = {}) {
  const c = ensureConv(key);
  const cid = Math.random().toString(36).slice(2);
  const m = { cid, a: S.me.id, b: c.type === "u" ? c.id : 0, gid: c.type === "g" ? c.id : null, body: "", text: ["text", "call"].includes(kind) ? plain : undefined, kind, ts: Date.now(), status: 0, reply: opts.reply || null, fwd: opts.fwd ? 1 : 0, meta: opts.meta, local: opts.local };
  pushMsg(key, m);
  if (opts.prog !== undefined) m.prog = opts.prog;
  if (opts.deferSend) return m;
  await finishSend(key, m, plain, kind, opts);
  return m;
}
async function finishSend(key, m, plain, kind, opts = {}) {
  let body;
  try { body = await encFor(key, plain); }
  catch { toast("لا يمكن التشفير: الطرف الآخر يحتاج تحديث التطبيق"); S.msgs[key] = (S.msgs[key] || []).filter((x) => x !== m); if (S.cur === key) renderMsgs(); return; }
  m.kind = kind;
  const q = { t: "send", ...wsTarget(key), body, kind, cid: m.cid, reply: m.reply, fwd: m.fwd };
  (S.queue ||= []).push(q);
  wsSend(q);
}
function flushQueue() { for (const q of S.queue || []) wsSend(q); }

async function sendText(text) {
  const key = S.cur, reply = S.reply?.id || null; setReply(null);
  const url = SET.lp !== false ? (text.match(URL_RE) || [])[0] : null;
  if (!url) return sendRaw(key, text, "text", { reply });
  const m = await sendRaw(key, text, "text", { reply, deferSend: true });
  let p = null;
  try { p = (await Promise.race([api("/api/preview?url=" + encodeURIComponent(url)), new Promise((r) => setTimeout(() => r({}), 4500))])).preview; } catch {}
  if (p) { m.kind = "link"; m.meta = { t: text, p }; m.text = undefined; if (S.cur === key) renderMsgs(); await finishSend(key, m, JSON.stringify({ t: text, p }), "link"); }
  else await finishSend(key, m, text, "text");
}
async function sendEdit(m, text) {
  setEdit(null);
  const key = S.cur;
  let plain = text, kind = "text";
  if (m.kind === "link") { const x = meta(m) || {}; plain = JSON.stringify({ t: text, p: x.p }); kind = "link"; }
  try { wsSend({ t: "edit", id: m.id, body: await encFor(key, plain), kind }); } catch { toast("تعذّر التعديل"); }
}

const inp = $("cInput");
inp.oninput = () => {
  inp.style.height = "auto"; inp.style.height = Math.min(120, inp.scrollHeight) + "px";
  updateSendBtn(); mentionCheck();
  const now = Date.now(); if (now - (S.lastTyp || 0) > 2000 && S.cur) { S.lastTyp = now; wsSend({ t: "typing", ...wsTarget(S.cur) }); }
};
inp.onkeydown = (e) => { if (SET.enter && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("cSend").click(); } };
$("cSend").onclick = () => {
  if (REC.on) return stopRec(true);
  const v = inp.value;
  if (!v.trim()) return startRec();
  inp.value = ""; inp.style.height = "auto"; updateSendBtn(); $("mentionBox").classList.add("hidden"); $("emojiPanel").classList.add("hidden");
  if (S.editing) sendEdit(S.editing, v); else sendText(v);
  inp.focus();
};
$("cBack").onclick = () => history.back();
for (const b of document.querySelectorAll("[data-back]")) b.onclick = () => history.back();
window.onpopstate = () => {
  if (!$("call").classList.contains("hidden") || !$("gcall").classList.contains("hidden")) return;
  if (!$("viewer").classList.contains("hidden")) { closeViewer(); return; }
  if (!$("story").classList.contains("hidden")) { closeStory(); return; }
  const v = history.state?.v || "home";
  if (v === "chat" && S.cur) show("chat");
  else if (VIEWS.includes(v) && v !== "auth" && v !== "chat") { show(v); if (v === "settings") renderSettings(); }
  else { S.cur = null; show("home"); renderChats(); }
};

async function clearChat(c, hide) {
  if (!(await ask(hide ? `حذف الدردشة "${convName(c)}"؟ تُحذف الرسائل من جهازك فقط.` : "مسح كل الرسائل في هذه المحادثة من عندك؟", [], hide ? "حذف" : "مسح"))) return;
  try {
    await api("/api/chat/clear", { c: c.key, hide });
    S.msgs[c.key] = []; S.rc && (S.rc[c.key] = 0); c.unread = 0;
    if (hide) { c.last = null; if (c.type === "u") S.convs.delete(c.key); if (S.cur === c.key) history.back(); }
    else if (S.cur === c.key) renderMsgs();
    renderChats(); toast(hide ? "🗑️ تم حذف الدردشة" : "🧹 تم مسح المحادثة");
  } catch (e) { toast(e.message); }
}

// بحث داخل المحادثة
$("csInput").oninput = () => { S.search = $("csInput").value; renderMsgs(); };
$("csX").onclick = () => { S.search = ""; $("csInput").value = ""; $("chatSearch").classList.add("hidden"); renderMsgs(true); };
function openSearch() { $("chatSearch").classList.remove("hidden"); $("csInput").focus(); }

// تحويل رسالة
async function forward(m) {
  const plain = ["text", "call"].includes(m.kind) ? txt(m) : JSON.stringify(meta(m));
  const kind = m.kind === "call" ? "text" : m.kind;
  const convs = [...S.convs.values()].filter((c) => !c.blocked).sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0)).slice(0, 40);
  sheetMenu(convs.map((c) => [c.type === "g" ? "users" : "user", convName(c), async () => {
    await sendRaw(c.key, plain, kind, { fwd: 1, meta: kind === "text" ? undefined : meta(m) });
    toast("تم التحويل إلى " + convName(c));
  }]), "تحويل إلى…");
}

// معرض الوسائط
async function showMedia() {
  closeSheets();
  $("mediaGrid").innerHTML = '<div class="empty">⏳</div>';
  openSheet("mediaSheet");
  try {
    const d = await api("/api/media?c=" + S.cur);
    await decList(d.messages);
    const items = d.messages.map((m) => ({ m, x: meta(m) })).filter((o) => o.x).reverse();
    if (!items.length) { $("mediaGrid").innerHTML = '<div class="empty">لا توجد وسائط بعد</div>'; return; }
    $("mediaGrid").innerHTML = items.map(({ m, x }, i) => {
      if (m.kind === "voice") return `<button class="mg mgf" data-i="${i}">🎤<small>${fmtDur(x.dur || 0)}</small></button>`;
      if (x.mime?.startsWith("image/") || x.mime?.startsWith("video/")) return `<button class="mg" data-i="${i}" style="background-image:url('${safeImg(x.thumb) || ""}')">${x.mime.startsWith("video/") ? "▶" : ""}</button>`;
      return `<button class="mg mgf" data-i="${i}">📄<small>${esc(x.name).slice(0, 18)}</small></button>`;
    }).join("");
    $("mediaGrid").onclick = async (e) => {
      const b = e.target.closest("[data-i]"); if (!b) return;
      const { m, x } = items[Number(b.dataset.i)];
      if (m.kind === "file" && (x.mime?.startsWith("image/") || x.mime?.startsWith("video/"))) { closeSheets(); openViewer(x); }
      else { try { toast("جارٍ التحميل…"); saveFile(await loadFile(x), x); } catch { toast("الملف غير متاح"); } }
    };
  } catch (e) { $("mediaGrid").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
