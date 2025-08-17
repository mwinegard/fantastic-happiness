// Fantastic Happiness — UNO (from-scratch recode, multi-lobby, specials, global leaderboard)
//
// Key guarantees:
// - Lobbies: Name + Lobby to join; per-lobby isolation.
// - Wild specials choose color at the END of their effect.
// - Any extra discards produced by effects go UNDER the special (special stays on top).
// - RELAX: no reaction window; usable only on your turn or during a stack; cancels stack.
// - PACK YOUR BAGS: literal seat swap; hands remain at seats; current seat stays current.
// - NOC NOTICE: red-only; first play picks a random seated player (incl. self) and stores as target for rest of round; repeats hit same target; reset each new game.
// - SHOPPING: yellow-only; choose target, swap 2 of yours for 1 of theirs; cancel returns card to hand & keeps timer.
// - TO THE MOON: blue-only; random other seated player draws 1 (rocket landing).
// - RECYCLE: green-only; redistribute all players’ hands evenly; extras recycled under special; announce counts.
// - PINKY PROMISE: yellow-only; combine actor+target hands, shuffle, split evenly; if odd, extra to one at random.
// - LOOK: top 4 reorder (actor only).
// - HAPPY: toggles simple “not nice word” filter → author draws 1.
// - Strict stacking: Draw2 stacks with Draw2; Draw4 with Draw4.
// - UNO: if you finish turn with 1 card, must call UNO before turn advances or +2 penalty applies.
// - Mid-game join: if seats < 10, deal 7 and add to order; else spectate.
// - Timeout: 60s; draw (or draw stack) on timeout; 3 timeouts → removal.

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

/* ------------------------- Global Leaderboard ------------------------- */
const SCORE_PATH = path.join(__dirname, "scores.json");
let scores = {};
try { if (fs.existsSync(SCORE_PATH)) scores = JSON.parse(fs.readFileSync(SCORE_PATH, "utf8") || "{}"); } catch {}
function saveScores() { try { fs.writeFileSync(SCORE_PATH, JSON.stringify(scores, null, 2)); } catch {} }
function addScore(name, dw = 0, dp = 0) {
  if (!scores[name] || typeof scores[name] !== "object") scores[name] = { wins: 0, points: 0 };
  scores[name].wins = Number(scores[name].wins || 0) + dw;
  scores[name].points = Number(scores[name].points || 0) + dp;
  saveScores();
}
app.get("/leaderboard", (_req, res) => {
  const arr = Object.keys(scores).map(n => ({ name: n, wins: Number(scores[n].wins || 0), points: Number(scores[n].points || 0) }));
  arr.sort((a,b)=> (b.points-a.points) || (b.wins-a.wins) || a.name.localeCompare(b.name));
  res.json(arr);
});

/* ------------------------------ Lobbies ------------------------------ */
const lobbies = new Map();
app.get("/lobbies", (_req,res) => {
  const list = Array.from(lobbies.values()).map(L => ({
    name: L.name,
    players: L.players.filter(p=>!p.spectator).length,
    spectators: L.players.filter(p=>p.spectator).length,
    started: !!L.game?.started
  }));
  res.json(list);
});

/* --------------------------- Game Constants -------------------------- */
const MAX_PLAYERS = 10;
const TURN_SECONDS = 60;
const COUNTDOWN_SECONDS = 30;
const COLORS = ["red","blue","green","yellow"];
const SCORING_MODE = "points";
const POINTS_TARGET = 500;

const NOT_NICE_WORDS = ["idiot","stupid","dumb","hate","loser","sucks"]; // lightweight filter for HAPPY

/* Card points (classic UNO + custom PNG titles) */
const CARD_POINTS = (() => {
  const out = {};
  for (const c of COLORS) {
    out[`${c}_0`] = 0;
    for (let n = 1; n <= 9; n++) out[`${c}_${n}`] = n;
    out[`${c}_skip`] = 20; out[`${c}_reverse`] = 20; out[`${c}_draw2`] = 20;
  }
  // wild & customs
  ["wild","wild_draw4","wild_relax","wild_boss","wild_packyourbags","wild_rainbow"].forEach(k => out[k] = 50);
  out["blue_look"]=20; out["yellow_shopping"]=30; out["green_happy"]=20; out["green_recycle"]=20;
  out["yellow_pinkypromise"]=20; out["blue_moon"]=20; out["red_it"]=20; out["red_noc"]=20;
  return out;
})();

/* ------------------------------ Utilities --------------------------- */
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }
function sample(a){ return a[(Math.random()*a.length)|0]; }
function sanitizeName(n){ return String(n||"").replace(/[^a-zA-Z0-9 _\-\.\!\?]/g,"").trim().slice(0,24) || "Player"; }

function seatedPlayers(L) { return L.players.filter(p => !p.spectator); }

function restockDeckIfNeeded(G, n=1){
  if (!G) return;
  if ((G.deck?.length||0) < n || (G.deck?.length||0) <= 10) {
    if ((G.discard?.length||0) > 1) {
      const top = G.discard.pop();
      const rest = G.discard.splice(0);
      shuffle(rest);
      G.deck = rest.concat(G.deck||[]);
      G.discard = [top];
    }
  }
}
function drawCards(G, n) {
  const out = [];
  restockDeckIfNeeded(G, n);
  for (let i = 0; i < n; i++) { const c = G.deck.pop(); if (c) out.push(c); }
  return out;
}
function drawOne(G, sid){ const c = drawCards(G,1)[0]; if (!c) return null; (G.hands[sid] = G.hands[sid] || []).push(c); return c; }

function cardImageName(card) {
  if (!card) return "back.png";
  if (card.color === "wild") return `${card.type}.png`;
  if (card.type === "number") return `${card.color}_${card.value}.png`;
  if (card.type === "draw2") return `${card.color}_draw2.png`;
  if (card.type === "skip") return `${card.color}_skip.png`;
  if (card.type === "reverse") return `${card.color}_reverse.png`;
  return `${card.type}.png`;
}

