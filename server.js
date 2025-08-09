// Robust UNO server
const express = require("express");
const http = require("http");
const fs = require("fs");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* ---------- Static ---------- */
app.use(express.static("public"));
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

/* ---------- Persistent scores (ephemeral on Render unless a disk is attached) ---------- */
const SCORE_PATH = "./scores.json";
let scores = {};
try {
  if (fs.existsSync(SCORE_PATH)) scores = JSON.parse(fs.readFileSync(SCORE_PATH, "utf8") || "{}");
} catch { scores = {}; }
function saveScores() {
  try { fs.writeFileSync(SCORE_PATH, JSON.stringify(scores, null, 2)); } catch {}
}
app.get("/scores", (_req, res) => res.json(scores));

/* ---------- Game state ---------- */
const MAX_PLAYERS = 10;
const TURN_SECONDS = 60;
const COUNTDOWN_SECONDS = 20;
const MISSES_TO_KICK = 3;

let players = []; // {id,name,spectator,misses}
let game = null;  // {started, deck, discard, color, value, typeAsValue, dir, turnIdx, current, hands, countdownEndsAt, turnEndsAt}
let countdownTimer = null;
let turnTicker = null;

/* ---------- Helpers ---------- */
const ANIMALS = ["Aardvark","Badger","Cougar","Dolphin","Eagle","Fox","Giraffe","Hedgehog","Iguana","Jaguar","Koala","Lemur","Manatee","Narwhal","Otter","Panda","Quokka","Raccoon","Sloth","Turtle","Urchin","Vulture","Walrus","Yak","Zebra"];
const NUM = ["One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten"];
function uniqueName(base) {
  let name = String(base||"").trim();
  if (!name) name = `${NUM[Math.min(players.length,9)]} ${ANIMALS[Math.floor(Math.random()*ANIMALS.length)]}`;
  const taken = new Set(players.map(p=>p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let n = 2; while (taken.has(`${name} ${n}`.toLowerCase())) n++;
  return `${name} ${n}`;
}
function announce(t){ io.emit("announce", t); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function deckNew(){
  const colors = ["red","yellow","green","blue"];
  const d=[];
  for (const c of colors) {
    d.push({color:c,type:"number",value:0});
    for (let v=1; v<=9; v++){ d.push({color:c,type:"number",value:v}); d.push({color:c,type:"number",value:v}); }
    for (let i=0;i<2;i++){ d.push({color:c,type:"skip"}); d.push({color:c,type:"reverse"}); d.push({color:c,type:"draw2"}); }
  }
  for (let i=0;i<4;i++){ d.push({color:"wild",type:"wild"}); d.push({color:"wild",type:"wild_draw4"}); }
  return shuffle(d);
}
function drawOne(id){
  if (!game) return null;
  if (game.deck.length === 0) {
    const top = game.discard.pop();
    game.deck = shuffle(game.discard);
    game.discard = [top];
  }
  const card = game.deck.pop();
  if (!game.hands[id]) game.hands[id] = [];
  game.hands[id].push(card);
  return card;
}
function cardMatchesTop(card, color, value) {
  if (card.type === "wild" || card.type === "wild_draw4") return true;
  if (card.type === "number") return card.color === color || card.value === value;
  return card.color === color || card.type === value; // value stores last action type for actions
}
function emitState(){
  const state = {
    started: !!game?.started,
    countdownEndsAt: game?.countdownEndsAt || null,
    turnEndsAt: game?.turnEndsAt || null,
    current: game?.current || null,
    direction: game?.dir || 1,
    color: game?.color || null,
    top: game?.discard?.[game.discard.length-1] || null,
    players: players.map(p=>({ id:p.id, name:p.name, spectator:!!p.spectator, handCount: game?.hands?.[p.id]?.length ?? 0 }))
  };
  io.emit("state", state);
}
function activeOrder(){ return players.filter(p=>!p.spectator).map(p=>p.id); }
function nextIdx(idx, dir, order){ return (idx + dir + order.length) % order.length; }
function winnerIfAny(){
  if (!game) return null;
  for (const pid of Object.keys(game.hands || {})) if (game.hands[pid].length === 0) return pid;
  return null;
}
function startCountdown(){
  if (game?.started || countdownTimer) return;
  if (players.filter(p=>!p.spectator).length < 2) return;
  const endsAt = Date.now() + COUNTDOWN_SECONDS*1000;
  game = { started:false, countdownEndsAt: endsAt };
  announce(`⏳ Game starts in ${COUNTDOWN_SECONDS}s…`);
  emitState();
  countdownTimer = setInterval(()=>{
    const enough = players.filter(p=>!p.spectator).length >= 2;
    if (!enough) { clearInterval(countdownTimer); countdownTimer=null; game=null; announce("❌ Countdown canceled—need at least 2 players."); emitState(); return; }
    if (Date.now() >= endsAt) { clearInterval(countdownTimer); countdownTimer=null; initGame(); }
  }, 300);
}
function initGame(){
  const order = activeOrder();
  const deck = deckNew();
  const hands = {};
  for (const id of order) hands[id] = [deck.pop(),deck.pop(),deck.pop(),deck.pop(),deck.pop(),deck.pop(),deck.pop()];
  // ensure first top is number
  let first = deck.pop();
  while (first.type !== "number") { deck.unshift(first); shuffle(deck); first = deck.pop(); }
  game = {
    started:true, deck, discard:[first],
    color:first.color, value:first.value, dir:1,
    hands, turnIdx:0, current: order[0] || null,
    countdownEndsAt:null, turnEndsAt: Date.now()+TURN_SECONDS*1000
  };
  for (const p of players) p.misses = 0;
  clearInterval(turnTicker);
  turnTicker = setInterval(onTurnTick, 250);
  announce("🎉 Game started!");
  emitState();
}
function endGameIfNeeded(){
  const order = activeOrder();
  if (order.length <= 1 && game) {
    announce("❗ Game ended: not enough players.");
    game = null;
    emitState();
  }
}
function advanceTurn(skips=1){
  const order = activeOrder();
  if (order.length === 0) { endGameIfNeeded(); return; }
  let idx = game.turnIdx;
  for (let i=0;i<skips;i++) idx = nextIdx(idx, game.dir, order);
  game.turnIdx = idx;
  game.current = order[idx];
  game.turnEndsAt = Date.now() + TURN_SECONDS*1000;
}
function onTurnTick(){
  if (!game?.started || !game.current) return;
  if (Date.now() < game.turnEndsAt) return;
  const p = players.find(x=>x.id===game.current);
  if (p && !p.spectator) {
    p.misses = (p.misses||0)+1;
    drawOne(p.id);
    announce(`⏰ ${p.name} ran out of time and drew 1.`);
    if (p.misses >= MISSES_TO_KICK) {
      announce(`🚪 ${p.name} removed after ${MISSES_TO_KICK} missed turns.`);
      // fold their hand back into deck
      for (const c of game.hands[p.id] || []) game.deck.push(c);
      delete game.hands[p.id];
      const idx = players.findIndex(pp=>pp.id===p.id);
      if (idx>=0) players.splice(idx,1);
      // reset order index safely
      const order = activeOrder();
      if (order.length === 0) { endGameIfNeeded(); emitState(); return; }
      game.turnIdx = Math.min(game.turnIdx, order.length-1);
      game.current = order[game.turnIdx];
    }
  }
  advanceTurn(1);
  emitState();
}
function maybeUnoPenalty(pid){
  if (!game) return;
  const hand = game.hands[pid] || [];
  if (hand.length === 1) {
    const sock = io.sockets.sockets.get(pid);
    if (!sock?.unoCalled) {
      drawOne(pid); drawOne(pid);
      announce(`⚠️ UNO penalty (+2).`);
    }
  }
  // clear UNO flags at end of action
  for (const [, s] of io.sockets.sockets) s.unoCalled = false;
}

/* ---------- Sockets ---------- */
io.on("connection", (socket) => {
  console.log("✅ connection", socket.id);
  socket.emit("helloAck", { ok:true, you:socket.id, at:Date.now() });

  // Join (always ACK)
  socket.on("join", (rawName) => {
    const name = uniqueName(rawName);
    let me = players.find(p=>p.id===socket.id);
    if (!me) {
      const spectator = !!(game?.started) || players.filter(p=>!p.spectator).length >= MAX_PLAYERS;
      me = { id:socket.id, name, spectator, misses:0 };
      players.push(me);
      announce(`👤 ${me.name} ${me.spectator?"joined as spectator.":"joined the game."}`);
    } else {
      me.name = name;
    }
    // ACK right away so client flips screens
    socket.emit("me", { id: me.id, name: me.name, spectator: me.spectator });

    // Late-join promote if room during a live game
    if (game?.started && me.spectator && activeOrder().length < MAX_PLAYERS) {
      me.spectator = false;
      if (!game.hands[me.id]) game.hands[me.id] = [];
      for (let i=0;i<7;i++) drawOne(me.id);
      announce(`➕ ${me.name} joined the round (late).`);
    }

    if (!game?.started && players.filter(p=>!p.spectator).length >= 2) startCountdown();
    emitState();
  });

  // Diagnostics (optional, safe)
  socket.on("clientJoinClick", (p)=>{ console.log("🖱️ joinClick", socket.id, p); });

  // Hand snapshot (privacy: only to requester)
  socket.on("getMyHand", () => {
    socket.emit("handSnapshot", (game?.hands?.[socket.id]) || []);
  });

  // Gameplay
  socket.on("drawCard", () => {
    if (!game?.started || game.current !== socket.id) return;
    drawOne(socket.id);
    announce(`🃏 Drew 1 card.`);
    advanceTurn(1);
    emitState();
  });

  socket.on("callUno", () => {
    if (!game?.started) return;
    socket.unoCalled = true;
    announce(`📣 ${players.find(p=>p.id===socket.id)?.name || "Player"} called UNO!`);
  });

  socket.on("playCard", ({ index }) => {
    if (!game?.started || game.current !== socket.id) return;
    const hand = game.hands[socket.id] || [];
    if (typeof index !== "number" || index<0 || index>=hand.length) return;
    const card = hand[index];
    if (!cardMatchesTop(card, game.color, game.value)) return;

    // remove and place
    hand.splice(index,1);
    game.discard.push(card);

    if (card.type === "wild" || card.type === "wild_draw4") {
      game.value = card.type; // temporary
      game.color = "wild";
      io.to(socket.id).emit("chooseColor");
      // only accept first choice per wild
      const chooseOnce = ({ color }) => {
        const valid = ["red","yellow","green","blue"];
        const chosen = valid.includes(color) ? color : valid[Math.floor(Math.random()*4)];
        game.color = chosen;
        if (card.type === "wild_draw4") {
          const order = activeOrder();
          const nextId = order[nextIdx(game.turnIdx, game.dir, order)];
          for (let i=0;i<4;i++) drawOne(nextId);
          advanceTurn(1);
          announce(`🌪️ WILD +4 → ${chosen.toUpperCase()}`);
        } else {
          advanceTurn(1);
          announce(`🌈 WILD → ${chosen.toUpperCase()}`);
        }
        maybeUnoPenalty(socket.id);
        const w = winnerIfAny();
        if (w) {
          const n = players.find(p=>p.id===w)?.name || "Player";
          announce(`🏆 ${n} wins the round!`);
          scores[n] = (scores[n]||0)+1; saveScores();
          game = null; emitState(); return;
        }
        emitState();
      };
      socket.once("colorChosen", chooseOnce);
      return;
    }

    // colored card effects
    game.color = card.color;
    game.value = card.type === "number" ? card.value : card.type;

    if (card.type === "number") {
      advanceTurn(1);
    } else if (card.type === "skip") {
      announce(`⛔ Skip next`);
      advanceTurn(2);
    } else if (card.type === "reverse") {
      game.dir *= -1;
      announce(`🔁 Reverse direction`);
      if (activeOrder().length === 2) advanceTurn(2); else advanceTurn(1);
    } else if (card.type === "draw2") {
      const order = activeOrder();
      const nextId = order[nextIdx(game.turnIdx, game.dir, order)];
      drawOne(nextId); drawOne(nextId);
      announce(`➕2 next player`);
      advanceTurn(2);
    }

    maybeUnoPenalty(socket.id);

    const w = winnerIfAny();
    if (w) {
      const n = players.find(p=>p.id===w)?.name || "Player";
      announce(`🏆 ${n} wins the round!`);
      scores[n] = (scores[n]||0)+1; saveScores();
      game = null; emitState(); return;
    }
    emitState();
  });

  socket.on("disconnect", () => {
    const idx = players.findIndex(p=>p.id===socket.id);
    if (idx>=0) {
      const gone = players[idx];
      players.splice(idx,1);
      announce(`👋 ${gone.name} left.`);
    }
    endGameIfNeeded();
    emitState();
  });
});

server.listen(PORT, () => console.log("🚀 listening on", PORT));
