// ---------- البدء ----------
function start() {
  S.users[S.me.id] = S.me; show("home"); renderChats(); renderCalls(); loadChats(); connect(); applySet(); setInterval(() => { if (S.view === "chat") renderMsgs(); }, 60000);
  history.replaceState({ v: "home" }, "");
  native({ type: "auth", token: S.token, me: S.me.id, server: API, name: S.me.name });
  native({ type: "prefs", msgN: SET.msgN, callN: SET.callN, secure: SET.secure });
  iceServers(); checkUpdate();
  api("/api/me").then((d) => { S.me = { ...S.me, ...d.user }; localStorage.setItem("w_me", JSON.stringify(S.me)); if (S.view === "settings") renderSettings(); }).catch(() => {});
}
buildPad(); applySet();
if (S.token && S.me && localStorage.getItem("w_priv")) { start(); if (SET.lock) lockNow(); } else { if (S.token) logout(true); show("auth"); }
