// ---------- الأوراق المنبثقة ----------
function openSheet(id) { $(id).classList.remove("hidden"); }
function closeSheets() { for (const s of document.querySelectorAll(".sheet")) s.classList.add("hidden"); }
for (const s of document.querySelectorAll(".sheet")) s.addEventListener("click", (e) => { if (e.target === s || e.target.closest("[data-close]")) { s.classList.add("hidden"); if (s.id === "askSheet" && S.askRes) { S.askRes(null); S.askRes = null; } } });
function ask(title, fields, ok, values = []) {
  $("askT").textContent = title; $("askE").textContent = ""; $("askOk").textContent = ok;
  $("askF").innerHTML = fields.map((f, i) => `<input class="field" data-i="${i}" type="${f.type || "text"}" placeholder="${esc(f.ph)}" ${f.type === "password" ? 'dir="ltr"' : ""} ${f.mode ? `inputmode="${f.mode}"` : ""} maxlength="${f.max || 100}" value="${esc(values[i] || "")}">`).join("");
  openSheet("askSheet");
  setTimeout(() => $("askF").querySelector("input")?.focus(), 80);
  return new Promise((res) => {
    S.askRes = res;
    $("askOk").onclick = () => { const v = [...$("askF").querySelectorAll("input")].map((x) => x.value); $("askSheet").classList.add("hidden"); S.askRes = null; res(v); };
    $("askNo").onclick = () => { $("askSheet").classList.add("hidden"); S.askRes = null; res(null); };
  });
}
// قائمة خيارات عامة
function sheetMenu(items, title, topHtml = "", onTop) {
  $("acts").innerHTML = (title ? `<h3 class="acth">${esc(title)}</h3>` : "") + topHtml + items.map((it, i) => `<button data-a="${i}" class="${it[3] || ""}"><span class="em">${it[0]}</span>${esc(it[1])}</button>`).join("");
  $("acts").onclick = (e) => {
    const t = e.target.closest("[data-e]"); if (t && onTop) return onTop(t.dataset.e);
    const b = e.target.closest("button[data-a]"); if (!b) return; closeSheets(); items[Number(b.dataset.a)][2]();
  };
  openSheet("actSheet");
}