function buildDeck() {
  const d = [];
  for (const color of COLORS) {
    d.push({ color, type: "number", value: 0, img: `${color}_0.png` });
    for (let v=1; v<=9; v++) { d.push({ color, type: "number", value: v, img: `${color}_${v}.png` }); d.push({ color, type: "number", value: v, img: `${color}_${v}.png` }); }
    for (let i=0;i<2;i++){ d.push({ color, type: "reverse", img:`${color}_reverse.png` });
      d.push({ color, type: "skip", img:`${color}_skip.png` });
      d.push({ color, type: "draw2", img:`${color}_draw2.png` }); }
  }
  // specials (1 each unless noted)
  d.push({ color:"blue", type:"blue_look", img:"blue_look.png" });
  d.push({ color:"yellow", type:"yellow_shopping", img:"yellow_shopping.png" });
  d.push({ color:"green", type:"green_happy", img:"green_happy.png" });
  d.push({ color:"green", type:"green_recycle", img:"green_recycle.png" });
  d.push({ color:"yellow", type:"yellow_pinkypromise", img:"yellow_pinkypromise.png" });
  d.push({ color:"blue", type:"blue_moon", img:"blue_moon.png" });
  d.push({ color:"red", type:"red_it", img:"red_it.png" });
  d.push({ color:"red", type:"red_noc", img:"red_noc.png" });

  for (let i=0;i<4;i++){ d.push({ color:"wild", type:"wild", img:"wild.png" }); d.push({ color:"wild", type:"wild_draw4", img:"wild_draw4.png" }); }
  d.push({ color:"wild", type:"wild_relax", img:"wild_relax.png" });
  d.push({ color:"wild", type:"wild_boss", img:"wild_boss.png" });
  d.push({ color:"wild", type:"wild_packyourbags", img:"wild_packyourbags.png" });
  d.push({ color:"wild", type:"wild_rainbow", img:"wild_rainbow.png" });
  return shuffle(d);
}

function createLobby(name) {
  const room = `lobby:${name}`;
  const L = {
    name, room,
    players: [], // {id,sid,name,lobby,spectator,misses}
    game: null,
    ticker: null,
    countdown: null,
    chatBuffer: []
  };
  lobbies.set(name, L);
  return L;
}
function lobbyOf(socket){ return socket.data?.lobby && lobbies.get(socket.data.lobby) || null; }
function sidToName(L, sid){ return L.players.find(p=>p.sid===sid)?.name || "Player"; }
function sidToPlayer(L, sid){ return L.players.find(p=>p.sid===sid) || null; }
function activeOrder(L){ return L.players.filter(p=>!p.spectator).map(p=>p.sid); }
function previousActiveSid(L, fromSid) {
  const order = activeOrder(L);
  if (!order.length) return null;
  const i = order.indexOf(fromSid);
  if (i < 0) return order[0];
  return order[(i - 1 + order.length) % order.length];
}

function emptyGame() {
  return {
    started:false,
    deck:[],
    discard:[],
    hands:{},
    color:null,
    value:null,
    dir:1,
    current:null,
    countdownEndsAt:null,
    turnEndsAt:null,
    pendingPenalty:null, // { total, type: "draw2"|"wild_draw4", targetSid, lastFromSid }
    relaxLock:false,
    unoArmedSid:null,
    unoSatisfied:false,
    roundFlags:{ happy:false },
    nocTarget:null
  };
}

function announce(L, text){ io.in(L.room).emit("announce", text); L.chatBuffer.push({when:Date.now(), text}); if (L.chatBuffer.length>200) L.chatBuffer.shift(); }
function snapshot(L){
  const G = L.game;
  const top = G?.discard?.[G.discard.length-1] || null;
  return {
    lobby: L.name,
    started: !!G?.started,
    countdownEndsAt: G?.countdownEndsAt || null,
    turnEndsAt: G?.turnEndsAt || null,
    color: G?.color || null,
    value: G?.value || null,
    current: G?.current || null,
    direction: G?.dir || 1,
    top: top ? { color: top.color, type: top.type, value: top.value||null, img: cardImageName(top) } : null,
    penalty: G?.pendingPenalty ? { total:G.pendingPenalty.total, type:G.pendingPenalty.type, target:G.pendingPenalty.targetSid } : null,
    roundFlags: G?.roundFlags || { happy:false },
    players: L.players.map(p=>({ sid:p.sid, name:p.name, spectator:p.spectator, misses:p.misses||0 }))
  };
}
function emitState(L){ io.in(L.room).emit("state", snapshot(L)); }

function sumOpponents(G, winnerSid){
  let pot=0;
  for (const [sid,hand] of Object.entries(G.hands||{})){
    if (sid === String(winnerSid)) continue;
    for (const c of hand||[]){
      const key = c.color==="wild" ? c.type : (c.type==="number" ? `${c.color}_${c.value}` : `${c.color}_${c.type}`);
      pot += (CARD_POINTS[key] || 0);
    }
  }
  return pot;
}
function scoreRound(L, winnerSid){
  const winnerName = sidToName(L, winnerSid);
  const pot = sumOpponents(L.game, winnerSid);
  addScore(winnerName, 1, pot);
  announce(L, `🏁 Round Winner: ${winnerName} (+${pot} pts).`);
  if (SCORING_MODE === "points" && scores[winnerName]?.points >= POINTS_TARGET) {
    announce(L, `🎉 MATCH WIN: ${winnerName} reached ${scores[winnerName].points} pts!`);
  }
}

function startCountdown(L){
  if (L.game?.started || L.countdown) return;
  const seated = L.players.filter(p=>!p.spectator).length;
  if (seated < 2) return;
  L.game = emptyGame();
  L.game.countdownEndsAt = Date.now() + COUNTDOWN_SECONDS*1000;
  announce(L, `⏳ Game starts in ${COUNTDOWN_SECONDS}s…`);
  emitState(L);
  L.countdown = setInterval(()=>{
    const seatedNow = L.players.filter(p=>!p.spectator).length;
    if (seatedNow < 2) { clearInterval(L.countdown); L.countdown=null; announce(L,"❌ Countdown canceled—need at least 2 players."); emitState(L); return; }
    if (Date.now() >= L.game.countdownEndsAt) { clearInterval(L.countdown); L.countdown=null; initGame(L); }
  }, 300);
}

