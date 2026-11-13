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
  const pc = new RTCPeerConnection({ iceServers: servers, iceCandidatePoolSize: 4, bundlePolicy: "max-bundle" });
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
    if (s === "disconnected") {
      $("kState").textContent = "إعادة الاتصال…";
      clearTimeout(C.dcT);
      C.dcT = setTimeout(() => { if (C && C.pc === pc && pc.connectionState !== "connected" && C.out) restartIce(); }, 3000);
    }
  };
  return pc;
}
async function restartIce() {
  try { const o = await C.pc.createOffer({ iceRestart: true }); await C.pc.setLocalDescription(o); sig({ kind: "reoffer", sdp: o.sdp }); } catch {}
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
async function startCall(video, uid) {
  if (!uid) { const c = cur(); if (!c) return; if (c.type === "g") return startGroupCall(c.id, video); if (c.blocked) return toast("ألغِ الحظر أولاً"); uid = c.id; }
  if (C || GC) return;
  if (!S.wsOk) return toast("غير متصل بالسيرفر");
  const peer = uid;
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
      C.slowT = setTimeout(() => { if (C && C.state === "connecting") $("kState").textContent = "الشبكة بطيئة في التوصيل…"; }, 8000);
      await C.pc.setRemoteDescription({ type: "answer", sdp: d.sdp });
      for (const c of C.pendingIce) C.pc.addIceCandidate(c).catch(() => {});
      C.pendingIce = [];
      break;
    case "reoffer":
      if (C.pc) { await C.pc.setRemoteDescription({ type: "offer", sdp: d.sdp }); const a = await C.pc.createAnswer(); await C.pc.setLocalDescription(a); sig({ kind: "reanswer", sdp: a.sdp }); }
      break;
    case "reanswer":
      if (C.pc) await C.pc.setRemoteDescription({ type: "answer", sdp: d.sdp });
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
  if (C.out) sendRaw("u" + C.peer, (C.video ? "مكالمة فيديو" : "مكالمة صوتية") + (dur ? " • " + fmtDur(dur) : " • لم يتم الرد"), "call");
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
    r.onclick = () => { S.users[u.id] ||= u; startCall(c.video, u.id); };
    el.append(r);
  }
}