// ---------- معلومات المحادثة (شخص / مجموعة) ----------
const TTL_LABEL = { 0: "إيقاف", 86400: "24 ساعة", 604800: "7 أيام", 7776000: "90 يوماً" };
async function showInfo() {
  const c = cur(); if (!c) return;
  $("infoActs").innerHTML = ""; $("iMembers").innerHTML = ""; $("iSafe").classList.add("hidden");
  avatar($("iAv"), convAv(c)); $("iName").textContent = convName(c);
  const rows = [];
  if (c.type === "u") {
    const u = S.users[c.id] || c.user || {};
    $("iAbout").textContent = u.about || ""; $("iEmail").textContent = u.pin ? "PIN " + u.pin : "";
    $("iSafe").classList.remove("hidden"); $("sNum").innerHTML = "…";
    try { if (!u.pub) await sharedKey(u.id); $("sNum").innerHTML = (await safetyNumber(u.id)).map((g) => `<span>${g}</span>`).join(""); }
    catch { $("sNum").textContent = "هذا المستخدم لم يفعّل التشفير بعد"; }
  } else {
    const g = c.group || {};
    $("iAbout").textContent = `مجموعة · ${(g.members || []).length} أعضاء`; $("iEmail").textContent = "";
    const admin = isAdmin(c);
    $("iMembers").innerHTML = `<h4>الأعضاء</h4>${admin ? '<button class="it" data-add="1"><span class="ic" style="background:#00d1a033">➕</span><span class="tx">إضافة عضو</span></button>' : ""}` +
      (g.members || []).map((m) => `<button class="it" data-mem="${m.id}"><div class="av sm" data-u='${esc(JSON.stringify({ id: m.id, name: m.name, avatar: safeImg(m.avatar) }))}'></div><span class="tx">${m.id === S.me.id ? "أنت" : esc(m.name)}<small>${esc(m.about || "")}</small></span>${m.admin ? '<span class="adm">مشرف</span>' : ""}</button>`).join("");
    for (const el of $("iMembers").querySelectorAll("[data-u]")) avatar(el, JSON.parse(el.dataset.u));
    $("iMembers").onclick = (e) => {
      if (e.target.closest("[data-add]")) return addMember(c);
      const b = e.target.closest("[data-mem]"); if (b) memberActions(c, Number(b.dataset.mem));
    };
    if (admin) rows.push(["✏️", "تعديل الاسم", async () => { const r = await ask("اسم المجموعة", [{ ph: "الاسم", max: 60 }], "حفظ", [g.name]); if (r && r[0].trim()) groupUpdate(c, { name: r[0] }); }], ["🖼️", "تغيير صورة المجموعة", () => { S.avTarget = c; $("fAvatar").click(); }]);
  }
  rows.push(
    ["🖼️", "الوسائط والملفات", showMedia],
    ["🔍", "بحث في المحادثة", () => { closeSheets(); openSearch(); }],
    [c.prefs.muted ? "🔔" : "🔕", c.prefs.muted ? "إلغاء الكتم" : "كتم الإشعارات", () => setPref(c, { muted: !c.prefs.muted })],
    ["⏱️", "الرسائل المختفية: " + TTL_LABEL[c.ttl || 0], () => chooseTTL(c)],
    ["🎨", "لون الفقاعات", () => chooseColor(c)],
    ["⏰", "الرسائل المجدولة", showScheduled],
    ["🧹", "مسح محتوى المحادثة", () => clearChat(c, false)],
  );
  if (isSelf(c)) { /* لا حظر لنفسك */ } else if (c.type === "u") rows.push([c.blocked ? "✅" : "🚫", c.blocked ? "إلغاء الحظر" : "حظر", async () => { if (c.blocked || (await ask(`حظر ${convName(c)}؟ لن يستطيع مراسلتك أو الاتصال بك.`, [], "حظر"))) setBlock(c.id, !c.blocked); }, "dz"]);
  else rows.push(["🚪", "مغادرة المجموعة", async () => { if (await ask("مغادرة المجموعة؟", [], "مغادرة")) { await api("/api/group/remove", { gid: c.id, uid: S.me.id }).catch((e) => toast(e.message)); } }, "dz"]);
  $("infoActs").innerHTML = rows.map((r, i) => `<button class="it ${r[3] || ""}" data-r="${i}"><span class="ic" style="background:#ffffff12">${r[0]}</span><span class="tx">${esc(r[1])}</span></button>`).join("");
  $("infoActs").onclick = (e) => { const b = e.target.closest("[data-r]"); if (b) { const fn = rows[Number(b.dataset.r)][2]; if (!["الوسائط والملفات", "بحث في المحادثة"].includes(rows[Number(b.dataset.r)][1])) closeSheets(); fn(); } };
  $("iCall").classList.toggle("hidden", !!c.blocked || isSelf(c)); $("iVid").classList.toggle("hidden", !!c.blocked || isSelf(c));
  if (isSelf(c)) $("iSafe").classList.add("hidden");
  openSheet("infoSheet");
}
$("cWho").onclick = () => { const c = cur(); if (c?.type === "g" && (S.gcallState[c.id] || []).length && !GC) return joinGroupCall(c.id, false); showInfo(); };
$("cAv").onclick = showInfo;
$("iCall").onclick = () => { closeSheets(); startCall(false); };
$("iVid").onclick = () => { closeSheets(); startCall(true); };
$("blockedBar").onclick = () => { const c = cur(); if (c) setBlock(c.id, false); };