function initGame(L){
  const order = activeOrder(L);
  const deck = buildDeck();
  const hands = {};
  for (const sid of order) hands[sid] = drawCards({deck,discard:[]},7); // from a sub-deck; OK pre-discard
  // flip a legal first card (number)
  let first = deck.pop();
  while (first.type !== "number") { deck.unshift(first); shuffle(deck); first = deck.pop(); }

  L.game = emptyGame();
  const G = L.game;
  G.started = true;
  G.deck = deck; G.discard = [first];
  G.color = first.color; G.value = first.value; G.dir = 1; G.hands = hands;
  G.current = order[0]; G.turnEndsAt = Date.now() + TURN_SECONDS*1000;
  announce(L, "🎉 Game started!");
  emitState(L);

  clearInterval(L.ticker);
  L.ticker = setInterval(()=> onTick(L), 250);
}

function winnerIfAny(L){
  const G = L.game; if (!G) return null;
  for (const sid of activeOrder(L)) {
    if ((G.hands[sid]||[]).length === 0) return sid;
  }
  return null;
}
function maybeApplyUnoPenalty(L, leavingSid){
  const G = L.game; if (!G) return;
  if (G.unoArmedSid === leavingSid && !G.unoSatisfied) {
    drawOne(G, leavingSid); drawOne(G, leavingSid);
    announce(L, `🔔 UNO penalty: ${sidToName(L, leavingSid)} didn’t call — drew 2.`);
  }
  G.unoArmedSid = null; G.unoSatisfied = false;
}
function nextActiveSid(L, fromSid){
  const order = activeOrder(L);
  if (order.length <= 1) return order[0] || null;
  const idx = Math.max(0, order.findIndex(sid=>sid===fromSid));
  return (L.game.dir === -1) ? order[(idx - 1 + order.length) % order.length] : order[(idx + 1) % order.length];
}
function advanceTurn(L, steps=1){
  const G = L.game; if (!G?.started) return;
  const order = activeOrder(L); if (order.length <= 1) return;
  const leaving = G.current;
  let idx = order.findIndex(sid=>sid===G.current); if (idx<0) idx=0;
  for (let i=0;i<steps;i++) idx = (idx + (G.dir===-1?-1:1) + order.length) % order.length;
  if (leaving) maybeApplyUnoPenalty(L, leaving);
  G.current = order[idx];
  G.turnEndsAt = Date.now() + TURN_SECONDS*1000;
}
function onTick(L){
  const G = L.game; if (!G?.started || !G.current) return;

  // Early winner check
  const w = winnerIfAny(L); if (w) return settleAndQueueNext(L, w);

  if (Date.now() < G.turnEndsAt) return;
  const curSid = G.current;
  const cur = L.players.find(p=>p.sid===curSid);
  if (!cur || cur.spectator) { advanceTurn(L,1); emitState(L); return; }

  if (G.pendingPenalty && G.pendingPenalty.targetSid === curSid) {
    const total = G.pendingPenalty.total;
    for (let i=0;i<total;i++) drawOne(G, curSid);
    announce(L, `${cur.name} drew ${total} (stack ended).`);
    G.pendingPenalty = null; G.relaxLock=false;
  } else {
    drawOne(G, curSid);
    announce(L, `🃏 ${cur.name} drew 1 card.`);
  }
  cur.misses = (cur.misses||0) + 1;
  if (cur.misses >= 3) { announce(L, `🛑 ${cur.name} removed after 3 missed turns.`); cleanupLeaver(L, cur.id); emitState(L); return; }
  advanceTurn(L,1);
  emitState(L);
}
function settleAndQueueNext(L, winnerSid){
  scoreRound(L, winnerSid);
  clearInterval(L.ticker); L.ticker=null;
  L.game = emptyGame();
  L.game.countdownEndsAt = Date.now() + COUNTDOWN_SECONDS*1000;
  announce(L, `⏳ Next round in ${COUNTDOWN_SECONDS}s…`);
  emitState(L);
  clearInterval(L.countdown);
  L.countdown = setInterval(()=>{
    const seated = L.players.filter(p=>!p.spectator).length;
    if (seated < 2) { clearInterval(L.countdown); L.countdown=null; announce(L,"❌ Countdown paused—need at least 2 players."); emitState(L); return; }
    if (Date.now() >= L.game.countdownEndsAt) { clearInterval(L.countdown); L.countdown=null; initGame(L); }
  }, 300);
}

function cleanupLeaver(L, socketId){
  const i = L.players.findIndex(p=>p.id===socketId);
  if (i<0) return;
  const leaver = L.players[i];
  const G = L.game;
  if (G?.hands?.[leaver.sid]?.length) {
    for (const c of G.hands[leaver.sid]) G.deck.unshift(c);
    delete G.hands[leaver.sid];
  }
  L.players.splice(i,1);
  announce(L, `👋 ${leaver.name} left the table.`);

  if (G?.pendingPenalty && G.pendingPenalty.targetSid === leaver.sid) {
    const newTarget = nextActiveSid(L, G.pendingPenalty.lastFromSid);
    if (newTarget && newTarget !== leaver.sid) {
      G.pendingPenalty.targetSid = newTarget;
      announce(L, `⚠️ Penalty re-targeted → ${sidToName(L, newTarget)} (+${G.pendingPenalty.total}).`);
    } else {
      G.pendingPenalty = null; G.relaxLock=false;
    }
  }
  if (G?.current === leaver.sid) advanceTurn(L,1);
  emitState(L);
}

function legalMatch(G, card) {
  if (String(card.type).startsWith("wild")) return true;
  if (card.type === "number") return (card.color === G.color || card.value === G.value);
  return (card.color === G.color || card.type === G.value);
}

// discard-under helper: ensure extras go under the special currently on top
function putUnderSpecial(G, extras) {
  if (!extras || !extras.length) return;
  const top = G.discard.pop();
  G.discard.push(...extras);
  G.discard.push(top);
}

