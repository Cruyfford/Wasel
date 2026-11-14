// ---------- مفتاح الاسترجاع (24 كلمة) ----------
function genWords() { return Array.from(crypto.getRandomValues(new Uint16Array(24)), (x) => WORDS[x % 2048]); }
const normWords = (s) => String(s).toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
async function recAuth(email, words) {
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: TE.encode("wasel-rec-auth:" + email.trim().toLowerCase()), iterations: 200000 }, await pwKey(words.join(" ")), 256);
  return b64(bits);
}
async function setupRecovery() {
  const words = genWords();
  $("recWords").innerHTML = words.map((w, i) => `<span><i>${i + 1}</i>${w}</span>`).join("");
  openSheet("recSheet");
  $("recCopy").onclick = () => navigator.clipboard?.writeText(words.join(" ")).then(() => toast("تم النسخ — احفظها في مكان آمن")).catch(() => {});
  $("recOk").onclick = async () => {
    const idx = [3, 11, 20].map((n) => n + Math.floor(Math.random() * 3));
    closeSheets();
    const r = await ask("للتأكد أنك حفظتها: اكتب الكلمات", idx.map((i) => ({ ph: `الكلمة رقم ${i + 1}`, max: 20 })), "تأكيد");
    if (!r) return;
    if (r.some((v, k) => v.trim().toLowerCase() !== words[idx[k]])) { toast("غير مطابقة، حاول مرة أخرى"); return setupRecovery(); }
    try {
      toast("جارٍ الحفظ…");
      await api("/api/recovery/set", { rauth: await recAuth(S.me.email, words), rbackup: await makeBackup(words.join(" "), localStorage.getItem("w_priv")) });
      SET.recDone = true; saveSet(); renderSecurity(); toast("تم حفظ مفتاح الاسترجاع");
    } catch (e) { toast(e.message); }
  };
}
$("aForgot").onclick = async () => {
  const r = await ask("🔑 استرجاع الحساب", [{ ph: "البريد الإلكتروني", type: "email", max: 120 }, { ph: "الكلمات الـ 24 مفصولة بمسافات", max: 400 }, { ph: "كلمة مرور جديدة", type: "password" }, { ph: "أعد كتابتها", type: "password" }], "استرجاع");
  if (!r) return;
  const [email, ws, p1, p2] = r, words = normWords(ws);
  if (words.length !== 24) return toast("يجب إدخال 24 كلمة");
  if (p1.length < 6 || p1 !== p2) return toast("كلمة المرور قصيرة أو غير متطابقة");
  try {
    toast("جارٍ التحقق…");
    const s1 = await api("/api/recover/start", { email, rauth: await recAuth(email, words) });
    const priv = await openBackup(words.join(" "), s1.rbackup);
    const d = await api("/api/recover/finish", { token: s1.token, password: await authKey(email, p1), backup: await makeBackup(p1, priv) });
    localStorage.setItem("w_priv", priv); PRIV = null;
    S.token = d.token; S.me = d.user;
    localStorage.setItem("w_token", d.token); localStorage.setItem("w_me", JSON.stringify(d.user));
    toast("تم استرجاع حسابك"); start();
  } catch (e) { toast(e.message.includes("decrypt") || e.name === "OperationError" ? "الكلمات غير صحيحة" : e.message); }
};