async function setBlock(uid, on) {
  try {
    await api("/api/block", { uid, on });
    const c = S.convs.get("u" + uid); if (c) c.blocked = on;
    toast(on ? "🚫 تم الحظر" : "✅ تم إلغاء الحظر");
    if (S.cur === "u" + uid) setHeader();
    renderChats();
  } catch (e) { toast(e.message); }
}
function chooseTTL(c) {
  sheetMenu(Object.entries(TTL_LABEL).map(([s, l]) => [Number(s) === (c.ttl || 0) ? "✅" : "⏱️", l, async () => {
    try { await api("/api/ttl", { c: c.key, secs: Number(s) }); c.ttl = Number(s); setHeader(); renderChats(); } catch (e) { toast(e.message); }
  }]), "الرسائل المختفية — تُحذف للجميع بعد المدة");
}
async function groupUpdate(c, patch) {
  try { const d = await api("/api/group/update", { gid: c.id, ...patch }); ensureConv(c.key, { group: d.group }); setHeader(); renderChats(); toast("تم الحفظ"); } catch (e) { toast(e.message); }
}
function memberActions(c, uid) {
  if (uid === S.me.id) return;
  const m = (c.group.members || []).find((x) => x.id === uid); if (!m) return;
  const items = [["💬", "مراسلة " + m.name, () => { closeSheets(); openChat("u" + uid); }]];
  if (isAdmin(c)) {
    items.push([m.admin ? "⬇️" : "⭐", m.admin ? "إزالة الإشراف" : "تعيين مشرفاً", () => api("/api/group/admin", { gid: c.id, uid, admin: !m.admin }).then((d) => { ensureConv(c.key, { group: d.group }); showInfo(); }).catch((e) => toast(e.message))]);
    items.push(["➖", "إزالة من المجموعة", async () => { if (await ask(`إزالة ${m.name}؟`, [], "إزالة")) api("/api/group/remove", { gid: c.id, uid }).then(() => loadGroup(c.id)).catch((e) => toast(e.message)); }, "dz"]);
  }
  sheetMenu(items, m.name);
}
async function pickContacts(title, exclude = [], multi = true) {
  let users = [];
  try { users = (await api("/api/contacts")).users.filter((u) => !exclude.includes(u.id)); } catch {}
  return new Promise((res) => {
    $("pickT").textContent = title;
    $("pickList").innerHTML = (users.length ? users.map((u) => `<label class="it"><div class="av sm" data-u='${esc(JSON.stringify({ id: u.id, name: u.name, avatar: safeImg(u.avatar) }))}'></div><span class="tx">${esc(u.name)}<small dir="ltr">${esc(u.pin || "")}</small></span><input type="${multi ? "checkbox" : "radio"}" name="pk" value="${u.id}"></label>`).join("") : '<div class="empty">لا توجد جهات اتصال بعد. راسل أصدقاءك أولاً، أو أضفهم بالكود.</div>') +
      `<div style="display:flex;gap:8px;padding-top:8px"><input class="field pinin" id="pickPin" placeholder="أو اكتب كود PIN" dir="ltr" maxlength="9" style="font-size:17px!important;letter-spacing:3px"></div>`;
    for (const el of $("pickList").querySelectorAll("[data-u]")) avatar(el, JSON.parse(el.dataset.u));
    $("pickPin").oninput = () => { $("pickPin").value = normPin($("pickPin").value); };
    openSheet("pickSheet");
    $("pickOk").onclick = async () => {
      const ids = [...$("pickList").querySelectorAll("input[name=pk]:checked")].map((i) => Number(i.value));
      const pin = normPin($("pickPin").value);
      if (pin.length === 8) { try { const d = await api("/api/find?pin=" + pin); S.users[d.user.id] = d.user; ids.push(d.user.id); } catch (e) { return toast(e.message); } }
      closeSheets(); res(ids);
    };
    $("pickNo").onclick = () => { closeSheets(); res(null); };
  });
}
async function addMember(c) {
  closeSheets();
  const ids = await pickContacts("إضافة أعضاء", memberIds(c));
  if (!ids) return;
  for (const uid of ids) { try { const d = await api("/api/group/add", { gid: c.id, uid }); ensureConv(c.key, { group: d.group }); } catch (e) { toast(e.message); } }
  setHeader(); renderChats();
}

