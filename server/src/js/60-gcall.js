// ---------- المكالمات الجماعية (حتى 8 أشخاص، كل اثنين متصلان مباشرة ومشفّران) ----------
let GC = null;
S.gcallState = {};
S.gring = null;

function gTile(uid) {
  let t = document.querySelector(`#gGrid .gt[data-uid="${uid}"]`);
  if (!t) {
    t = document.createElement("div"); t.className = "gt"; t.dataset.uid = uid;
    const u = uid === S.me.id ? S.me : S.users[uid] || { id: uid, name: "…" };
    t.innerHTML = `<video autoplay playsinline ${uid === S.me.id ? "muted" : ""}></video><div class="av"></div><span class="gn">${esc(uid === S.me.id ? "أنت" : u.name)}</span>`;
    avatar(t.querySelector(".av"), u);
    $("gGrid").append(t);
  }
  layoutGrid();
  return t;
}
function layoutGrid() { const n = $("gGrid").children.length; $("gGrid").dataset.n = Math.min(n, 8); }
function setTileStream(uid, stream) {
  const t = gTile(uid), v = t.querySelector("video");
  v.srcObject = stream; v.play().catch(() => {});
  const hasVid = () => stream.getVideoTracks().some((x) => x.enabled && x.readyState === "live" && !x.muted);
  const upd = () => t.classList.toggle("novid", !hasVid());
  upd();
  for (const tr of stream.getTracks()) { tr.onmute = upd; tr.onunmute = upd; tr.onended = upd; }
  stream.onaddtrack = upd;
}

function gcallUI(state) {
  const c = S.convs.get("g" + (GC?.gid || S.gring?.gid));
  $("gcall").classList.remove("hidden");
  $("gTitle").textContent = c ? convName(c) : "مكالمة جماعية";
  $("gIncoming").classList.toggle("hidden", state !== "incoming");
  $("gActive").classList.toggle("hidden", state === "incoming");
  $("gGrid").classList.toggle("hidden", state === "incoming");
  $("gRingInfo").classList.toggle("hidden", state !== "incoming");
  if (state === "incoming") {
    const u = S.users[S.gring.from] || {};
    avatar($("gRAv"), c ? convAv(c) : u);
    $("gRText").textContent = `${u.name || ""} يدعوك لمكالمة ${S.gring.video ? "فيديو" : "صوتية"} جماعية`;
  }
  for (const b of document.querySelectorAll(".gvidonly")) b.classList.toggle("hidden", !GC?.video);
  native({ type: "call", active: true });
}