// color-choose-at-end helper for wilds
function endChooseColorAndFinish({ io, L, G, me, specialType, afterColor }) {
  const s = io.sockets.sockets.get(me.id);
  const pickAndFinish = (chosen) => {
    const color = COLORS.includes(chosen) ? chosen : sample(COLORS);
    G.color = color; G.value = specialType;
    announce(L, `🎨 Color → ${color.toUpperCase()}.`);
    afterColor && afterColor();
  };
  if (!s) return pickAndFinish(sample(COLORS));
  io.to(me.id).emit("chooseColor");
  G.turnEndsAt = Date.now() + TURN_SECONDS * 1000;
  emitState(L);
  s.once("colorChosen", ({ color }) => pickAndFinish(color));
}

/* ---------------------------- Socket.IO ----------------------------- */
io.on("connection", (socket) => {
  socket.on("disconnect", () => {
    const L = lobbyOf(socket);
    if (L) cleanupLeaver(L, socket.id);
  });

  socket.on("join", ({ name, lobby })=>{
    const lobbyName = sanitizeName(lobby || "default");
    let L = lobbies.get(lobbyName) || createLobby(lobbyName);
    socket.join(L.room);
    socket.data.lobby = L.name;

    const playerName = sanitizeName(name);
    const seatedCount = L.players.filter(p=>!p.spectator).length;
    const spectator = seatedCount >= MAX_PLAYERS ? true : false;

    const me = { id: socket.id, sid: socket.id, lobby: L.name, name: playerName, spectator, misses:0 };
    L.players.push(me);
    announce(L, `👤 ${me.name} ${me.spectator?"joined as spectator.":"joined the game."}`);

    if (L.game?.started && !me.spectator) {
      restockDeckIfNeeded(L.game, 7);
      L.game.hands[me.sid] = [];
      for (let i=0;i<7;i++) drawOne(L.game, me.sid);
    }

    socket.emit("me", { id: me.sid, name: me.name, spectator: me.spectator, lobby: L.name });
    emitState(L);
    startCountdown(L);
  });

  // Chat (+ HAPPY mode auto-filter)
  socket.on("chat", ({ text })=>{
    const L = lobbyOf(socket); if (!L) return;
    const me = L.players.find(p=>p.id===socket.id); if (!me) return;
    const t = String(text||"").slice(0,200);
    io.in(L.room).emit("chat", { fromSid: me.sid, fromName: me.name, text: t });

    if (L.game?.roundFlags?.happy) {
      const low = t.toLowerCase();
      if (NOT_NICE_WORDS.some(w=> low.includes(w))) {
        drawOne(L.game, me.sid);
        announce(L, `😊 Happy Mode: ${me.name} said something not nice and draws 1.`);
        emitState(L);
      }
    }
  });

  socket.on("admin:chat", ({ text })=>{
    const L = lobbyOf(socket); if (!L) return;
    announce(L, `🛠️ Admin: ${String(text||"").slice(0,200)}`);
  });

  // UNO call
  socket.on("callUno", ()=>{
    const L = lobbyOf(socket); if (!L?.game?.started) return;
    const G = L.game; const me = L.players.find(p=>p.id===socket.id); if (!me) return;
    if (G.unoArmedSid === me.sid && (G.hands[me.sid]||[]).length===1) { G.unoSatisfied = true; announce(L, `📣 ${me.name} called UNO in time!`); }
    else announce(L, `📣 ${me.name} called UNO!`);
  });

  // Draw (on your turn)
  socket.on("drawCard", ()=>{
    const L = lobbyOf(socket); if (!L?.game?.started) return;
    const G = L.game; const me = L.players.find(p=>p.id===socket.id); if (!me) return;
    if (G.current !== me.sid) return;

    if (G.pendingPenalty && G.pendingPenalty.targetSid === me.sid) {
      const total = G.pendingPenalty.total;
      for (let i=0;i<total;i++) drawOne(G, me.sid);
      announce(L, `${me.name} drew ${total} (stack ended).`);
      G.pendingPenalty = null; G.relaxLock=false;
      me.misses = (me.misses||0) + 1;
      if (me.misses >= 3) { announce(L, `🛑 ${me.name} removed after 3 missed turns.`); cleanupLeaver(L, me.id); emitState(L); return; }
      advanceTurn(L,1); emitState(L); return;
    }

    drawOne(G, me.sid);
    announce(L, `🃏 ${me.name} drew 1 card.`);
    advanceTurn(L,1); emitState(L);
  });

  // Out-of-turn RELAX (no window): cancel stack if active
  socket.on("playRelaxRequested", () => {
    const L = lobbyOf(socket); if (!L?.game?.started) return;
    const G = L.game;
    const me = L.players.find(p => p.id === socket.id); if (!me) return;

    const hand = G.hands[me.sid] || [];
    const idx = hand.findIndex(c => c.type === "wild_relax");
    if (idx < 0) { io.to(me.id).emit("warn", "🧘 You don't have a RELAX card."); return; }

    const penaltyActive = !!G.pendingPenalty;
    const myTurn = (G.current === me.sid);
    if (!penaltyActive && !myTurn) { io.to(me.id).emit("warn", "🧘 RELAX can only be used on your turn or during a draw stack."); return; }
    if (!penaltyActive) { io.to(me.id).emit("warn", "🧘 RELAX cancels draw stacks — there's no stack to cancel."); return; }

    const card = hand.splice(idx, 1)[0];
    G.discard.push(card);

    const targetSid = G.pendingPenalty?.targetSid || G.current;
    G.pendingPenalty = null; G.relaxLock = true; if (targetSid) G.current = targetSid;
    announce(L, `🧘 RELAX! ${me.name} canceled the draw stack.`);

    endChooseColorAndFinish({
      io, L, G, me, specialType: "wild_relax",
      afterColor: () => { G.turnEndsAt = Date.now() + TURN_SECONDS * 1000; emitState(L); }
    });
  });

  // PLAY CARD
  socket.on("playCard", ({ index })=>{
    const L = lobbyOf(socket); if (!L?.game?.started) return;
    const G = L.game; const me = L.players.find(p=>p.id===socket.id); if (!me) return;
    if (G.current !== me.sid) return;
    const hand = G.hands[me.sid]||[];
    if (typeof index !== "number" || index<0 || index>=hand.length) return;
    const card = hand[index];

    // penalty target can only stack same type
    if (G.pendingPenalty && G.pendingPenalty.targetSid === me.sid) {
      const need = G.pendingPenalty.type;
      if (card.type !== need) return;
    }
    if (!legalMatch(G, card)) return;

    // play it
    hand.splice(index,1);
    G.discard.push(card);
    me.misses = 0; // successful action resets AFK counter
    announce(L, `${me.name}: played ${card.color} ${card.type}${card.value!==undefined?(" "+card.value):""}.`);

    // UNO arm
    if ((G.hands[me.sid]||[]).length === 1){ G.unoArmedSid = me.sid; G.unoSatisfied=false; announce(L, `⚠️ ${me.name} has 1 card — say UNO!`); }
    else if (G.unoArmedSid === me.sid){ G.unoArmedSid = null; G.unoSatisfied=false; }

    // Winner?
    const winNow = winnerIfAny(L); if (winNow) return settleAndQueueNext(L, winNow);

    // WILDS (color chosen at END)
    if (String(card.type).startsWith("wild")) {

      // WILD DRAW 4 — start stack then color
      if (card.type === "wild_draw4") {
        beginPenalty(L, me.sid, "wild_draw4");
        endChooseColorAndFinish({
          io, L, G, me, specialType: "wild_draw4",
          afterColor: () => { emitState(L); }
        });
        return;
      }

      // RELAX (in-turn) — only if stack exists
      if (card.type === "wild_relax") {
        if (!G.pendingPenalty) {
          G.discard.pop(); (G.hands[me.sid] = G.hands[me.sid] || []).push(card);
          io.to(me.id).emit("warn", "🧘 RELAX cancels draw stacks — there's no stack to cancel.");
          emitState(L);
          return;
        }
        const targetSid = G.pendingPenalty?.targetSid || G.current;
        G.pendingPenalty = null; G.relaxLock = true; if (targetSid) G.current = targetSid;
        announce(L, `🧘 RELAX! ${me.name} canceled the draw stack.`);
        endChooseColorAndFinish({
          io, L, G, me, specialType: "wild_relax",
          afterColor: () => { G.turnEndsAt = Date.now() + TURN_SECONDS * 1000; emitState(L); }
        });
        return;
      }

      // THE BOSS
      if (card.type === "wild_boss") {
        const actives = seatedPlayers(L);
        if (actives.length > 1) {
          const ranked = actives.map(p => {
            const s = scores[p.name] || { wins:0, points:0 };
            return { sid:p.sid, name:p.name, points:+(s.points||0), wins:+(s.wins||0) };
          }).sort((a,b)=> (b.points-a.points) || (b.wins-a.wins) || a.name.localeCompare(b.name));

          let recipientSid;
          if (!ranked.length) recipientSid = sample(actives).sid;
          else {
            const top = ranked[0];
            const ties = ranked.filter(r=> r.points===top.points && r.wins===top.wins);
            recipientSid = (ties.length>1 ? sample(ties).sid : top.sid);
          }
          const recipientName = sidToName(L, recipientSid);
          announce(L, `👑 THE BOSS: ${recipientName} receives a gift from each player!`);
          const recipientHand = G.hands[recipientSid] = (G.hands[recipientSid] || []);
          for (const p of actives) {
            if (p.sid === recipientSid) continue;
            const h = G.hands[p.sid] || [];
            if (!h.length) { announce(L, `🎁 ${p.name} has no card to gift.`); continue; }
            const idx2 = (Math.random()*h.length)|0;
            const given = h.splice(idx2,1)[0];
            recipientHand.push(given);
            announce(L, `🎁 ${p.name} gifts 1 card to ${recipientName}.`);
          }
        }
        const w = winnerIfAny(L); if (w) { settleAndQueueNext(L, w); return; }
        endChooseColorAndFinish({
          io, L, G, me, specialType: "wild_boss",
          afterColor: () => { advanceTurn(L,1); emitState(L); }
        });
        return;
      }

      // PACK YOUR BAGS
      if (card.type === "wild_packyourbags") {
        announce(L, `🧳 Pack Your Bags! Seats are being swapped — hands stay with seats.`);
        const order = activeOrder(L);
        if (order.length > 1) {
          const seatHands = order.map(sid => (G.hands[sid] || []));
          const curSeatIdx = order.findIndex(sid => sid === G.current);
          let penSeatIdx=null, fromSeatIdx=null;
          if (G.pendingPenalty) {
            penSeatIdx = order.findIndex(sid=>sid===G.pendingPenalty.targetSid);
            fromSeatIdx = order.findIndex(sid=>sid===G.pendingPenalty.lastFromSid);
          }
          const newOrder = order.slice(); shuffle(newOrder);
          for (let i=0;i<newOrder.length;i++) G.hands[newOrder[i]] = seatHands[i];
          for (const sid of Object.keys(G.hands)) if (!newOrder.includes(sid)) delete G.hands[sid];
          if (curSeatIdx>=0) G.current = newOrder[curSeatIdx];
          if (G.pendingPenalty) {
            if (penSeatIdx!=null && penSeatIdx>=0) G.pendingPenalty.targetSid = newOrder[penSeatIdx];
            if (fromSeatIdx!=null && fromSeatIdx>=0) G.pendingPenalty.lastFromSid = newOrder[fromSeatIdx];
          }
          G.unoArmedSid=null; G.unoSatisfied=false;
          const pairs=[]; const nameAt = sid=>sidToName(L,sid);
          for (let i=0;i<order.length;i++) { const a=nameAt(order[i]), b=nameAt(newOrder[i]); if (a!==b) pairs.push(`${a} → ${b}`); }
          if (pairs.length) announce(L, `🪑 Seats swapped: ${pairs.join(", ")}.`);
        }
        endChooseColorAndFinish({
          io, L, G, me, specialType: "wild_packyourbags",
          afterColor: () => { emitState(L); }
        });
        return;
      }

      // RAINBOW
      if (card.type === "wild_rainbow") {
        const hand2 = G.hands[me.sid] || [];
        const s = io.sockets.sockets.get(me.id);
        const autoPick = () => {
          const picks = []; const colors = new Set();
          for (let i=0;i<hand2.length && colors.size<4;i++) {
            if (COLORS.includes(hand2[i].color) && !colors.has(hand2[i].color)) { colors.add(hand2[i].color); picks.push(i); }
          }
          applyPick(picks);
        };
        const applyPick = (indices) => {
          const cards = []; const seen = new Set();
          const sorted = Array.from(new Set(indices)).sort((a,b)=>b-a);
          for (const ix of sorted) {
            if (ix<0 || ix>=hand2.length) continue;
            const c = hand2[ix];
            if (!COLORS.includes(c.color) || seen.has(c.color)) continue;
            seen.add(c.color); cards.push(hand2.splice(ix,1)[0]);
          }
          if (cards.length < 4) {
            for (let i=0;i<hand2.length && seen.size<4;i++) {
              const c=hand2[i]; if (COLORS.includes(c.color) && !seen.has(c.color)) { seen.add(c.color); cards.push(hand2.splice(i,1)[0]); i--; }
            }
          }
          putUnderSpecial(G, cards);
          announce(L, `🌈 Rainbow! ${me.name} discarded one of each color.`);
          endChooseColorAndFinish({
            io, L, G, me, specialType: "wild_rainbow",
            afterColor: () => { advanceTurn(L,1); emitState(L); }
          });
        };
        if (!s) { autoPick(); return; }
        io.to(me.id).emit("rainbowPick", { hand: hand2.map((c,i)=>({i,color:c.color,type:c.type,value:c.value??null})) });
        const t = setTimeout(()=> autoPick(), 20000);
        s.once("rainbowChosen", ({ indices })=>{ clearTimeout(t); applyPick(Array.isArray(indices)?indices:[]); });
        return;
      }

      // Plain WILD (color only)
      endChooseColorAndFinish({
        io, L, G, me, specialType: "wild",
        afterColor: () => { advanceTurn(L,1); emitState(L); }
      });
      return;
    } // end wilds

    // ACTIONS (non-wild)
    if (card.type === "reverse") {
      G.dir *= -1; announce(L, `🔄 Play direction reversed.`);
      if (activeOrder(L).length === 2) { announce(L, `⏭️ Reverse acts as Skip with 2 players.`); advanceTurn(L,1); emitState(L); return; }
      emitState(L); return;
    }
    if (card.type === "skip") { announce(L, `⏭️ Skipped next player.`); advanceTurn(L,2); emitState(L); return; }
    if (card.type === "draw2") { beginPenalty(L, me.sid, "draw2"); emitState(L); return; }

    // SPECIALS (color-gated or not as specified)

    // LOOK (blue_look) — top 4 reorder (or fewer)
    if (card.type === "blue_look") {
      const viewCount = Math.min(4, Math.max(0, (G.deck?.length||0)));
      restockDeckIfNeeded(G, viewCount);
      const peek = (G.deck || []).slice(-viewCount);
      const safePeek = peek.map((c,i)=> ({ i, color:c.color, type:c.type, value:c.value ?? null }));
      const s = io.sockets.sockets.get(me.id);
      if (!s) { advanceTurn(L,1); emitState(L); return; }
      io.to(me.id).emit("lookTop", { cards: safePeek });
      const originalIdxs = safePeek.map((_,i)=>i);
      const t = setTimeout(()=> applyOrder(originalIdxs), 20000);
      function applyOrder(orderIdxs){
        clearTimeout(t);
        const clean = Array.from(new Set(orderIdxs.map(Number))).filter(n=> n>=0 && n<safePeek.length);
        if (clean.length !== safePeek.length) { announce(L, `👀 Blue Look timed out; deck unchanged.`); finalize(); return; }
        const newTop = clean.map(i=> peek[i]);
        for (let i=0;i<viewCount;i++) G.deck[G.deck.length-viewCount+i] = newTop[i];
        announce(L, `👀 ${me.name} reordered the top of the deck.`);
        finalize();
      }
      function finalize(){ G.color = card.color; G.value = card.type; advanceTurn(L,1); emitState(L); }
      s.once("lookTopOrder", ({ order })=> applyOrder(Array.isArray(order)?order:originalIdxs));
      return;
    }

    // SHOPPING (yellow only)
    if (card.type === "yellow_shopping") {
      if (G.color !== "yellow") {
        G.discard.pop(); (G.hands[me.sid] = G.hands[me.sid] || []).push(card);
        io.to(me.id).emit("warn", "🛒 Shopping may only be played when the active color is YELLOW."); emitState(L); return;
      }
      const actives = seatedPlayers(L).map(p=>p.sid).filter(sid=> sid !== me.sid);
      const eligibleTargets = actives.filter(sid => (G.hands[sid] || []).length > 0);
      if (eligibleTargets.length === 0 || (G.hands[me.sid] || []).length < 2) {
        G.discard.pop(); (G.hands[me.sid] = G.hands[me.sid] || []).push(card);
        announce(L, `🛒 Shopping canceled — no valid target or you have fewer than 2 cards.`); emitState(L); return;
      }
      announce(L, `🛒 ${me.name} is shopping…`);
      let canceled = false;
      const cancelAndRevert = (msg) => {
        if (canceled) return; canceled = true;
        G.discard.pop(); (G.hands[me.sid] = G.hands[me.sid] || []).push(card);
        if (msg) io.to(me.id).emit("warn", msg);
        emitState(L);
      };
      const targets = eligibleTargets.map(sid => ({ sid, name: sidToName(L, sid) }));
      const s = io.sockets.sockets.get(me.id);
      if (!s) { cancelAndRevert(); return; }
      io.to(me.id).emit("shoppingChooseTarget", { targets });
      const overallTimeout = setTimeout(() => cancelAndRevert("🛒 Shopping timed out."), 20000);
      s.once("shoppingTargetChosen", ({ sid: targetSid }) => {
        if (canceled) return; if (!eligibleTargets.includes(targetSid)) return cancelAndRevert("🛒 Invalid target.");
        const myHandSafe = (G.hands[me.sid] || []).map((c, i) => ({ i, color: c.color, type: c.type, value: c.value ?? null }));
        const tgtHandSafe = (G.hands[targetSid] || []).map((c, i) => ({ i, color: c.color, type: c.type, value: c.value ?? null }));
        if (myHandSafe.length < 2 || tgtHandSafe.length < 1) return cancelAndRevert("🛒 Not enough cards to trade.");
        io.to(me.id).emit("shoppingPickGive", { hand: myHandSafe });
        s.once("shoppingGiveChosen", ({ idx1, idx2 }) => {
          if (canceled) return;
          const i1 = Number(idx1), i2 = Number(idx2);
          if (!Number.isInteger(i1) || !Number.isInteger(i2) || i1 === i2) return cancelAndRevert("🛒 Pick two different cards to give.");
          io.to(me.id).emit("shoppingPickTake", { hand: tgtHandSafe });
          s.once("shoppingTakeChosen", ({ idx }) => {
            if (canceled) return;
            const tIdx = Number(idx);
            const myHand = G.hands[me.sid] || [];
            const tgtHand = G.hands[targetSid] || [];
            if (myHand.length < 2 || tIdx < 0 || tIdx >= tgtHand.length) return cancelAndRevert("🛒 Invalid selection.");
            const sorted = [i1, i2].sort((a, b) => b - a);
            const giving = [];
            for (const ix of sorted) { if (ix < 0 || ix >= myHand.length) return cancelAndRevert("🛒 Your selection no longer valid."); giving.push(myHand.splice(ix, 1)[0]); }
            const taking = tgtHand.splice(tIdx, 1)[0];
            tgtHand.push(...giving);
            myHand.push(taking);
            announce(L, `🛒 ${me.name} swapped 2→1 with ${sidToName(L, targetSid)}.`);
            clearTimeout(overallTimeout);
            G.color = card.color; G.value = card.type;
            const w = winnerIfAny(L); if (w) { settleAndQueueNext(L, w); return; }
            advanceTurn(L, 1); emitState(L);
          });
        });
      });
      return;
    }

    // HAPPY (green_happy) — toggles filter for the rest of the game
    if (card.type === "green_happy") {
      G.roundFlags = G.roundFlags || {};
      G.roundFlags.happy = true;
      announce(L, `😊 Happy Mode enabled for the rest of the round.`);
      G.color = card.color; G.value = card.type;
      advanceTurn(L,1); emitState(L); return;
    }

    // RECYCLE (green only): redistribute evenly; extras under special
    if (card.type === "green_recycle") {
      if (G.color !== "green") {
        G.discard.pop(); (G.hands[me.sid] = G.hands[me.sid] || []).push(card);
        io.to(me.id).emit("warn","♻️ Recycle may only be played when the active color is GREEN."); emitState(L); return;
      }
      const actives = seatedPlayers(L);
      if (actives.length < 2) {
        G.discard.pop(); (G.hands[me.sid] = G.hands[me.sid] || []).push(card);
        announce(L, `♻️ Recycle canceled — not enough players to redistribute.`); emitState(L); return;
      }
      const pool = [];
      for (const p of actives) { const h = G.hands[p.sid] || []; while (h.length) pool.push(h.pop()); }
      for (let i=pool.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [pool[i],pool[j]]=[pool[j],pool[i]]; }
      const each = Math.floor(pool.length / actives.length);
      const extras = pool.length % actives.length;
      for (const p of actives) { G.hands[p.sid] = pool.splice(0, each); }
      const extraCards = pool.splice(0, extras);
      if (extraCards.length) putUnderSpecial(G, extraCards);
      announce(L, `♻️ Recycle! Each player received ${each} card(s). ${extras ? `${extras} card(s) were recycled under the pile.` : `No extras this time.`}`);
      G.color = card.color; G.value = card.type;
      const w2 = winnerIfAny(L); if (w2) { settleAndQueueNext(L, w2); return; }
      advanceTurn(L, 1); emitState(L); return;
    }

    // PINKY PROMISE (yellow only): combine+shuffle+split; odd extra randomly assigned
    if (card.type === "yellow_pinkypromise") {
      if (G.color !== "yellow") {
        G.discard.pop(); (G.hands[me.sid] = G.hands[me.sid] || []).push(card);
        io.to(me.id).emit("warn", "🤝 Pinky Promise may only be played when the active color is YELLOW."); emitState(L); return;
      }
      const others = seatedPlayers(L).map(p => p.sid).filter(sid => sid !== me.sid);
      if (others.length === 0) {
        G.discard.pop(); (G.hands[me.sid] = G.hands[me.sid] || []).push(card);
        announce(L, `🤝 Pinky Promise canceled — no other players available.`); emitState(L); return;
      }
      announce(L, `🤝 ${me.name} is making a Pinky Promise…`);
      let canceled = false;
      const cancelAndRevert = (msg) => {
        if (canceled) return; canceled = true;
        G.discard.pop(); (G.hands[me.sid] = G.hands[me.sid] || []).push(card);
        if (msg) io.to(me.id).emit("warn", msg);
        emitState(L);
      };
      const targets = others.map(sid => ({ sid, name: sidToName(L, sid) }));
      const s = io.sockets.sockets.get(me.id);
      if (!s) { cancelAndRevert(); return; }
      if (targets.length === 1) { resolvePromise(targets[0].sid); }
      else {
        io.to(me.id).emit("promiseChooseTarget", { targets });
        const t = setTimeout(() => cancelAndRevert("🤝 Pinky Promise timed out."), 20000);
        s.once("promiseTargetChosen", ({ sid }) => { clearTimeout(t); if (!others.includes(sid)) return cancelAndRevert("🤝 Invalid target."); resolvePromise(sid); });
      }
      function resolvePromise(targetSid) {
        if (canceled) return;
        const aHand = G.hands[me.sid] = (G.hands[me.sid] || []);
        const bHand = G.hands[targetSid] = (G.hands[targetSid] || []);
        const pool = aHand.splice(0, aHand.length).concat(bHand.splice(0, bHand.length));
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        const base = Math.floor(pool.length / 2);
        const extra = (pool.length % 2);
        const giveExtraToA = extra ? (Math.random() < 0.5) : false;
        const aCount = base + (giveExtraToA ? 1 : 0);
        const bCount = base + (giveExtraToA ? 0 : 1);
        G.hands[me.sid] = pool.splice(0, aCount);
        G.hands[targetSid] = pool.splice(0, bCount);
        announce(L, `🤝 Pinky Promise! ${me.name} and ${sidToName(L, targetSid)} reshuffled and split their hands (received ${aCount} & ${bCount}${extra ? "; extra assigned randomly" : ""}).`);
        G.color = card.color; G.value = card.type;
        const w = winnerIfAny(L); if (w) { settleAndQueueNext(L, w); return; }
        advanceTurn(L, 1); emitState(L);
      }
      return;
    }

    // TO THE MOON (blue only): random other player draws 1 (rocket lands)
    if (card.type === "blue_moon") {
      if (G.color !== "blue") {
        G.discard.pop(); (G.hands[me.sid] = G.hands[me.sid] || []).push(card);
        io.to(me.id).emit("warn", "🌙 To The Moon may only be played when the active color is BLUE."); emitState(L); return;
      }
      const actives = seatedPlayers(L).filter(p => p.sid !== me.sid);
      if (actives.length === 0) {
        G.discard.pop(); (G.hands[me.sid] = G.hands[me.sid] || []).push(card);
        announce(L, `🌙 To The Moon canceled — no other players available.`); emitState(L); return;
      }
      const recipient = sample(actives);
      drawOne(G, recipient.sid);
      announce(L, `🚀 To The Moon! A rocket lands near ${recipient.name}, delivering 1 extra card.`);
      G.color = card.color; G.value = card.type;
      const w = winnerIfAny(L); if (w) { settleAndQueueNext(L, w); return; }
      advanceTurn(L, 1); emitState(L); return;
    }

    // IT (red only): float random card from previous to next; 2P = gag
    if (card.type === "red_it") {
      if (G.color !== "red") {
        G.discard.pop(); (G.hands[me.sid] = G.hands[me.sid] || []).push(card);
        io.to(me.id).emit("warn", "🧢 IT may only be played when the active color is RED."); emitState(L); return;
      }
      const order = activeOrder(L);
      if (order.length === 2) {
        announce(L, "🧢 IT peeks from the sewer… with only two players, Georgie’s paper boat just sails by. ‘We all float,’ whispers Pennywise.");
        G.color = card.color; G.value = card.type;
        advanceTurn(L, 1); emitState(L); return;
      }
      const prevSid = previousActiveSid(L, me.sid);
      const nextSid = nextActiveSid(L, me.sid);
      if (!prevSid || !nextSid || prevSid === nextSid) {
        announce(L, "🧢 IT slinks back into the sewer. Georgie’s boat vanishes down the drain…");
        G.color = card.color; G.value = card.type;
        advanceTurn(L, 1); emitState(L); return;
      }
      const prevHand = G.hands[prevSid] = (G.hands[prevSid] || []);
      const nextHand = G.hands[nextSid] = (G.hands[nextSid] || []);
      if (prevHand.length === 0) {
        announce(L, `🧢 IT tried to float a card from ${sidToName(L, prevSid)}, but there was nothing to float.`);
        G.color = card.color; G.value = card.type;
        advanceTurn(L, 1); emitState(L); return;
      }
      const idx2 = (Math.random() * prevHand.length) | 0;
      const floated = prevHand.splice(idx2, 1)[0];
      nextHand.push(floated);
      announce(L, `🧢 IT! ${sidToName(L, prevSid)} floats 1 random card to ${sidToName(L, nextSid)}.`);
      G.color = card.color; G.value = card.type;
      const w = winnerIfAny(L); if (w) { settleAndQueueNext(L, w); return; }
      advanceTurn(L, 1); emitState(L); return;
    }

    // NOC NOTICE (red only): first random target incl. self; repeats hit same until round end
    if (card.type === "red_noc") {
      if (G.color !== "red") {
        G.discard.pop(); (G.hands[me.sid] = G.hands[me.sid] || []).push(card);
        io.to(me.id).emit("warn", "📄 NOC Notice may only be played when the active color is RED."); emitState(L); return;
      }
      if (!G.nocTarget) {
        const actives = seatedPlayers(L);
        if (actives.length === 0) {
          G.discard.pop(); (G.hands[me.sid] = G.hands[me.sid] || []).push(card);
          announce(L, `📄 NOC Notice canceled — no seated players.`); emitState(L); return;
        }
        const chosen = sample(actives);
        G.nocTarget = chosen.sid;
        for (let i=0;i<3;i++) drawOne(G, chosen.sid);
        announce(L, `📄 NOC Notice issued! ${chosen.name} has been flagged and must draw 3.`);
      } else {
        const target = sidToPlayer(L, G.nocTarget);
        if (!target) {
          announce(L, `📄 NOC Notice reminder attempted, but previous target left the game.`);
        } else {
          for (let i=0;i<3;i++) drawOne(G, target.sid);
          announce(L, `📄 NOC Notice reminder: ${target.name} is still flagged and draws 3 more.`);
        }
      }
      G.color = card.color; G.value = card.type;
      const w = winnerIfAny(L); if (w) { settleAndQueueNext(L, w); return; }
      advanceTurn(L, 1); emitState(L); return;
    }

    // NUMBERS / default symbol resolution
    G.color = card.color;
    G.value = (card.type==="number") ? card.value : card.type;
    advanceTurn(L,1); emitState(L);
  });

});

/* ------------------------- Stacking Penalties ------------------------ */
function beginPenalty(L, fromSid, type){
  const G = L.game; const add = (type==="draw2")?2:4;
  if (!G.pendingPenalty) {
    const next = nextActiveSid(L, fromSid);
    G.pendingPenalty = { total:add, type:(type==="draw2"?"draw2":"wild_draw4"), targetSid: next, lastFromSid: fromSid };
    G.current = next; G.turnEndsAt = Date.now()+TURN_SECONDS*1000;
    announce(L, `⚠️ ${sidToName(L, fromSid)} started a stack (+${add}). ${sidToName(L, next)} can stack or draw.`);
    return;
  }
  const add2 = (type==="draw2")?2:4;
  G.pendingPenalty.total += add2;
  G.pendingPenalty.lastFromSid = fromSid;
  const newTarget = nextActiveSid(L, fromSid);
  G.pendingPenalty.targetSid = newTarget;
  announce(L, `➕ Stack continues (+${add2}, total ${G.pendingPenalty.total}). Now targeting ${sidToName(L, newTarget)}.`);
}

/* -------------------------------------------------------------------- */
server.listen(PORT, ()=> console.log(`UNO listening on :${PORT}`));