// ---------- إضافة شخص / مجموعة جديدة ----------
const normPin = (v) => v.toUpperCase().replace(/[^0-9A-F]/g, "").slice(0, 8);
$("newChat").onclick = () => {
  if (S.tab === "status") return addStatus();
  sheetMenu([["👤", "إضافة شخص بالكود", newByPin], ["👥", "مجموعة جديدة", newGroup], ["⭐", "الرسائل المحفوظة", openSaved]]);
};
function newByPin() { openSheet("newSheet"); $("nErr").textContent = ""; $("nPin").value = ""; $("nMyPin").textContent = S.me.pin || ""; setTimeout(() => $("nPin").focus(), 50); }
$("nPin").oninput = () => { const v = normPin($("nPin").value); if ($("nPin").value !== v) $("nPin").value = v; if (v.length === 8) $("nGo").focus(); };
$("nPin").onkeydown = (e) => { if (e.key === "Enter") $("nGo").click(); };
$("nGo").onclick = async () => {
  try {
    const pin = normPin($("nPin").value);
    if (pin.length !== 8) throw new Error("الكود يتكون من 8 خانات (أرقام وحروف A-F)");
    const d = await api("/api/find?pin=" + pin);
    if (d.user.id === S.me.id) throw new Error("هذا كودك أنت 🙂");
    S.users[d.user.id] = d.user; closeSheets(); ensureConv("u" + d.user.id, { user: d.user }); openChat("u" + d.user.id);
  } catch (e) { $("nErr").textContent = e.message; }
};
async function newGroup() {
  const r = await ask("👥 مجموعة جديدة", [{ ph: "اسم المجموعة", max: 60 }], "التالي");
  if (!r || !r[0].trim()) return;
  const ids = await pickContacts("اختر الأعضاء");
  if (!ids) return;
  try {
    const d = await api("/api/group/create", { name: r[0], members: ids });
    ensureConv("g" + d.group.id, { group: d.group });
    openChat("g" + d.group.id);
  } catch (e) { toast(e.message); }
}

// ---------- التبويبات ----------
S.tab = "chats";
for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => {
  S.tab = b.dataset.tab;
  for (const x of document.querySelectorAll(".tabs button")) x.classList.toggle("on", x === b);
  $("chatList").classList.toggle("hidden", S.tab !== "chats");
  $("callList").classList.toggle("hidden", S.tab !== "calls");
  $("statusList").classList.toggle("hidden", S.tab !== "status");
  $("newChat").classList.toggle("hidden", S.tab === "calls");
  $("newChat").innerHTML = S.tab === "status" ? '<span style="font-size:24px">📷</span>' : '<svg><use href="#i-plus"/></svg>';
  document.querySelector(".search").classList.toggle("hidden", S.tab !== "chats");
  if (S.tab === "calls") renderCalls();
  if (S.tab === "status") loadStatuses();
};

