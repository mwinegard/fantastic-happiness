// Robust UNO server with reconnect, server-pushed hands, and card image support
const express = require("express");
const http = require("http");
const fs = require("fs");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

/* ---------- Scores (ephemeral on Render unless a disk is attached) ---------- */
const SCORE_PATH = "./scores.json";
let scores = {};
try { if (fs.existsSync(SCORE_PATH)) scores = JSON.parse(fs.readFileSync(SCORE_PATH, "utf8") || "{}"); } catch {}
function saveScores(){ try { fs.writeFileSync(SCORE_PATH, JSON.stringify(scores, null, 2)); } catch {} }
app.get("/scores", (_req, res) => res.json(scores));

/* ---------- Game state ---------- */
const MAX_PLAYERS = 10;
const TURN_SECONDS = 60;
const COUNTDOWN_SECONDS = 20;
const MISSES_TO_KICK = 3;

let players = []; // {id,sid,clientId,name,spectator,misses,lastChatAt}
let game = null;  // {started, deck, discard, color, value, dir, turnIdx, current, hands, countdownEndsAt, turnEndsAt}
let countdownTimer = null;
let turnTicker = null;

/* ---------- Helpers ---------- */
const ANIMALS = ["Aardvark","Badger","Cougar","Dolphin","Eagle","Fox","Giraffe","Hedgehog","Iguana","Jaguar","Koala","Lemur","Manatee","Narwhal","Otter","Panda","Quokka","Raccoon","Sloth","Turtle","Urchin","Vulture","Walrus","Yak","Zebra"];
const NUM = ["One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten"];

