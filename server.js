const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- Data / State ----------
const COLORS = ["red", "blue", "green", "yellow"];
const NUM_COPIES = 2;
const START_HAND = 7;
const TURN_SECONDS = 25;

const lobbies = new Map(); // name -> { name, room, players[], game, log[], lastChatSid }
const scores = {}; // name -> { wins, points }

// ---------- Utils ----------
function id() { return crypto.randomBytes(8).toString("hex"); }
function sample(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function now(){ return Date.now(); }

function ensureLobby(name = "default"){
  if (!lobbies.has(name)) {
    lobbies.set(name, {
      name,
      room: `room:${name}`,
      players: [],
      log: [],
      lastChatSid: null,
      game: emptyGame()
    });
  }
  return lobbies.get(name);
}
function closeLobby(name){
  if (lobbies.has(name)) lobbies.delete(name);
}
function emptyGame(){
  return {
    started: false,
    deck: [],
    discard: [],
    color: null,
    value: null,
    top: null,
    hands: {},      // sid -> [cards]
    current: null,  // sid
    direction: 1,
    turnEndsAt: null,
    pendingPenalty: null, // { kind, amount, targetSid, lastFromSid }
    roundFlags: {}, // e.g., { happy: true }
    nocTarget: null
  };
}
function sidToPlayer(L, sid){ return L.players.find(p=>p.sid===sid) || null; }
function sidToName(L, sid){ const p = sidToPlayer(L, sid); return p ? p.name : sid; }
function seatedPlayers(L){ return L.players.filter(p=>!p.spectator); }
function activeOrder(L){ return seatedPlayers(L).map(p=>p.sid); }
function nextActiveSid(L, sid){
  const order = activeOrder(L); if (!order.length) return null;
  const i = order.indexOf(sid); if (i<0) return order[0];
  return order[(i + 1) % order.length];
}
function previousActiveSid(L, sid){
  const order = activeOrder(L); if (!order.length) return null;
  const i = order.indexOf(sid); if (i<0) return order[0];
  return order[(i - 1 + order.length) % order.length];
}

function announce(L, txt){
  L.log.push(`[${new Date().toLocaleTimeString()}] ${txt}`);
  if (L.log.length > 500) L.log.shift();
  io.in(L.room).emit("announce", txt);
}
function emitSoundToRoom(L, key){
  io.in(L.room).emit("sound", key);
}
function emitSoundPerPlayer(L, winnerSid){
  for (const p of L.players) {
    if (!p?.id) continue;
    if (p.spectator) continue;
    io.to(p.id).emit("sound", p.sid === winnerSid ? "win" : "lose");
  }
}

function restockDeckIfNeeded(G, needed=1){
  if (!Array.isArray(G.deck)) G.deck = [];
  if (G.deck.length >= needed) return;
  if (!Array.isArray(G.discard) || G.discard.length < 2) return;
  const top = G.discard.pop();
  const pool = G.discard;
  G.discard = [top];
  for (let i=pool.length-1; i>0; i--){
    const j = Math.floor(Math.random()*(i+1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  G.deck.push(...pool);
}
function drawCards(G, n){
  const out = [];
  restockDeckIfNeeded(G, n);
  for (let i=0; i<n; i++){
    const c = G.deck.pop();
    if (c) out.push(c);
  }
  return out;
}
function reshuffleCardsIntoDeck(G, cards){
  if (!cards || !cards.length) return;
  G.deck.push(...cards);
  for (let i=G.deck.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [G.deck[i], G.deck[j]] = [G.deck[j], G.deck[i]];
  }
}
function putUnderSpecial(G, extras){
  if (!extras || !extras.length) return;
  const top = G.discard.pop();
  G.discard.push(...extras);
  G.discard.push(top);
}

// Admin snapshot
function buildAdminState(L) {
  const G = L?.game || {};
  const players = (L?.players || []).map(p => {
    const hand = (G.hands && G.hands[p.sid]) ? G.hands[p.sid].length : 0;
    return {
      sid: p.sid,
      name: p.name,
      spectator: !!p.spectator,
      connected: !!p.id,
      hand
    };
  });
  const penalty = G.pendingPenalty ? {
    kind: G.pendingPenalty.kind,
    amount: Number(G.pendingPenalty.amount || 0),
    targetSid: G.pendingPenalty.targetSid || null,
    lastFromSid: G.pendingPenalty.lastFromSid || null
  } : null;
  const roundFlags = G.roundFlags ? Object.keys(G.roundFlags).filter(k => G.roundFlags[k]) : [];
  const top = G.top || (G.discard && G.discard[G.discard.length-1]) || null;
  const topCard = top ? {
    color: top.color || null,
    type: top.type || null,
    value: (typeof top.value === "number" ? top.value : null),
    img: top.img || null
  } : null;

  return {
    lobby: L.name,
    started: !!G.started,
    direction: G.direction === -1 ? "Counterclockwise" : "Clockwise",
    color: G.color || null,
    currentSid: G.current || null,
    currentName: (G.current && L.players.find(p => p.sid === G.current)?.name) || null,
    turnEndsAt: G.turnEndsAt || null,
    deckSize: Array.isArray(G.deck) ? G.deck.length : null,
    discardSize: Array.isArray(G.discard) ? G.discard.length : null,
    penalty,
    roundFlags,
    players,
    topCard
  };
}

// color choose at END of effect
function endChooseColorAndFinish({ io, L, G, me, specialType, afterColor }){
  const sock = io.sockets.sockets.get(me.id);
  io.to(me.id).emit("chooseColor");
  G.turnEndsAt = now() + TURN_SECONDS*1000; emitState(L);

  const finalize = (color) => {
    const chosen = COLORS.includes(color) ? color : sample(COLORS);
    G.color = chosen; G.value = specialType;
    announce(L, `🎨 Color → ${chosen.toUpperCase()}.`);
    if (afterColor) afterColor();
  };

  if (!sock) return finalize(sample(COLORS));
  sock.once("colorChosen", ({color})=> finalize(color));
}

// ---------- Cards ----------
function makeDeck(){
  const deck = [];

  for (const color of COLORS){
    deck.push({ color, type:"number", value:0, img:`${color}_0.png`});
    for (let v=1; v<=9; v++){
      for (let k=0;k<NUM_COPIES;k++) deck.push({ color, type:"number", value:v, img:`${color}_${v}.png`});
    }
    for