// ---------- الحالات (تختفي بعد 24 ساعة، مشفّرة لجهات اتصالك فقط) ----------
S.statuses = { mine: [], others: [] };
const ST_BG = ["linear-gradient(135deg,#00d1a0,#00a3ff)", "linear-gradient(135deg,#ff6a88,#ff99ac)", "linear-gradient(135deg,#7b5cff,#30cfd0)", "linear-gradient(135deg,#f6d365,#fda085)", "linear-gradient(135deg,#232526,#414345)", "linear-gradient(135deg,#ff512f,#dd2476)"];
async function loadStatuses() {
  try {
    const d = await api("/api/statuses");
    for (const s of [...d.mine, ...d.others.flatMap((o) => o.items)]) await decEnv(s.uid, s.body);
    for (const o of d.others) S.users[o.user.id] = { ...S.users[o.user.id], ...o.user };
    S.statuses = d;
    renderStatuses();
  } catch {}
}
const stParse = (s) => { try { return JSON.parse(PT.get(s.body)); } catch { return null; } };
function renderStatuses() {
  const d = S.statuses, el = $("statusList");
  let html = `<div class="row" data-st="me"><div class="av stav ${d.mine.length ? "ring seen" : ""}" id="stMeAv"></div><div class="mid"><div class="top"><span class="nm">حالتي</span></div><div class="sub"><span class="pv">${d.mine.length ? `${d.mine.length} حالة · اضغط للعرض` : "اضغط 📷 لإضافة حالة"}</span></div></div><button class="ib" data-add="1">➕</button></div>`;
  if (d.others.length) html += '<h4 class="sth">التحديثات الأخيرة</h4>';
  d.others.sort((a, b) => (a.items.every((i) => i.viewed) - b.items.every((i) => i.viewed)) || b.items.at(-1).ts - a.items.at(-1).ts);
  for (const o of d.others) {
    const seen = o.items.every((i) => i.viewed);
    html += `<div class="row" data-st="${o.user.id}"><div class="av stav ring ${seen ? "seen" : ""}" data-u='${esc(JSON.stringify({ id: o.user.id, name: o.user.name, avatar: safeImg(o.user.avatar) }))}'></div><div class="mid"><div class="top"><span class="nm">${esc(o.user.name)}</span></div><div class="sub"><span class="pv">${shortTime(o.items.at(-1).ts)} · ${o.items.length} حالة</span></div></div></div>`;
  }
  if (!d.others.length) html += '<div class="empty" style="padding-top:40px">لا توجد حالات من أصدقائك.<br>الحالات تختفي بعد 24 ساعة 🕐</div>';
  el.innerHTML = html;
  avatar($("stMeAv"), S.me);
  for (const a of el.querySelectorAll("[data-u]")) avatar(a, JSON.parse(a.dataset.u));
  el.onclick = (e) => {
    if (e.target.closest("[data-add]")) return addStatus();
    const r = e.target.closest("[data-st]"); if (!r) return;
    if (r.dataset.st === "me") { if (d.mine.length) openStory(S.me, d.mine, true); else addStatus(); }
    else { const o = d.others.find((x) => x.user.id == r.dataset.st); if (o) openStory(o.user, o.items, false); }
  };
}
function addStatus() {
  sheetMenu([["📝", "حالة نصية", textStatus], ["🖼️", "صورة", () => $("fStatus").click()]], "حالة جديدة — تظهر لجهات اتصالك 24 ساعة");
}
async function statusRecipients() { try { return (await api("/api/contacts")).users.map((u) => { S.users[u.id] = { ...S.users[u.id], ...u }; return u.id; }); } catch { return []; } }
async function postStatus(obj, kind) {
  const to = await statusRecipients();
  if (!to.length) toast("ستظهر حالتك فقط لمن تراسلهم");
  const body = await encEnv(to, JSON.stringify(obj));
  await api("/api/status", { body, kind, to });
  toast("✅ تم نشر الحالة"); loadStatuses();
}
async function textStatus() {
  const r = await ask("📝 حالة نصية", [{ ph: "اكتب شيئاً…", max: 300 }], "نشر");
  if (!r || !r[0].trim()) return;
  try { await postStatus({ type: "text", text: r[0].trim(), bg: Math.floor(Math.random() * ST_BG.length) }, "text"); } catch (e) { toast(e.message); }
}
$("fStatus").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    toast("⏫ جارٍ الرفع…");
    const dataUrl = await resizeImage(f, 1280, false, 0.82);
    const blob = await (await fetch(dataUrl)).blob();
    const up = await uploadEncrypted(blob);
    const cap = await ask("تعليق (اختياري)", [{ ph: "تعليق", max: 200 }], "نشر");
    if (cap === null) return;
    await postStatus({ type: "image", ...up, mime: "image/jpeg", cap: cap[0] || "", thumb: await resizeImage(f, 64, false, 0.5) }, "image");
  } catch (er) { toast(er.message || "فشل الرفع"); }
};
let ST = null;
function openStory(user, items, mine) {
  ST = { user, items, mine, i: Math.max(0, mine ? 0 : items.findIndex((x) => !x.viewed)) };
  if (ST.i < 0) ST.i = 0;
  $("story").classList.remove("hidden");
  history.pushState({ v: S.view, story: 1 }, "");
  avatar($("stAv"), user); $("stName").textContent = mine ? "حالتي" : user.name;
  showStoryItem();
}
async function showStoryItem() {
  clearTimeout(ST?.t);
  if (!ST) return;
  const s = ST.items[ST.i]; if (!s) return history.back();
  $("stBars").innerHTML = ST.items.map((_, i) => `<i class="${i < ST.i ? "done" : ""}"><b class="${i === ST.i ? "run" : ""}"></b></i>`).join("");
  $("stTime").textContent = shortTime(s.ts) + " " + hm(s.ts);
  const o = stParse(s);
  const body = $("stBody");
  $("stFoot").innerHTML = ST.mine ? `<button class="link" id="stViews">👁️ ${s.views.length}</button><button class="link" id="stDel" style="color:var(--red)">🗑️ حذف</button>` : "";
  if (!o) body.innerHTML = '<div class="sttext" style="background:#222">🔒 تعذّر فك التشفير</div>';
  else if (o.type === "text") body.innerHTML = `<div class="sttext" style="background:${ST_BG[o.bg % ST_BG.length]}">${esc(o.text)}</div>`;
  else {
    body.innerHTML = `<img class="stimg" src="${safeImg(o.thumb) || ""}">${o.cap ? `<div class="stcap">${esc(o.cap)}</div>` : ""}`;
    try { const f = await loadFile({ ...o, name: "status.jpg" }); if (ST && ST.items[ST.i] === s) body.querySelector("img").src = f.url; } catch {}
  }
  const bar = $("stBars").querySelector(".run");
  if (bar) { bar.style.animation = "none"; void bar.offsetWidth; bar.style.animation = ""; }
  ST.t = setTimeout(() => { if (ST) { ST.i++; showStoryItem(); } }, 5500);
  if (!ST.mine && !s.viewed) { s.viewed = 1; api("/api/status/view", { sid: s.id }).catch(() => {}); }
  if (ST.mine) {
    $("stViews").onclick = (e) => { e.stopPropagation(); clearTimeout(ST.t); sheetMenu(s.views.map((u) => ["👁️", u.name, () => {}]), s.views.length ? "شاهدها" : "لم يشاهدها أحد بعد"); };
    $("stDel").onclick = async (e) => { e.stopPropagation(); clearTimeout(ST.t); if (!(await ask("حذف هذه الحالة؟", [], "حذف"))) return; await api("/api/status/delete", { sid: s.id }); ST.items.splice(ST.i, 1); if (!ST.items.length) history.back(); else showStoryItem(); loadStatuses(); };
  }
}
function closeStory() { clearTimeout(ST?.t); ST = null; $("story").classList.add("hidden"); $("stBody").innerHTML = ""; renderStatuses(); }
$("story").onclick = (e) => {
  if (!ST || e.target.closest("#stFoot") || e.target.closest("#stX")) return;
  const left = e.clientX < window.innerWidth / 2;
  ST.i += left ? 1 : -1; // RTL: اليسار = التالي
  if (ST.i < 0) ST.i = 0;
  showStoryItem();
};
$("stX").onclick = (e) => { e.stopPropagation(); history.back(); };