// ---------- ربط الكمبيوتر بمسح QR ----------
const loadScript = (src) => new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.append(s); });
async function linkShared(priv, pubB64) {
  const pk = await crypto.subtle.importKey("raw", ub64(pubB64), EC, false, []);
  return crypto.subtle.deriveKey({ name: "ECDH", public: pk }, priv, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
$("aQR").onclick = async () => {
  try {
    await loadScript("/lib/qr.js");
    const kp = await crypto.subtle.generateKey(EC, true, ["deriveKey"]);
    const pub = b64(await crypto.subtle.exportKey("raw", kp.publicKey));
    const { lid } = await api("/api/link/new", {});
    const qr = qrcode(0, "M"); qr.addData(`WASEL:${lid}:${pub}`); qr.make();
    $("qrBox").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
    openSheet("qrSheet");
    clearInterval(S.linkT);
    const t0 = Date.now();
    S.linkT = setInterval(async () => {
      if ($("qrSheet").classList.contains("hidden") || Date.now() - t0 > 175000) { clearInterval(S.linkT); if (Date.now() - t0 > 175000) $("qrBox").innerHTML = '<div class="empty">انتهت صلاحية الرمز — أعد المحاولة</div>'; return; }
      const r = await fetch(`${API}/api/link/poll?lid=${lid}`).then((x) => x.json()).catch(() => ({}));
      if (!r.token) return;
      clearInterval(S.linkT);
      const [iv, ct] = r.payload.split(":");
      const key = await linkShared(kp.privateKey, r.epub);
      const data = JSON.parse(TD.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(iv) }, key, ub64(ct))));
      localStorage.setItem("w_priv", data.priv); PRIV = null;
      S.token = r.token; S.me = r.user;
      localStorage.setItem("w_token", r.token); localStorage.setItem("w_me", JSON.stringify(r.user));
      closeSheets(); toast("تم ربط هذا الجهاز"); start();
    }, 2000);
  } catch (e) { toast(e.message || "تعذّر إنشاء الرمز"); }
};
async function approveLink(lid, pcPub) {
  try {
    const kp = await crypto.subtle.generateKey(EC, true, ["deriveKey"]);
    const key = await linkShared(kp.privateKey, pcPub);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, TE.encode(JSON.stringify({ priv: localStorage.getItem("w_priv") })));
    await api("/api/link/approve", { lid, epub: b64(await crypto.subtle.exportKey("raw", kp.publicKey)), payload: b64(iv) + ":" + b64(ct) });
    toast("تم ربط الجهاز");
  } catch (e) { toast(e.message); }
}
async function scanQR() {
  try { await loadScript("/lib/jsqr.js"); } catch { return toast("تعذّر تحميل الماسح"); }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); } catch { return toast("اسمح باستخدام الكاميرا"); }
  $("scanner").classList.remove("hidden");
  const v = $("scanVid"); v.srcObject = stream; await v.play().catch(() => {});
  const cv = document.createElement("canvas"), cx = cv.getContext("2d", { willReadFrequently: true });
  let done = false;
  const stop = () => { done = true; stream.getTracks().forEach((t) => t.stop()); $("scanner").classList.add("hidden"); };
  $("scanX").onclick = stop;
  const tick = async () => {
    if (done) return;
    if (v.videoWidth) {
      cv.width = v.videoWidth; cv.height = v.videoHeight; cx.drawImage(v, 0, 0);
      const code = jsQR(cx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height);
      const m = code && /^WASEL:([a-f0-9]{32}):([A-Za-z0-9+/=]{80,100})$/.exec(code.data);
      if (m) {
        stop();
        if (!(await ask("ربط جهاز جديد بحسابك؟ سيتمكن من قراءة رسائلك.", [], "ربط"))) return;
        approveLink(m[1], m[2]);
        return;
      }
    }
    requestAnimationFrame(tick);
  };
  tick();
}

// ---------- إشعار تحديث التطبيق ----------
async function checkUpdate() {
  if (!NAT.any) return;
  try {
    const v = await (await fetch(API + "/api/version")).json();
    const mine = window.WASEL_REV || (NAT.android && window.WaselNative.rev ? window.WaselNative.rev() : null);
    if (v.rev && mine !== v.rev && sessionStorage.getItem("updDismiss") !== v.rev) {
      $("updBar").classList.remove("hidden");
      $("updBar").href = v.url;
      $("updX").onclick = (e) => { e.preventDefault(); e.stopPropagation(); sessionStorage.setItem("updDismiss", v.rev); $("updBar").classList.add("hidden"); };
    }
  } catch {}
}

