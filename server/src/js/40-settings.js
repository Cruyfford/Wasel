// ---------- الإعدادات ----------
function sw(id, on) { $(id).querySelector(".sw").classList.toggle("on", !!on); }
function renderSettings() {
  avatar($("sAv"), S.me); $("sName").textContent = S.me.name; $("sAbout").textContent = S.me.about || S.me.email;
  $("sPin").textContent = S.me.pin || "…";
}
$("hSettings").onclick = () => { renderSettings(); go("settings"); };
$("sPinCopy").onclick = () => navigator.clipboard?.writeText(S.me.pin).then(() => toast("تم نسخ الكود")).catch(() => toast(S.me.pin));
$("sPinShare").onclick = () => {
  const t = `أضفني على واصل 💬\nكودي: ${S.me.pin}`;
  if (navigator.share) navigator.share({ text: t }).catch(() => {});
  else navigator.clipboard?.writeText(t).then(() => toast("تم نسخ رسالة المشاركة"));
};
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
  if (S.avTarget) { const c = S.avTarget; S.avTarget = null; try { await groupUpdate(c, { avatar: await resizeImage(f, 320, true, 0.8) }); } catch (er) { toast(er.message); } return; }
  try { await setMe({ avatar: await resizeImage(f, 320, true, 0.8) }); avatar($("pAv"), S.me); renderSettings(); toast("تم تحديث الصورة"); }
  catch (er) { toast(er.message || "تعذّر رفع الصورة"); }
};
$("pRmAv").onclick = async () => { await setMe({ avatar: null }); avatar($("pAv"), S.me); renderSettings(); };
$("pSave").onclick = async () => { try { await setMe({ name: $("pName").value, about: $("pAbout").value }); toast("تم الحفظ"); renderSettings(); } catch (e) { toast(e.message); } };

// الخصوصية
function renderPrivacy() { sw("prSeen", S.me.hide_seen); sw("prRead", S.me.receipts !== false); }
$("prBlocked").onclick = async () => {
  go("blocked");
  $("blockedList").innerHTML = '<div class="empty">⏳</div>';
  try {
    const d = await api("/api/blocks");
    if (!d.users.length) { $("blockedList").innerHTML = '<div class="empty">لا يوجد أحد محظور</div>'; return; }
    $("blockedList").innerHTML = d.users.map((u) => `<div class="it"><div class="av sm" data-u='${esc(JSON.stringify({ id: u.id, name: u.name, avatar: safeImg(u.avatar) }))}'></div><span class="tx">${esc(u.name)}<small dir="ltr">${esc(u.pin || "")}</small></span><button class="link" data-unb="${u.id}">إلغاء الحظر</button></div>`).join("");
    for (const el of $("blockedList").querySelectorAll("[data-u]")) avatar(el, JSON.parse(el.dataset.u));
    $("blockedList").onclick = async (e) => { const id = e.target.dataset.unb; if (!id) return; await setBlock(Number(id), false); $("prBlocked").click(); };
  } catch (e) { $("blockedList").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
};
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
  sw("csEnter", SET.enter); sw("csLp", SET.lp !== false);
  applySet();
}
$("walls").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; if (b.dataset.w === "custom") return $("fWall").click(); SET.wall = b.dataset.w; saveSet(); renderChatSet(); };
$("fWall").onchange = async (e) => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; try { localStorage.setItem("w_wall", await resizeImage(f, 1400, false, 0.8)); SET.wall = "custom"; saveSet(); renderChatSet(); } catch { toast("الصورة كبيرة جداً"); } };
$("wDim").oninput = () => { SET.dim = Number($("wDim").value); saveSet(); };
$("fsSeg").onclick = (e) => { const v = e.target.dataset.v; if (!v) return; SET.fs = v; saveSet(); renderChatSet(); };
$("csEnter").onclick = () => { SET.enter = !SET.enter; saveSet(); renderChatSet(); };
$("csLp").onclick = () => { SET.lp = SET.lp === false; saveSet(); renderChatSet(); };

// الإشعارات
function renderNotifs() { sw("nMsg", SET.msgN); sw("nCall", SET.callN); sw("nSound", SET.sound); }
$("nMsg").onclick = () => { SET.msgN = !SET.msgN; saveSet(); renderNotifs(); };
$("nCall").onclick = () => { SET.callN = !SET.callN; saveSet(); renderNotifs(); };
$("nSound").onclick = () => { SET.sound = !SET.sound; saveSet(); renderNotifs(); };