function uniqueName(base) {
  let name = String(base||"").trim();
  if (!name) name = `${NUM[Math.min(players.length,9)]} ${ANIMALS[Math.floor(Math.random()*ANIMALS.length)]}`;
  const taken = new Set(players.map(p => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let n = 2; while (taken.has(`${name} ${n}`.toLowerCase())) n++;
  return `${name} ${n}`;
}

function announce(t){ io.emit("announce", t); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }

function cardImageName(card) {
  if (card.color === "wild") return `${card.type}.png`; // wild.png or wild_draw4.png
  if (card.type === "number") return `${card.color}_${card.value}.png`;
  // Our assets name Draw Two as "<color>_draw.png"
  if (card.type === "draw2") return `${card.color}_draw.png`;
  // skip / reverse match their names directly
  return `${card.color}_${card.type}.png`;
}

function deckNew(){
  const colors = ["red","yellow","green","blue"];
  const d=[];
  for (const c of colors) {
    d.push({color:c,type:"number",value:0, img:`${c}_0.png`});
    for (let v=1; v<=9; v++){
      d.push({color:c,type:"number",value:v, img:`${c}_${v}.png`});
      d.push({color:c,type:"number",value:v, img:`${c}_${v}.png`});
    }
    for (let i=0;i<2;i++){
      d.push({color:c,type:"skip",    img:`${c}_skip.png`});
      d.push({color:c,type:"reverse", img:`${c}_reverse.png`});
      d.push({color:c,type:"draw2",   img:`${c}_draw.png`});
    }
  }
  for (let i=0;i<4;i++){
    d.push({color:"wild",type:"wild",       img:`wild.png`});
    d.push({color:"wild",type:"wild_draw4", img:`wild_draw4.png`});
  }
  return shuffle(d);
}

function drawOne(sid){
  if (!game) return null;
  if (game.deck.length === 0) {
    const top = game.discard.pop();
    game.deck = shuffle(game.discard);
    game.discard = [top];
  }
  const card = game.deck.pop();
  if (!card.img) card.img = cardImageName(card);
  if (!game.hands[sid]) game.hands[sid] = [];
  game.hands[sid].push(card);
  return card;
}

function cardMatchesTop(card, color, value) {
  if (card.type === "wild" || card.type === "wild_draw4") return true;
  if (card.type === "number") return card.color === color || card.value === value;
  return card.color === color || card.type === value; // for actions, value stores last action type
}

function activeOrder(){ return players.filter(p=>!p.spectator).map(p=>p.sid); }
function nextIdx(idx, dir, order){ return (idx + dir + order.length) % order.length; }
function winnerIfAny(){
  if (!game) return null;
  for (const pid of Object.keys(game.hands || {})) if (game.hands[pid].length === 0) return pid;
  return null;
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
    players: players.map(p=>({ id:p.sid, name:p.name, spectator:!!p.spectator, handCount: game?.hands?.[p.sid]?.length ?? 0 }))
  };
  io.emit("state", state);
  // Push each player's hand privately (no client polling needed)
  if (game?.hands) {
    for (const p of players) {
      const hand = game.hands[p.sid] || [];
      io.to(p.id).emit("handSnapshot", hand);
    }
  }
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
  for (const sid of order) hands[sid] = [deck.pop(),deck.pop(),deck.pop(),deck.pop(),deck.pop(),deck.pop(),deck.pop()];
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
  const p = players.find(x=>x.sid===game.current);
  if (p && !p.spectator) {
    p.misses = (p.misses||0)+1;
    drawOne(p.sid);
    announce(`⏰ ${p.name} ran out of time and drew 1.`);
    if (p.misses >= MISSES_TO_KICK) {
      announce(`🚪 ${p.name} removed after ${MISSES_TO_KICK} missed turns.`);
      for (const c of game.hands[p.sid] || []) game.deck.push(c);
      delete game.hands[p.sid];
      const i = players.findIndex(pp=>pp.sid===p.sid);
      if (i>=0) players.splice(i,1);
      const order = activeOrder();
      if (order.length === 0) { endGameIfNeeded(); emitState(); return; }
      game.turnIdx = Math.min(game.turnIdx, order.length-1);
      game.current = order[game.turnIdx];
    }
  }
  advanceTurn(1);
  emitState();
}

function maybeUnoPenalty(sid){
  if (!game) return;
  const hand = game.hands[sid] || [];
  if (hand.length === 1) {
    const sock = players.find(p=>p.sid===sid);
    const s = sock && io.sockets.sockets.get(sock.id);
    if (!s?.unoCalled) {
      drawOne(sid); drawOne(sid);
      announce(`⚠️ UNO penalty (+2).`);
    }
  }
  for (const [, s] of io.sockets.sockets) s.unoCalled = false;
}

/* ---------- Sockets ---------- */
io.on("connection", (socket) => {
  console.log("✅ connection", socket.id);
  socket.emit("helloAck", { ok:true, you:socket.id, at:Date.now() });

  // JOIN (supports reconnect via clientId)
  socket.on("join", (payload) => {
    let name = ""; let clientId = "";
    if (typeof payload === "string") { name = payload; }
    else if (payload && typeof payload === "object") { name = payload.name || ""; clientId = payload.clientId || ""; }
    name = uniqueName(name);

    let me = clientId && players.find(p => p.clientId === clientId);
    if (me) {
      me.id = socket.id;
      me.sid = me.sid || socket.id;
      me.name = name || me.name;
      console.log("🔗 Reconnected", me.name, "sid:", me.sid);
    } else {
      const spectator = !!(game?.started) || players.filter(p=>!p.spectator).length >= MAX_PLAYERS;
      me = { id:socket.id, sid:socket.id, clientId: clientId || (`c_${Math.random().toString(36).slice(2)}`), name, spectator, misses:0, lastChatAt:0 };
      players.push(me);
      announce(`👤 ${me.name} ${me.spectator?"joined as spectator.":"joined the game."}`);
    }

    socket.emit("me", { id: me.sid, name: me.name, spectator: me.spectator, clientId: me.clientId });

    if (game?.started && me.spectator && activeOrder().length < MAX_PLAYERS) {
      me.spectator = false;
      if (!game.hands[me.sid]) game.hands[me.sid] = [];
      while (game.hands[me.sid].length < 7) drawOne(me.sid);
      announce(`➕ ${me.name} joined the round (late).`);
    }

    if (!game?.started && players.filter(p=>!p.spectator).length >= 2) startCountdown();
    emitState();
  });

  // Chat (simple throttle)
  socket.on("chat", (msg) => {
    const me = players.find(p=>p.id===socket.id);
    if (!me) return;
    const now = Date.now();
    if (now - (me.lastChatAt || 0) < 700) return;
    me.lastChatAt = now;
    io.emit("chat", { from: me.name, msg: String(msg || "").slice(0, 400) });
  });

  // UNO + draw + play
  socket.on("callUno", () => {
    const me = players.find(p=>p.id===socket.id);
    if (!me || !game?.started) return;
    socket.unoCalled = true;
    announce(`📣 ${me.name} called UNO!`);
  });

  socket.on("drawCard", () => {
    const me = players.find(p=>p.id===socket.id);
    if (!me || !game?.started || game.current !== me.sid) return;
    drawOne(me.sid);
    announce(`🃏 ${me.name} drew 1 card.`);
    advanceTurn(1);
    emitState();
  });

  socket.on("playCard", ({ index }) => {
    const me = players.find(p=>p.id===socket.id);
    if (!me || !game?.started || game.current !== me.sid) return;
    const hand = game.hands[me.sid] || [];
    if (typeof index !== "number" || index<0 || index>=hand.length) return;
    const card = hand[index];
    if (!card.img) card.img = cardImageName(card);
    if (!cardMatchesTop(card, game.color, game.value)) return;

    hand.splice(index,1);
    game.discard.push(card);

    if (card.type === "wild" || card.type === "wild_draw4") {
      game.value = card.type;
      game.color = "wild";
      io.to(me.id).emit("chooseColor");
      socket.once("colorChosen", ({ color }) => {
        const valid = ["red","yellow","green","blue"];
        const chosen = valid.includes(color) ? color : valid[Math.floor(Math.random()*4)];
        game.color = chosen;
        if (card.type === "wild_draw4") {
          const order = activeOrder();
          const nextId = order[nextIdx(game.turnIdx, game.dir, order)];
          for (let i=0;i<4;i++) drawOne(nextId);
          advanceTurn(1);
          announce(`🌪️ ${me.name} played WILD +4 → ${chosen.toUpperCase()}`);
        } else {
          advanceTurn(1);
          announce(`🌈 ${me.name} chose ${chosen.toUpperCase()}`);
        }
        maybeUnoPenalty(me.sid);
        const w = winnerIfAny();
        if (w) {
          const wn = players.find(p=>p.sid===w)?.name || "Player";
          announce(`🏆 ${wn} wins the round!`);
          scores[wn] = (scores[wn]||0)+1; saveScores();
          game = null; emitState(); return;
        }
        emitState();
      });
      return;
    }

    // colored actions
    game.color = card.color;
    game.value = card.type === "number" ? card.value : card.type;

    if (card.type === "number") {
      advanceTurn(1);
    } else if (card.type === "skip") {
      announce(`⛔ ${me.name} skipped next player.`);
      advanceTurn(2);
    } else if (card.type === "reverse") {
      game.dir *= -1;
      announce(`🔁 ${me.name} reversed direction.`);
      if (activeOrder().length === 2) advanceTurn(2); else advanceTurn(1);
    } else if (card.type === "draw2") {
      const order = activeOrder();
      const nextId = order[nextIdx(game.turnIdx, game.dir, order)];
      drawOne(nextId); drawOne(nextId);
      announce(`➕2 applied by ${me.name}.`);
      advanceTurn(2);
    }

    maybeUnoPenalty(me.sid);

    const w = winnerIfAny();
    if (w) {
      const wn = players.find(p=>p.sid===w)?.name || "Player";
      announce(`🏆 ${wn} wins the round!`);
      scores[wn] = (scores[wn]||0)+1; saveScores();
      game = null; emitState(); return;
    }
    emitState();
  });

  socket.on("disconnect", () => {
    const me = players.find(p=>p.id===socket.id);
    if (!me) return;
    // Grace period to allow reconnect
    me.id = "";
    setTimeout(() => {
      if (!me.id) {
        const idx = players.indexOf(me);
        if (idx>=0) {
          announce(`👋 ${me.name} left.`);
          players.splice(idx,1);
          if (game?.hands) delete game.hands[me.sid];
          endGameIfNeeded();
          emitState();
        }
      }
    }, 60000);
    emitState();
  });
});

server.listen(PORT, () => console.log("🚀 listening on", PORT));
