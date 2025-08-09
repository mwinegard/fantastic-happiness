const express = require("express");
const fs = require("fs");
const httpServer = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const app = express();
const http = httpServer.createServer(app);
const io = new Server(http, { cors: { origin: "*" } });

app.use(express.static("public"));

/* ===== Scores ===== */
const SCORES_PATH = "./scores.json";
let scores = {};
try {
  if (fs.existsSync(SCORES_PATH)) {
    scores = JSON.parse(fs.readFileSync(SCORES_PATH, "utf8") || "{}");
  }
} catch { scores = {}; }
function saveScores() {
  try { fs.writeFileSync(SCORES_PATH, JSON.stringify(scores, null, 2)); }
  catch (e) { console.error("Failed writing scores:", e); }
}
app.get("/scores", (_req, res) => res.json(scores));

/* ===== Game State ===== */
let players = [];
let game = null;
let countdownTimer = null;
let turnInterval = null;
const MAX_PLAYERS = 10;
const TURN_SECONDS = 60;
const COUNTDOWN_SECONDS = 30;
const MISSES_TO_KICK = 3;

const ANIMALS = ["Aardvark","Badger","Cougar","Dolphin","Eagle","Fox","Giraffe","Hedgehog","Iguana","Jaguar","Koala","Lemur","Manatee","Narwhal","Otter","Panda","Quokka","Raccoon","Sloth","Turtle","Urchin","Vulture","Walrus","Yak","Zebra"];
const NUM_WORDS = ["One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten"];

function uniqueName(base) {
  let name = String(base || "").trim();
  if (!name) {
    const idx = Math.min(players.length, 9);
    name = `${NUM_WORDS[idx]} ${ANIMALS[Math.floor(Math.random()*ANIMALS.length)]}`;
  }
  const taken = new Set(players.map(p => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let n = 2;
  while (taken.has(`${name} ${n}`.toLowerCase())) n++;
  return `${name} ${n}`;
}

function announce(text) { io.emit("announce", text); }
function shuffle(arr) { for (let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];} return arr; }
function generateDeck() {
  const colors = ["red","yellow","green","blue"], deck = [];
  for (const c of colors) {
    deck.push({color:c,type:"number",value:0});
    for (let v=1; v<=9; v++){ deck.push({color:c,type:"number",value:v}); deck.push({color:c,type:"number",value:v}); }
    for (let i=0;i<2;i++){ deck.push({color:c,type:"skip"}); deck.push({color:c,type:"reverse"}); deck.push({color:c,type:"draw2"}); }
  }
  for (let i=0;i<4;i++){ deck.push({color:"wild",type:"wild"}); deck.push({color:"wild",type:"wild_draw4"}); }
  return shuffle(deck);
}
function cardMatchesTop(card,color,value){
  if (card.type==="wild"||card.type==="wild_draw4") return true;
  if (card.type==="number") return card.color===color || card.value===value;
  return card.color===color || card.type===value;
}
function dealCards(deck,n){ const out=[]; for (let i=0;i<n;i++) out.push(deck.pop()); return out; }

function emitState(){
  const state = {
    started: !!game?.started,
    countdownEndsAt: game?.countdownEndsAt || null,
    turnEndsAt: game?.turnEndsAt || null,
    current: game?.current || null,
    direction: game?.direction || 1,
    color: game?.color || null,
    top: game?.discardPile?.[game.discardPile.length-1] || null,
    players: players.map(p=>({id:p.id,name:p.name,spectator:p.spectator,handCount:game?.hands?.[p.id]?.length ?? 0}))
  };
  io.emit("state", state);
}

/* ===== Socket Handlers ===== */
io.on("connection", (socket) => {
  console.log("✅ New connection:", socket.id);

  socket.on("join", (rawName) => {
    console.log("📥 Join request from", socket.id, "with name:", rawName);

    const name = uniqueName(rawName);
    let player = players.find(p=>p.id===socket.id);
    if (!player) {
      const spectator = players.filter(p=>!p.spectator).length >= MAX_PLAYERS || !!(game?.started);
      player = { id: socket.id, name, spectator, misses: 0, joinedAt: Date.now() };
      players.push(player);
      console.log("➕ Added player:", name, spectator ? "(spectator)" : "(active)");
    } else {
      player.name = name;
      console.log("🔄 Updated name for", socket.id, "->", name);
    }

    // Always ACK join
    socket.emit("me", { id: socket.id, name: player.name, spectator: player.spectator });

    announce(`👤 ${player.name} ${player.spectator ? "joined as spectator." : "joined the game."}`);
    io.emit("playSound", "joined");

    if (!game?.started && players.filter(p=>!p.spectator).length >= 2) {
      startCountdown();
    }

    emitState();
  });

  // Simple getMyHand handler
  socket.on("getMyHand", () => {
    const hand = game?.hands?.[socket.id] || [];
    socket.emit("handSnapshot", hand);
    socket.emit("myHand", hand);
  });

  socket.on("disconnect", () => {
    console.log("❌ Disconnect:", socket.id);
    players = players.filter(p=>p.id!==socket.id);
    announce(`👋 A player left.`);
    emitState();
  });
});

/* ===== Countdown ===== */
function startCountdown(){
  if (countdownTimer || game?.started) return;
  const endsAt = Date.now() + COUNTDOWN_SECONDS*1000;
  game = { started:false, countdownEndsAt:endsAt };
  countdownTimer = setInterval(()=>{
    const enough = players.filter(p=>!p.spectator).length >= 2;
    if (!enough){ clearInterval(countdownTimer); countdownTimer=null; game=null; emitState(); return; }
    if (Date.now() >= endsAt){ clearInterval(countdownTimer); countdownTimer=null; initGame(); }
    emitState();
  },500);
}

function initGame(){
  const active = players.filter(p=>!p.spectator);
  const deck = generateDeck();
  const hands = {};
  for (const p of active) hands[p.id] = dealCards(deck,7);
  let first = deck.pop();
  while (first.type!=="number"){ deck.unshift(first); shuffle(deck); first = deck.pop(); }
  game = {
    started:true, deck, discardPile:[first],
    turnIndex:0, direction:1, color:first.color, value:first.value,
    hands, current:active[0].id,
    turnEndsAt: Date.now()+TURN_SECONDS*1000
  };
  emitState();
}

http.listen(PORT, () => {
  console.log("🚀 Server listening on", PORT);
});
