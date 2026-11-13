// لعبة "ألوان" — قواعد شبيهة بأونو، من 2 إلى 8 لاعبين.
// السيرفر هو الحَكَم: يخلط ويوزّع ويتحقق من كل حركة، وكل لاعب يستلم كروته فقط.

const COLORS = ["r", "y", "g", "b"];
const TURN_MS = 30000;
const MAX_PLAYERS = 8;

function newDeck() {
  const d = [];
  let n = 0;
  for (const c of COLORS) {
    d.push(`${c}0#${n++}`);
    for (const v of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "S", "R", "D"]) { d.push(`${c}${v}#${n++}`); d.push(`${c}${v}#${n++}`); }
  }
  for (let i = 0; i < 4; i++) { d.push(`wW#${n++}`); d.push(`w4#${n++}`); }
  return shuffle(d);
}
function shuffle(a) {
  const r = new Uint32Array(a.length);
  crypto.getRandomValues(r);
  for (let i = a.length - 1; i > 0; i--) { const j = r[i] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const col = (c) => c[0];
const val = (c) => c[1];

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.s = null;
    ctx.blockConcurrencyWhile(async () => { this.s = (await ctx.storage.get("s")) || null; });
  }

  async save() { await this.ctx.storage.put("s", this.s); }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const token = url.searchParams.get("token") || "";
    const code = (url.searchParams.get("room") || "").toUpperCase();
    // التحقق من هوية اللاعب عبر السيرفر الرئيسي
    const r = await this.env.HUB.get(this.env.HUB.idFromName("main")).fetch("https://internal/api/me", { headers: { authorization: "Bearer " + token } });
    if (!r.ok) return new Response("unauthorized", { status: 401 });
    const { user } = await r.json();

    if (!this.s) this.s = { code, host: user.id, status: "lobby", players: [], deck: [], discard: [], color: "r", turn: 0, dir: 1, drew: false, deadline: 0, vuln: null, log: "", winner: null, round: 0 };
    const s = this.s;
    let p = s.players.find((x) => x.id === user.id);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [String(user.id)]);
    pair[1].serializeAttachment({ uid: user.id });

    if (!p) {
      if (s.status !== "lobby") { this.sendErr(pair[1], "اللعبة بدأت بالفعل"); pair[1].close(4000, "started"); return new Response(null, { status: 101, webSocket: pair[0] }); }
      if (s.players.length >= MAX_PLAYERS) { this.sendErr(pair[1], "الغرفة ممتلئة (8 لاعبين)"); pair[1].close(4000, "full"); return new Response(null, { status: 101, webSocket: pair[0] }); }
      p = { id: user.id, name: user.name, avatar: user.avatar || null, hand: [], said1: false, left: false, wins: 0 };
      s.players.push(p);
      s.log = `${p.name} دخل الغرفة`;
    } else {
      p.left = false; p.name = user.name; p.avatar = user.avatar || null;
    }
    if (!s.players.some((x) => x.id === s.host && !x.left)) s.host = p.id;
    await this.save();
    this.broadcast();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  sendErr(ws, msg) { try { ws.send(JSON.stringify({ t: "err", msg })); } catch {} }
  connected(uid) { return this.ctx.getWebSockets(String(uid)).length > 0; }

  view(uid) {
    const s = this.s;
    const me = s.players.find((x) => x.id === uid);
    const cur = s.players[s.turn];
    const top = s.discard[s.discard.length - 1] || null;
    return {
      code: s.code, status: s.status, host: s.host, round: s.round,
      players: s.players.map((x) => ({ id: x.id, name: x.name, avatar: x.avatar, count: x.hand.length, said1: x.said1, left: x.left, online: this.connected(x.id), wins: x.wins })),
      top, color: s.color, dir: s.dir, turn: s.status === "play" && cur ? cur.id : null,
      deadline: s.deadline, deck: s.deck.length, vuln: s.vuln, log: s.log, winner: s.winner,
      hand: me ? me.hand : [], drew: s.drew,
      playable: me && cur && cur.id === uid && s.status === "play" ? me.hand.filter((c) => this.canPlay(c)) : [],
    };
  }
  broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      const { uid } = ws.deserializeAttachment() || {};
      try { ws.send(JSON.stringify({ t: "state", s: this.view(uid) })); } catch {}
    }
  }
  fx(ev) { const m = JSON.stringify({ t: "fx", ...ev }); for (const ws of this.ctx.getWebSockets()) try { ws.send(m); } catch {} }

  canPlay(c) {
    const top = this.s.discard[this.s.discard.length - 1];
    if (col(c) === "w") return true;
    return col(c) === this.s.color || val(c) === val(top);
  }
  draw(p, n) {
    const s = this.s;
    const got = [];
    for (let i = 0; i < n; i++) {
      if (!s.deck.length) {
        const top = s.discard.pop();
        s.deck = shuffle(s.discard);
        s.discard = [top];
        if (!s.deck.length) break;
      }
      got.push(s.deck.pop());
    }
    p.hand.push(...got);
    if (p.hand.length > 1) p.said1 = false;
    return got;
  }
  activeCount() { return this.s.players.filter((x) => !x.left).length; }
  nextIdx(from, steps = 1) {
    const s = this.s, n = s.players.length;
    let i = from;
    for (let k = 0; k < steps; k++) {
      let guard = 0;
      do { i = (i + s.dir + n) % n; } while (s.players[i].left && ++guard < n);
    }
    return i;
  }
  async setTurn(i) {
    const s = this.s;
    s.turn = i; s.drew = false;
    s.deadline = Date.now() + TURN_MS;
    await this.ctx.storage.setAlarm(s.deadline + 300);
  }

  async start() {
    const s = this.s;
    s.players = s.players.filter((x) => !x.left);
    for (const p of s.players) { p.hand = []; p.said1 = false; }
    s.deck = newDeck(); s.discard = []; s.dir = 1; s.vuln = null; s.winner = null; s.round++;
    for (let k = 0; k < 7; k++) for (const p of s.players) p.hand.push(s.deck.pop());
    // أول كرت على الطاولة: رقم عادي
    let first;
    while (true) { first = s.deck.pop(); if (/^[rygb][0-9]/.test(first)) break; s.deck.unshift(first); }
    s.discard.push(first); s.color = col(first);
    s.status = "play";
    const startIdx = (s.round - 1) % s.players.length;
    s.log = "بدأت اللعبة! 🎴";
    await this.setTurn(startIdx);
  }

  async finish(p) {
    const s = this.s;
    s.status = "over"; s.winner = p.id; p.wins++;
    s.log = `🏆 ${p.name} فاز!`;
    s.deadline = 0;
    await this.ctx.storage.deleteAlarm();
  }

  async play(p, card, chosen) {
    const s = this.s;
    const idx = p.hand.indexOf(card);
    if (idx < 0 || !this.canPlay(card)) return "لا يمكنك لعب هذا الكرت";
    if (col(card) === "w" && !COLORS.includes(chosen)) return "اختر لوناً";
    p.hand.splice(idx, 1);
    s.discard.push(card);
    s.color = col(card) === "w" ? chosen : col(card);
    s.vuln = null;
    if (p.hand.length === 1 && !p.said1) s.vuln = p.id;
    if (p.hand.length !== 1) p.said1 = false;
    const v = val(card), me = s.players.indexOf(p);
    const names = { S: "تخطّي", R: "عكس الاتجاه", D: "+2", W: "تغيير اللون", "4": "+4" };
    s.log = `${p.name}: ${names[v] || "لعب " + v}`;
    this.fx({ kind: "play", by: p.id, card });
    if (!p.hand.length) return this.finish(p);

    let next;
    if (v === "S") next = this.nextIdx(me, 2);
    else if (v === "R") {
      s.dir *= -1;
      next = this.activeCount() === 2 ? me : this.nextIdx(me);
    } else if (v === "D" || v === "4") {
      const victim = s.players[this.nextIdx(me)];
      this.draw(victim, v === "D" ? 2 : 4);
      s.log += ` ← ${victim.name} يسحب ${v === "D" ? 2 : 4}`;
      next = this.nextIdx(me, 2);
    } else next = this.nextIdx(me);
    await this.setTurn(next);
  }

  async timeout() {
    const s = this.s, p = s.players[s.turn];
    if (!s.drew) this.draw(p, 1);
    s.log = `⏱️ انتهى وقت ${p.name}`;
    await this.setTurn(this.nextIdx(s.turn));
  }

  async webSocketMessage(ws, raw) {
    const { uid } = ws.deserializeAttachment() || {};
    const s = this.s;
    if (!s || !uid || typeof raw !== "string" || raw.length > 2000) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    const p = s.players.find((x) => x.id === uid);
    if (!p) return;
    const myTurn = s.status === "play" && s.players[s.turn] && s.players[s.turn].id === uid;
    let err = null;

    switch (m.a) {
      case "start":
        if (uid !== s.host) err = "فقط صاحب الغرفة يبدأ اللعبة";
        else if (s.status === "play") err = "اللعبة جارية";
        else if (this.activeCount() < 2) err = "تحتاج لاعبين اثنين على الأقل";
        else await this.start();
        break;
      case "play":
        if (!myTurn) err = "ليس دورك";
        else err = await this.play(p, String(m.card), m.color);
        break;
      case "draw":
        if (!myTurn) err = "ليس دورك";
        else if (s.drew) err = "سحبت بالفعل";
        else {
          const [c] = this.draw(p, 1);
          s.drew = true; s.vuln = s.vuln === uid ? null : s.vuln;
          s.log = `${p.name} سحب كرتاً`;
          if (!c || !this.canPlay(c)) await this.setTurn(this.nextIdx(s.turn));
        }
        break;
      case "pass":
        if (!myTurn || !s.drew) err = "اسحب أولاً";
        else { s.log = `${p.name} مرّر`; await this.setTurn(this.nextIdx(s.turn)); }
        break;
      case "one":
        if (p.hand.length <= 2) {
          p.said1 = true;
          if (s.vuln === uid) s.vuln = null;
          s.log = `${p.name}: واحدة! ☝️`;
          this.fx({ kind: "one", by: uid });
        }
        break;
      case "catch": {
        const t = s.players.find((x) => x.id === Number(m.target));
        if (t && s.vuln === t.id && t.hand.length === 1) {
          this.draw(t, 2); s.vuln = null;
          s.log = `🫵 ${p.name} مسك ${t.name} — يسحب 2`;
          this.fx({ kind: "catch", by: uid, target: t.id });
        }
        break;
      }
      case "lobby":
        if (uid === s.host && s.status === "over") { s.status = "lobby"; s.log = "جولة جديدة — بانتظار البدء"; for (const x of s.players) x.hand = []; }
        break;
      case "kick":
        if (uid === s.host && s.status === "lobby") {
          const t = Number(m.target);
          s.players = s.players.filter((x) => x.id !== t);
          for (const o of this.ctx.getWebSockets(String(t))) { this.sendErr(o, "أخرجك صاحب الغرفة"); try { o.close(4000, "kicked"); } catch {} }
        }
        break;
      case "leave":
        await this.leave(p);
        try { ws.close(1000, "left"); } catch {}
        break;
      case "emoji":
        if (typeof m.e === "string" && m.e.length <= 8) this.fx({ kind: "emoji", by: uid, e: m.e });
        return;
      default:
        return;
    }
    if (err) return this.sendErr(ws, err);
    await this.save();
    this.broadcast();
  }

  async leave(p) {
    const s = this.s;
    if (s.status === "lobby") s.players = s.players.filter((x) => x !== p);
    else {
      p.left = true;
      s.deck.unshift(...p.hand); p.hand = [];
      s.log = `${p.name} غادر`;
      if (s.status === "play") {
        const alive = s.players.filter((x) => !x.left);
        if (alive.length < 2) { if (alive[0]) await this.finish(alive[0]); }
        else if (s.players[s.turn] === p) await this.setTurn(this.nextIdx(s.turn));
      }
    }
    if (s.host === p.id) { const h = s.players.find((x) => !x.left); if (h) s.host = h.id; }
  }

  async alarm() {
    if (!this.s || this.s.status !== "play") return;
    if (Date.now() + 500 < this.s.deadline) { await this.ctx.storage.setAlarm(this.s.deadline + 300); return; }
    await this.timeout();
    await this.save();
    this.broadcast();
  }

  async webSocketClose() { this.broadcast(); }
  async webSocketError() { this.broadcast(); }
}