// ---------- الإيموجي والملصقات ----------
const EMOJIS = "😀😃😄😁😆😅😂🤣😊😇🙂😉😌😍🥰😘😗😋😛😜🤪😎🤩🥳😏😒😞😔😟😕🙁😣😖😫😩🥺😢😭😤😠😡🤬🤯😳🥵🥶😱😨😰😥😓🤗🤔🤭🤫🤥😶😐😑😬🙄😯😦😧😮😲🥱😴🤤😪😵🤐🥴🤢🤮🤧😷🤒🤕🤑🤠😈👿👻💀👽🤖💩😺😸😹😻😼😽🙀😿😾👋🤚✋🖖👌🤌🤏✌️🤞🤟🤘🤙👈👉👆👇☝️👍👎✊👊🤛🤜👏🙌👐🤲🤝🙏💪❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝🔥✨⭐🌟💫🎉🎊🎁🎂🌹🌸🌺🌻🌙☀️⚽🏆🎮🎧📱💻📷☕🍕🍔🍟🍩🍰🍫🍉🍓🚗✈️🏠🕌📿🤲🇧🇭🇸🇦🇦🇪🇰🇼🇶🇦🇴🇲".match(/\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*|\p{Regional_Indicator}{2}/gu) || [];
const STICKERS = [["😂", "bounce"], ["❤️", "pulse"], ["🔥", "wiggle"], ["👍", "bounce"], ["🥳", "spin"], ["😍", "pulse"], ["😭", "wiggle"], ["🤣", "spin"], ["😎", "bounce"], ["👋", "wave"], ["🙏", "pulse"], ["💯", "bounce"], ["🎉", "spin"], ["😡", "wiggle"], ["🤔", "wave"], ["😴", "pulse"], ["🤯", "bounce"], ["👏", "wave"], ["🌹", "pulse"], ["⚽", "spin"], ["☕", "wiggle"], ["🫡", "wave"], ["💪", "bounce"], ["🤝", "pulse"]];
$("cEmoji").onclick = () => {
  const p = $("emojiPanel");
  if (!p.classList.contains("hidden")) return p.classList.add("hidden");
  p.classList.remove("hidden"); emojiTab(S.emTab || "e");
};
function emojiTab(t) {
  S.emTab = t;
  for (const b of $("emTabs").children) b.classList.toggle("on", b.dataset.t === t);
  $("emGrid").className = t === "s" ? "emgrid st" : "emgrid";
  $("emGrid").innerHTML = t === "s" ? STICKERS.map(([e, a], i) => `<button data-s="${i}"><span class="stk ${a}">${e}</span></button>`).join("") : EMOJIS.map((e) => `<button data-e="${e}">${e}</button>`).join("");
}
$("emTabs").onclick = (e) => { const t = e.target.dataset.t; if (t) emojiTab(t); };
$("emGrid").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.e) { const i = $("cInput"); const p = i.selectionStart ?? i.value.length; i.value = i.value.slice(0, p) + b.dataset.e + i.value.slice(p); i.selectionStart = i.selectionEnd = p + b.dataset.e.length; i.dispatchEvent(new Event("input")); }
  if (b.dataset.s) { const [em, an] = STICKERS[Number(b.dataset.s)]; const x = { e: em, a: an }; sendRaw(S.cur, JSON.stringify(x), "sticker", { meta: x }); $("emojiPanel").classList.add("hidden"); }
};

// ---------- الاستطلاعات ----------
async function newPoll() {
  const key = S.cur;
  const r = await ask("📊 استطلاع جديد", [{ ph: "السؤال", max: 200 }, ...[1, 2, 3, 4, 5, 6].map((n) => ({ ph: `خيار ${n}${n > 2 ? " (اختياري)" : ""}`, max: 80 }))], "التالي");
  if (!r) return;
  const q = r[0].trim(), o = r.slice(1).map((x) => x.trim()).filter(Boolean);
  if (!q || o.length < 2) return toast("اكتب سؤالاً وخيارين على الأقل");
  sheetMenu([["dot", "اختيار واحد", () => send(false)], ["circle-check", "عدة اختيارات", () => send(true)]], "طريقة التصويت");
  function send(multi) { const x = { q, o, multi }; sendRaw(key, JSON.stringify(x), "poll", { meta: x }); }
}
function pollHtml(m, x) {
  const votes = m.votes || {};
  const total = Object.keys(votes).length;
  const mine = votes[S.me.id] || [];
  const counts = x.o.map((_, i) => Object.values(votes).filter((v) => v.includes(i)).length);
  return `<div class="poll"><b>📊 ${esc(x.q)}</b><small>${x.multi ? "اختر خياراً أو أكثر" : "اختر خياراً واحداً"}</small>` +
    x.o.map((o, i) => { const pct = total ? Math.round((counts[i] / total) * 100) : 0; return `<button class="popt ${mine.includes(i) ? "on" : ""}" data-vote="${i}"><span class="pbar" style="width:${pct}%"></span><span class="pchk">${mine.includes(i) ? "✓" : ""}</span><span class="ptx">${esc(o)}</span><span class="pct">${counts[i]}</span></button>`; }).join("") +
    `<button class="link pvw" data-voters="1">${total} ${total === 1 ? "صوت" : "أصوات"} · عرض</button></div>`;
}
function vote(m, i) {
  const x = meta(m); if (!x) return;
  let mine = [...((m.votes || {})[S.me.id] || [])];
  if (x.multi) mine = mine.includes(i) ? mine.filter((y) => y !== i) : [...mine, i];
  else mine = mine.includes(i) ? [] : [i];
  wsSend({ t: "vote", id: m.id, opts: mine });
}
function showVoters(m) {
  const x = meta(m); const votes = m.votes || {};
  const items = [];
  x.o.forEach((o, i) => { const names = Object.entries(votes).filter(([, v]) => v.includes(i)).map(([u]) => (u == S.me.id ? "أنت" : S.users[u]?.name || "…")); items.push(["dot", `${o}: ${names.join("، ") || "—"}`, () => {}]); });
  sheetMenu(items, x.q);
}