async function startGroupCall(gid, video) {
  if (GC || C) return;
  if (!S.wsOk) return toast("غير متصل بالسيرفر");
  const live = (S.gcallState[gid] || []).length;
  if (!live && !(await ask(`بدء مكالمة ${video ? "فيديو" : "صوتية"} جماعية؟`, [], "اتصال"))) return;
  joinGroupCall(gid, video);
}
async function joinGroupCall(gid, video) {
  stopRing(); S.gring = null;
  GC = { gid, video, peers: new Map(), start: Date.now(), facing: "user" };
  $("gGrid").innerHTML = "";
  gcallUI("active");
  try {
    GC.local = await getMedia(video);
    if (!GC) { GC?.local?.getTracks().forEach((t) => t.stop()); return; }
    setTileStream(S.me.id, GC.local);
    gTile(S.me.id).classList.add("me");
  } catch { toast("لم يُسمح بالمايك/الكاميرا"); return leaveGroupCall(); }
  wsSend({ t: "gcall", a: "join", gid, video: !!video });
  clearInterval(GC.timer);
  GC.timer = setInterval(() => { if (GC) $("gTime").textContent = fmtDur((Date.now() - GC.start) / 1000); }, 1000);
}
function leaveGroupCall() {
  if (!GC) return;
  wsSend({ t: "gcall", a: "leave", gid: GC.gid });
  for (const [, p] of GC.peers) { try { p.pc.close(); } catch {} }
  try { GC.local && GC.local.getTracks().forEach((t) => t.stop()); } catch {}
  clearInterval(GC.timer);
  GC = null;
  $("gGrid").innerHTML = "";
  $("gcall").classList.add("hidden");
  $("gMute").classList.remove("on"); $("gMute").innerHTML = '<svg><use href="#i-mic"/></svg>';
  $("gCam").classList.remove("on"); $("gCam").innerHTML = '<svg><use href="#i-video"/></svg>';
  native({ type: "call", active: false });
}
function gsig(uid, data) {
  const gid = GC.gid, { kind, ...rest } = data;
  S.gsigQ = (S.gsigQ || Promise.resolve()).then(async () => {
    const payload = Object.keys(rest).length ? { e: await enc(uid, JSON.stringify(rest)) } : {};
    wsSend({ t: "gsignal", gid, to: uid, data: { kind, ...payload } });
  }).catch(() => {});
}
async function makeGPC(uid, initiator) {
  const old = GC.peers.get(uid); if (old) { try { old.pc.close(); } catch {} }
  const pc = new RTCPeerConnection({ iceServers: await iceServers(), bundlePolicy: "max-bundle" });
  const peer = { pc, pending: [] };
  GC.peers.set(uid, peer);
  gTile(uid).classList.add("wait");
  GC.local.getTracks().forEach((t) => pc.addTrack(t, GC.local));
  pc.onicecandidate = (e) => { if (e.candidate && GC) gsig(uid, { kind: "ice", c: e.candidate.toJSON() }); };
  pc.ontrack = (e) => { const st = e.streams[0] || new MediaStream([e.track]); setTileStream(uid, st); };
  pc.onconnectionstatechange = () => {
    const t = gTile(uid);
    t.classList.toggle("wait", pc.connectionState !== "connected");
    if (pc.connectionState === "failed" && initiator && GC) { pc.createOffer({ iceRestart: true }).then((o) => pc.setLocalDescription(o).then(() => gsig(uid, { kind: "offer", sdp: o.sdp }))).catch(() => {}); }
  };
  if (initiator) {
    const o = await pc.createOffer();
    await pc.setLocalDescription(o);
    gsig(uid, { kind: "offer", sdp: o.sdp });
  }
  return peer;
}
function closePeer(uid) {
  const p = GC?.peers.get(uid); if (p) { try { p.pc.close(); } catch {} GC.peers.delete(uid); }
  document.querySelector(`#gGrid .gt[data-uid="${uid}"]`)?.remove(); layoutGrid();
}
async function onGSignal(from, gid, d) {
  if (!GC || GC.gid !== gid) return;
  if (d.e) { const plain = await dec(from, d.e); try { Object.assign(d, JSON.parse(plain)); } catch { return; } delete d.e; }
  let p = GC.peers.get(from);
  try {
    if (d.kind === "offer") {
      if (!p || p.pc.signalingState === "closed") p = await makeGPC(from, false);
      await p.pc.setRemoteDescription({ type: "offer", sdp: d.sdp });
      for (const c of p.pending) p.pc.addIceCandidate(c).catch(() => {}); p.pending = [];
      const a = await p.pc.createAnswer(); await p.pc.setLocalDescription(a);
      gsig(from, { kind: "answer", sdp: a.sdp });
    } else if (d.kind === "answer" && p) {
      await p.pc.setRemoteDescription({ type: "answer", sdp: d.sdp });
      for (const c of p.pending) p.pc.addIceCandidate(c).catch(() => {}); p.pending = [];
    } else if (d.kind === "ice" && p) {
      if (p.pc.remoteDescription) p.pc.addIceCandidate(d.c).catch(() => {}); else p.pending.push(d.c);
    } else if (d.kind === "ice") {
      // وصل قبل العرض: نحتفظ به
      (GC.early ||= {})[from] = [...(GC.early[from] || []), d.c];
    }
  } catch (e) { console.warn("gsignal", e); }
}
function onGCall(m) {
  const gid = m.gid;
  if (m.a === "state") {
    S.gcallState[gid] = m.peers;
    if (window.WASEL_AUTOANSWER === "g" + gid && m.peers.length && !GC && !C) { window.WASEL_AUTOANSWER = null; joinGroupCall(gid, false); }
    if (S.gring && S.gring.gid === gid && !m.peers.length) { stopRing(); S.gring = null; $("gcall").classList.add("hidden"); native({ type: "call", active: false }); }
    if (S.cur === "g" + gid) setHeader();
    renderChats();
    return;
  }
  if (m.a === "ring") {
    if (m.user) S.users[m.user.id] = { ...S.users[m.user.id], ...m.user };
    if (GC || C) return;
    const c = S.convs.get("g" + gid);
    S.gring = { gid, from: m.from, video: !!m.video };
    if (locked) unlock();
    gcallUI("incoming");
    if (!(document.hidden && NAT.any) && !(c && c.prefs.muted)) ring("in");
    clearTimeout(S.gringT); S.gringT = setTimeout(() => { if (S.gring && S.gring.gid === gid) { stopRing(); S.gring = null; $("gcall").classList.add("hidden"); } }, 45000);
    if (window.WASEL_AUTOANSWER === "g" + gid) { window.WASEL_AUTOANSWER = null; setTimeout(() => $("gAccept").click(), 300); }
    return;
  }
  if (!GC || GC.gid !== gid) return;
  if (m.a === "joined") {
    for (const uid of m.peers) makeGPC(uid, true).then((p) => { for (const c of GC?.early?.[uid] || []) p.pending.push(c); });
  } else if (m.a === "peer-joined") {
    if (m.user) S.users[m.user.id] = { ...S.users[m.user.id], ...m.user };
    gTile(m.uid).classList.add("wait");
    if (SET.sound) tone(880, 0.12);
  } else if (m.a === "peer-left") {
    closePeer(m.uid);
  } else if (m.a === "full") {
    toast("المكالمة ممتلئة (8 أشخاص)"); leaveGroupCall();
  }
}
$("gAccept").onclick = () => { if (S.gring) joinGroupCall(S.gring.gid, S.gring.video); };
$("gDecline").onclick = () => { stopRing(); S.gring = null; $("gcall").classList.add("hidden"); native({ type: "call", active: false }); };
$("gHang").onclick = () => leaveGroupCall();
$("gMute").onclick = () => {
  const t = GC?.local?.getAudioTracks()[0]; if (!t) return; t.enabled = !t.enabled;
  $("gMute").classList.toggle("on", !t.enabled); $("gMute").innerHTML = `<svg><use href="#i-${t.enabled ? "mic" : "micoff"}"/></svg>`;
};
$("gCam").onclick = () => {
  const t = GC?.local?.getVideoTracks()[0]; if (!t) return; t.enabled = !t.enabled;
  $("gCam").classList.toggle("on", !t.enabled); $("gCam").innerHTML = `<svg><use href="#i-${t.enabled ? "video" : "camoff"}"/></svg>`;
  gTile(S.me.id).classList.toggle("novid", !t.enabled);
};
$("gFlip").onclick = async () => {
  if (!GC?.video) return;
  GC.facing = GC.facing === "environment" ? "user" : "environment";
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: GC.facing } });
    const nt = s.getVideoTracks()[0];
    for (const [, p] of GC.peers) { const snd = p.pc.getSenders().find((x) => x.track && x.track.kind === "video"); if (snd) await snd.replaceTrack(nt); }
    const old = GC.local.getVideoTracks()[0]; GC.local.removeTrack(old); old.stop(); GC.local.addTrack(nt);
    setTileStream(S.me.id, GC.local);
    gTile(S.me.id).classList.toggle("front", GC.facing === "user");
  } catch { toast("تعذّر تبديل الكاميرا"); }
};
