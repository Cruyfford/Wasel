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
// رفع ملف مشفّر (يُستخدم للرسائل والحالات)
async function uploadEncrypted(blob, onProg) {
  const fid = randHexJS(16);
  const key = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ck = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ck, await blob.arrayBuffer()));
  const n = Math.ceil(ct.length / CHUNK);
  for (let i = 0; i < n; i++) {
    const r = await fetch(`${API}/api/upload?id=${fid}&i=${i}`, { method: "POST", headers: { authorization: "Bearer " + S.token }, body: ct.subarray(i * CHUNK, (i + 1) * CHUNK) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "upload");
    onProg && onProg(Math.round(((i + 1) / n) * 100));
  }
  return { fid, k: b64(key), iv: b64(iv), n };
}
async function sendFile(file, kind = "file", extra = {}) {
  const key = S.cur; if (!key) return;
  if (file.size > 58 * 1048576) return toast("الحد الأقصى للملف 58MB");
  const th = kind === "file" ? await makeThumb(file) : null;
  const x = { name: file.name || "file", mime: file.type || "application/octet-stream", size: file.size, ...(th || {}), ...extra };
  const local = URL.createObjectURL(file);
  x.fid = "local-" + randHexJS(6);
  const m = await sendRaw(key, "", kind, { meta: x, local, prog: 0, deferSend: true, reply: S.reply?.id || null });
  setReply(null);
  try {
    const up = await uploadEncrypted(file, (p) => {
      m.prog = p;
      if (S.cur === key) { const el = document.querySelector(`.b[data-i="${(S.msgs[key] || []).indexOf(m)}"] .prog`); if (el) el.textContent = p + "%"; }
    });
    Object.assign(x, up);
    FILES.set(x.fid, { url: local, blob: file });
    delete m.prog;
    await finishSend(key, m, JSON.stringify(x), kind);
    if (S.cur === key) renderMsgs();
  } catch (e) {
    S.msgs[key] = (S.msgs[key] || []).filter((y) => y !== m); if (S.cur === key) renderMsgs();
    toast("فشل رفع الملف" + (e.message && e.message !== "upload" ? ": " + e.message : ""));
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
$("cAttach").onclick = () => sheetMenu([
  ["🖼️", "صور وفيديو", () => $("fMedia").click()],
  ["📸", "الكاميرا", () => $("fCam").click()],
  ["📄", "ملف", () => $("fAny").click()],
  ["📍", "موقعي", sendLocation],
  ["👤", "جهة اتصال", sendContact],
]);
for (const id of ["fMedia", "fAny", "fCam"]) $(id).onchange = async (e) => { const fs = [...e.target.files]; e.target.value = ""; for (const f of fs) await sendFile(f); };
function sendLocation() {
  if (!navigator.geolocation) return toast("الموقع غير متاح");
  toast("📍 جارٍ تحديد موقعك…");
  const key = S.cur;
  navigator.geolocation.getCurrentPosition(
    (p) => { const x = { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) }; sendRaw(key, JSON.stringify(x), "loc", { meta: x }); },
    () => toast("اسمح للتطبيق بالوصول إلى الموقع"),
    { enableHighAccuracy: true, timeout: 15000 });
}
async function sendContact() {
  const key = S.cur;
  let users = [];
  try { users = (await api("/api/contacts")).users; } catch {}
  users = [S.me, ...users.filter((u) => u.id !== (cur()?.type === "u" ? cur().id : -1))];
  sheetMenu(users.map((u) => ["👤", u.id === S.me.id ? "أنا (" + u.name + ")" : u.name, () => {
    const x = { id: u.id, name: u.name, pin: u.pin, avatar: u.avatar || null };
    sendRaw(key, JSON.stringify(x), "contact", { meta: x });
  }]), "مشاركة جهة اتصال");
}

// ---------- الرسائل الصوتية ----------
const REC = { on: false };
async function startRec() {
  if (!S.cur) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    Object.assign(REC, { on: true, rec, stream, chunks: [], t0: Date.now(), mime: rec.mimeType || mime || "audio/mp4" });
    rec.ondataavailable = (e) => e.data.size && REC.chunks.push(e.data);
    rec.start(250);
    $("cInput").classList.add("hidden"); $("cAttach").classList.add("hidden"); $("recBox").classList.remove("hidden");
    updateSendBtn();
    REC.timer = setInterval(() => { $("recT").textContent = fmtDur((Date.now() - REC.t0) / 1000); wsSend({ t: "typing", ...wsTarget(S.cur), rec: true }); }, 1000);
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