// ---------- الإشارة @ في المجموعات ----------
function mentionCheck() {
  const c = cur(), box = $("mentionBox");
  if (!c || c.type !== "g") return box.classList.add("hidden");
  const i = $("cInput"), before = i.value.slice(0, i.selectionStart);
  const mm = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!mm) return box.classList.add("hidden");
  const q = mm[2].toLowerCase();
  const list = (c.group.members || []).filter((m) => m.id !== S.me.id && m.name.toLowerCase().includes(q)).slice(0, 6);
  if (!list.length) return box.classList.add("hidden");
  box.innerHTML = list.map((m) => `<button data-n="${esc(m.name)}"><span class="av sm" data-u='${esc(JSON.stringify({ id: m.id, name: m.name, avatar: safeImg(m.avatar) }))}'></span>${esc(m.name)}</button>`).join("");
  for (const el of box.querySelectorAll("[data-u]")) avatar(el, JSON.parse(el.dataset.u));
  box.classList.remove("hidden");
  box.onclick = (e) => {
    const b = e.target.closest("[data-n]"); if (!b) return;
    const name = b.dataset.n.replace(/\s+/g, "_");
    const start = before.length - mm[2].length - 1;
    i.value = i.value.slice(0, start) + "@" + name + " " + i.value.slice(i.selectionStart);
    i.selectionStart = i.selectionEnd = start + name.length + 2;
    box.classList.add("hidden"); i.focus();
  };
}
function mentionsHtml(html, c) {
  if (!c || c.type !== "g") return html;
  for (const m of c.group?.members || []) {
    const tag = "@" + m.name.replace(/\s+/g, "_");
    html = html.split(esc(tag)).join(`<span class="mention${m.id === S.me.id ? " me" : ""}">${esc(tag)}</span>`);
  }
  return html;
}
const mentionsMe = (text, c) => c?.type === "g" && text && text.includes("@" + S.me.name.replace(/\s+/g, "_"));

// ---------- رسائل الفيديو الدائرية ----------
async function videoNote() {
  const key = S.cur;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 480 } }, audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { return toast("اسمح باستخدام الكاميرا والمايك"); }
  const ov = $("vnote"), v = $("vnVid");
  ov.classList.remove("hidden"); v.srcObject = stream; v.play().catch(() => {});
  const mime = ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp8,opus", "video/webm"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
  let rec = null, chunks = [], t0 = 0, timer = null;
  const close = () => { clearInterval(timer); try { rec && rec.state !== "inactive" && rec.stop(); } catch {} stream.getTracks().forEach((t) => t.stop()); ov.classList.add("hidden"); $("vnRec").classList.remove("on"); $("vnT").textContent = "0:00"; $("vnRing").style.strokeDashoffset = 0; };
  $("vnX").onclick = () => { rec = null; close(); };
  $("vnRec").onclick = () => {
    if (!rec) {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 900000 } : undefined);
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        if (!chunks.length) return;
        const dur = (Date.now() - t0) / 1000;
        const type = (rec.mimeType || mime || "video/mp4").split(";")[0];
        const f = new File([new Blob(chunks, { type })], "vnote." + (type.includes("webm") ? "webm" : "mp4"), { type });
        S.cur = key; sendFile(f, "vnote", { dur });
      };
      rec.start(500); t0 = Date.now(); $("vnRec").classList.add("on");
      timer = setInterval(() => { const s = (Date.now() - t0) / 1000; $("vnT").textContent = fmtDur(s); $("vnRing").style.strokeDashoffset = 754 * (1 - Math.min(1, s / 60)) - 754; if (s >= 60) $("vnRec").click(); }, 200);
    } else { clearInterval(timer); rec.stop(); stream.getTracks().forEach((t) => t.stop()); ov.classList.add("hidden"); $("vnRec").classList.remove("on"); }
  };
}
async function playVnote(el, x) {
  const v = el.querySelector("video");
  if (v.dataset.ready) { if (v.paused) { v.muted = false; v.play(); } else v.pause(); return; }
  el.classList.add("loading");
  try { const f = await loadFile(x); v.src = f.url; v.dataset.ready = 1; v.muted = false; v.loop = false; await v.play(); } catch { toast("الفيديو غير متاح"); }
  el.classList.remove("loading");
}

// ---------- جدولة الرسائل ----------
async function scheduleMsg() {
  const key = S.cur;
  const d = new Date(Date.now() + 3600000); d.setSeconds(0, 0);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const r = await ask("⏰ جدولة رسالة", [{ ph: "نص الرسالة", max: 2000 }, { ph: "الوقت", type: "datetime-local" }], "جدولة", ["", local]);
  if (!r || !r[0].trim()) return;
  const at = new Date(r[1]).getTime();
  if (!(at > Date.now() + 30000)) return toast("اختر وقتاً في المستقبل");
  try { wsSend({ t: "schedule", ...wsTarget(key), body: await encFor(key, r[0]), kind: "text", at, cid: "s" + Date.now() }); }
  catch { toast("تعذّر التشفير"); }
}
async function showScheduled() {
  const key = S.cur;
  try {
    const d = await api("/api/scheduled?c=" + key);
    const items = [];
    for (const s of d.items) {
      const t = await decMsg({ ...s, gid: s.gid || null, a: S.me.id, b: s.b });
      items.push(["clock", `${new Date(s.at).toLocaleString("ar", { dateStyle: "short", timeStyle: "short" })} — ${String(t).slice(0, 50)}`, async () => { if (await ask("إلغاء هذه الرسالة المجدولة؟", [], "إلغاء الجدولة")) { await api("/api/scheduled/cancel", { id: s.id }); toast("تم الإلغاء"); } }]);
    }
    sheetMenu(items.length ? items : [["inbox", "لا توجد رسائل مجدولة", () => {}]], "الرسائل المجدولة (اضغط للإلغاء)");
  } catch (e) { toast(e.message); }
}

// ---------- ألوان المحادثة ----------
const BUB = ["linear-gradient(135deg,#00d1a0,#00a3ff)", "linear-gradient(135deg,#7b5cff,#c86dd7)", "linear-gradient(135deg,#ff6a88,#ff8e53)", "linear-gradient(135deg,#11998e,#38ef7d)", "linear-gradient(135deg,#f7971e,#ffd200)", "linear-gradient(135deg,#4facfe,#00f2fe)", "linear-gradient(135deg,#434343,#000000)", "linear-gradient(135deg,#e53935,#8e24aa)"];
function chooseColor(c) {
  const html = `<div class="bubpick">${BUB.map((g, i) => `<button data-e="${i}" style="background:${g}" class="${(SET.colors || {})[c.key] === i ? "on" : ""}"></button>`).join("")}</div>`;
  sheetMenu([["reply", "اللون الافتراضي", () => { delete (SET.colors ||= {})[c.key]; saveSet(); renderMsgs(); }]], "لون الفقاعات لهذه المحادثة", html, (i) => { (SET.colors ||= {})[c.key] = Number(i); saveSet(); closeSheets(); renderMsgs(); });
}
const bubbleColor = (key) => { const i = (SET.colors || {})[key]; return i !== undefined ? BUB[i] : ""; };

// ---------- الرسائل المحفوظة ----------
const isSelf = (c) => c && c.type === "u" && c.id === S.me?.id;
function openSaved() { ensureConv("u" + S.me.id, { user: S.me }); openChat("u" + S.me.id); }

// سرعة الرسائل الصوتية
function cycleSpeed(btn) {
  const sp = [1, 1.5, 2]; SET.vspeed = sp[(sp.indexOf(SET.vspeed || 1) + 1) % 3]; saveSet();
  for (const b of document.querySelectorAll(".vspd")) b.textContent = SET.vspeed + "×";
  if (VA) VA.playbackRate = SET.vspeed;
}
