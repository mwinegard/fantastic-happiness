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

function drawExactOrEnd(L, n, reason){
  const G = L.game;
  const drawn = drawCards(G, n);
  if (drawn.length < n) {
    // House rule fallback: if we cannot draw the required cards (even after reshuffle), the game ends with no winner.
    G.started = false;
    G.turnEndsAt = null;
    G.pendingPenalty = null;
    announce(L, `🛑 Game over (no winner) — draw pile exhausted${reason ? `: ${reason}` : ""}.`);
    emitState(L);
    return null;
  }
  return drawn;
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

  // Ask the player for a color, but NEVER stall the game.
  io.to(me.id).emit("chooseColor");
  G.turnEndsAt = now() + TURN_SECONDS*1000;
  emitState(L);

  let done = false;
  const finalize = (color) => {
    if (done) return;
    done = true;
    const chosen = COLORS.includes(color) ? color : sample(COLORS);
    G.color = chosen;
    G.value = specialType;
    announce(L, `🎨 Color → ${chosen.toUpperCase()}.`);
    if (afterColor) afterColor();
  };

  // If the client doesn't respond (or closes the modal), pick a random color after 20s.
  const t = setTimeout(() => finalize(sample(COLORS)), 20000);

  if (!sock) return finalize(sample(COLORS));
  sock.once("colorChosen", ({ color }) => {
    clearTimeout(t);
    finalize(color);
  });
}

// ---------- Cards ----------
function makeDeck(){
  const deck = [];

  // --- Standard UNO base (with your image naming) ---
  for (const color of COLORS){
    deck.push({ color, type:"number", value:0, img:`${color}_0.png`});
    for (let v=1; v<=9; v++){
      for (let k=0; k<NUM_COPIES; k++){
        deck.push({ color, type:"number", value:v, img:`${color}_${v}.png`});
      }
    }
    for (let k=0; k<NUM_COPIES; k++){
      deck.push({ color, type:"skip", img:`${color}_skip.png`});
      deck.push({ color, type:"reverse", img:`${color}_reverse.png`});
      // assets are *_draw.png
      deck.push({ color, type:"draw2", img:`${color}_draw.png`});
    }
  }

  // --- Custom color specials (ONE each per deck) ---
  deck.push({ color:"yellow", type:"yellow_shopping", img:"yellow_shopping.png" });
  deck.push({ color:"yellow", type:"yellow_pinkypromise", img:"yellow_pinkypromise.png" });
  deck.push({ color:"green",  type:"green_recycle", img:"green_recycle.png" });
  deck.push({ color:"blue",   type:"blue_moon", img:"blue_moon.png" });
  deck.push({ color:"red",    type:"red_it", img:"red_it.png" });
  deck.push({ color:"red",    type:"red_noc", img:"red_noc.png" });

  // --- Other singletons ---
  deck.push({ color:"blue",  type:"blue_look", img:"blue_look.png" });
  deck.push({ color:"green", type:"green_happy", img:"green_happy.png" });

  // --- Wilds ---
  for (let i=0; i<4; i++){
    deck.push({ color:"wild", type:"wild", img:"wild.png" });
    deck.push({ color:"wild", type:"wild_draw4", img:"wild_draw4.png" });
  }

  // Specials that are ONE each per deck
  deck.push({ color:"wild", type:"wild_relax", img:"wild_relax.png" });
  deck.push({ color:"wild", type:"wild_rainbow", img:"wild_rainbow.png" });
  deck.push({ color:"wild", type:"wild_boss", img:"wild_boss.png" });
  deck.push({ color:"wild", type:"wild_packyourbags", img:"wild_packyourbags.png" });

  // Shuffle
  for (let i=deck.length-1; i>0; i--){
    const j = Math.floor(Math.random()*(i+1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ---------- Game flow ----------
function deal(L){
  const G = L.game;
  G.deck = makeDeck();
  G.discard = [];
  G.hands = {};

  for (const p of L.players){
    if (p.spectator) continue;
    const dealt = drawExactOrEnd(L, START_HAND, "initial deal");
    if (!dealt) return;
    G.hands[p.sid] = dealt;
  }

  const firstDraw = drawExactOrEnd(L, 1, "starting discard");
  if (!firstDraw) return;
  const first = firstDraw[0];

  G.discard.push(first); G.top = first;
  G.color = COLORS.includes(first.color) ? first.color : sample(COLORS);
  G.value = first.type==="number" ? first.value : first.type;
}

function winnerIfAny(L){
  const G = L.game;
  for (const sid of Object.keys(G.hands || {})){
    if ((G.hands[sid]||[]).length===0) return sid;
  }
  return null;
}

function settleAndQueueNext(L, winnerSid){
  const G = L.game;
  const winnerName = sidToName(L, winnerSid);
  announce(L, `🏆 Round Winner: ${winnerName}!`);
  emitSoundPerPlayer(L, winnerSid);

  let pts = 0;
  for (const sid of Object.keys(G.hands || {})){
    if (sid===winnerSid) continue;
    pts += (G.hands[sid]||[]).length;
  }
  scores[winnerName] = scores[winnerName] || { wins:0, points:0 };
  scores[winnerName].wins++; scores[winnerName].points += pts;

  G.started = false;
  G.nocTarget = null;
  io.in(L.room).emit("announce", `+${pts} points to ${winnerName}`);
  emitState(L);
}

function beginTurn(L, sid){
  const G = L.game;
  G.current = sid;
  G.turnEndsAt = now() + TURN_SECONDS*1000;
  emitState(L);
}

function advanceTurn(L, steps=1){
  const G = L.game;
  const order = activeOrder(L);
  if (order.length===0) return;
  let idx = order.indexOf(G.current);
  if (idx<0) idx = 0;
  idx = (idx + steps*G.direction + order.length) % order.length;
  beginTurn(L, order[idx]);
}

function beginPenalty(L, fromSid, kind){
  const G = L.game;
  const targetSid = nextActiveSid(L, fromSid);
  const add = (kind==="wild_draw4") ? 4 : 2;

  if (G.pendingPenalty) {
    // ✅ CONFIRMED: same-type stacking only
    if (G.pendingPenalty.kind !== kind) return false;
    G.pendingPenalty.amount += add;
    G.pendingPenalty.lastFromSid = fromSid;
    // penalty passes to the next seated player after the stacker
    G.pendingPenalty.targetSid = targetSid;
  } else {
    G.pendingPenalty = { kind, amount: add, targetSid, lastFromSid: fromSid };
  }

  beginTurn(L, targetSid);
  return true;
}

// ---------- Express ----------
app.get("/leaderboard", (req,res)=>{
  const rows = Object.keys(scores).map(name => ({ name, wins: scores[name].wins||0, points: scores[name].points||0 }))
    .sort((a,b)=> (b.wins-a.wins) || (b.points-a.points) || a.name.localeCompare(b.name));
  res.json(rows);
});
app.get("/lobbies", (req,res)=>{
  const data = Array.from(lobbies.values()).map(L=>({
    name: L.name,
    players: L.players.filter(p=>!p.spectator).length,
    spectators: L.players.filter(p=>p.spectator).length,
    started: !!L.game.started
  }));
  res.json(data);
});

// ---------- Socket.io ----------
io.on("connection", (socket)=>{

  socket.on("join", ({ name, lobby, spectator })=>{
    const playerName = (String(name||"Player").trim() || "Player").slice(0,24);
    const lobbyName = (String(lobby||"default").trim() || "default").slice(0,24);
    const wantsSpectator = !!spectator;

    const L = ensureLobby(lobbyName);

    for (const r of socket.rooms) if (r!==socket.id) socket.leave(r);
    socket.join(L.room);

    let p = L.players.find(x=>x.id===socket.id);
    if (!p){
      p = { id: socket.id, sid: id(), name: playerName, spectator: wantsSpectator };
      L.players.push(p);
    } else {
      p.name = playerName;
      p.spectator = wantsSpectator;
    }

    const G = L.game;
    G.hands = G.hands || {};

    // spectators never get a hand/seat
    if (p.spectator) {
      if (G.hands[p.sid] && G.hands[p.sid].length) reshuffleCardsIntoDeck(G, G.hands[p.sid]);
      delete G.hands[p.sid];
    } else {
      if (G.started && !Array.isArray(G.hands[p.sid])) {
        const dealt = drawExactOrEnd(L, START_HAND, "late join deal");
        if (!dealt) return;
        G.hands[p.sid] = dealt;
        announce(L, `🪑 ${p.name} took a seat and was dealt ${G.hands[p.sid].length} card(s).`);
      }
    }

    socket.emit("me", { id: socket.id, sid: p.sid, name: p.name, lobby: lobbyName, spectator: p.spectator });

    announce(L, `👋 ${p.name} joined ${lobbyName}${p.spectator ? " (spectator)" : ""}.`);
    emitSoundToRoom(L, "joined");

    if (!L.game.started && seatedPlayers(L).length>=2){
      L.game = emptyGame();
      L.game.started = true;
      deal(L);
      if (L.game.started) {
        emitSoundToRoom(L, "start");
        beginTurn(L, activeOrder(L)[0]);
      } else {
        emitState(L);
      }
    } else {
      if (L.game.started) {
        const order = activeOrder(L);
        if (!order.length) L.game.started = false;
        else if (!order.includes(L.game.current)) beginTurn(L, order[0]);
      }
      emitState(L);
    }
  });

  socket.on("drawCard", ()=>{
    const L = findLobbyBySocket(socket); if (!L) return;
    const G = L.game; if (!G.started) return;
    const me = L.players.find(p=>p.id===socket.id); if (!me || me.spectator) return;
    if (me.sid!==G.current) return;

    // penalty draw resolves the entire stack + ends turn
    if (G.pendingPenalty && G.pendingPenalty.targetSid===me.sid){
      restockDeckIfNeeded(G, G.pendingPenalty.amount);
      const drawn = drawExactOrEnd(L, G.pendingPenalty.amount, "while resolving a draw stack");
      if (!drawn) return;
      (G.hands[me.sid] = G.hands[me.sid] || []).push(...drawn);

      announce(L, `😵 ${me.name} drew ${drawn.length}/${G.pendingPenalty.amount} (stack resolved).`);
      emitSoundToRoom(L, "draw");

      G.pendingPenalty = null;
      advanceTurn(L,1);
      return emitState(L);
    }

    const drawn1 = drawExactOrEnd(L, 1, "while drawing");
    if (!drawn1) return;
    const card = drawn1[0];
    (G.hands[me.sid] = G.hands[me.sid] || []).push(card);

    announce(L, `🃏 ${me.name} drew 1 card.`);
    emitSoundToRoom(L, "draw");

    advanceTurn(L,1);
    emitState(L);
  });

  socket.on("callUno", ()=>{
    const L = findLobbyBySocket(socket); if (!L) return;
    const me = L.players.find(p=>p.id===socket.id); if (!me || me.spectator) return;
    const hand = (L.game.hands[me.sid]||[]);
    if (hand.length===2){
      announce(L, `📣 ${me.name} called UNO!`);
      emitSoundToRoom(L, "uno");
    } else {
      io.to(me.id).emit("warn", "You can only call UNO at 2 cards.");
    }
  });

  // RELAX button (out-of-turn cancel, OR on-turn as a normal wild)
  socket.on("playRelaxRequested", ()=>{
    const L = findLobbyBySocket(socket); if (!L?.game?.started) return;
    const G = L.game;

    const me = L.players.find(p=>p.id===socket.id); if (!me || me.spectator) return;
    const hand = G.hands[me.sid] || [];
    const idx = hand.findIndex(c => c.type==="wild_relax");
    if (idx<0) { io.to(me.id).emit("warn","🧘 You don't have a RELAX card."); return; }

    const penaltyActive = !!G.pendingPenalty;
    const myTurn = (G.current===me.sid);

    // out of turn only allowed if penaltyActive
    if (!myTurn && !penaltyActive) {
      io.to(me.id).emit("warn","🧘 RELAX can only be played out-of-turn during a draw stack.");
      return;
    }

    // play it
    const card = hand.splice(idx,1)[0];
    G.discard.push(card); G.top = card;
    emitSoundToRoom(L, "special");

    if (penaltyActive) {
      const targetSid = G.pendingPenalty?.targetSid || G.current;
      G.pendingPenalty = null;
      if (targetSid) G.current = targetSid;
      announce(L, `🧘 RELAX! ${me.name} canceled the draw stack.`);
      return endChooseColorAndFinish({
        io, L, G, me, specialType: "wild_relax",
        afterColor: ()=>{ G.turnEndsAt = now()+TURN_SECONDS*1000; emitState(L); }
      });
    }

    // on-turn wild behavior (no penalty)
    announce(L, `🧘 RELAX! ${me.name} played RELAX as a Wild.`);
    return endChooseColorAndFinish({
      io, L, G, me, specialType: "wild_relax",
      afterColor: ()=>{ advanceTurn(L,1); emitState(L); }
    });
  });

  // Admin: pull state, chat, sound
  socket.on("admin:pullState", ()=>{
    const L = findLobbyBySocket(socket); if (!L) return;
    socket.emit("admin:state", buildAdminState(L));
  });
  socket.on("admin:chat", ({text})=>{
    const L = findLobbyBySocket(socket); if (!L) return;
    const msg = String(text||"").trim(); if (!msg) return;
    io.in(L.room).emit("announce", `🛠️ [ADMIN] ${msg}`);
  });
  socket.on("admin:sound", ({name})=>{
    const L = findLobbyBySocket(socket); if (!L) return;
    const sound = String(name||"").trim(); if (!sound) return;
    io.in(L.room).emit("sound", sound);
    announce(L, `🔊 Admin triggered sound: ${sound}`);
  });

  // Chat (Happy Mode rude penalty)
  socket.on("chat", ({text})=>{
    const L = findLobbyBySocket(socket); if (!L) return;
    const G = L.game;
    const me = L.players.find(p=>p.id===socket.id); if (!me) return;

    const msg = String(text||"").slice(0,400);
    io.in(L.room).emit("chat", { fromName: me.name, text: msg });

    const lower = msg.toLowerCase();

    // Happy Mode: if message contains "rude", previous chatter draws 1
    if (G?.started && G?.roundFlags?.happy && lower.includes("rude")) {
      const prevSid = L.lastChatSid;
      const prevPlayer = prevSid ? sidToPlayer(L, prevSid) : null;

      if (prevPlayer && !prevPlayer.spectator && (G.hands[prevSid] || null)) {
        const d = drawExactOrEnd(L, 1, "Happy Mode draw");
        if (!d) return;
        const c = d[0];
        if (c) {
          (G.hands[prevSid] = G.hands[prevSid] || []).push(c);
          announce(L, `😊 Happy Mode: "${me.name}" said RUDE — ${prevPlayer.name} draws 1.`);
          emitSoundToRoom(L, "draw");
          emitState(L);
        } else {
          announce(L, `😊 Happy Mode triggered, but the deck is empty.`);
        }
      }
    }

    // update lastChatSid AFTER processing
    L.lastChatSid = me.sid;
  });

  // Play a card
  socket.on("playCard", ({ index })=>{
    const L = findLobbyBySocket(socket); if (!L) return;
    const G = L.game; if (!G.started) return;
    const me = L.players.find(p=>p.id===socket.id);
    if (!me || me.spectator) return;
    if (me.sid!==G.current) return;

    const hand = G.hands[me.sid] || [];
    const i = Number(index);
    if (!Number.isInteger(i) || i<0 || i>=hand.length) return;

    const card = hand.splice(i,1)[0];
    G.discard.push(card); G.top = card;

    // Draw-stack enforcement (✅ CONFIRMED): target may ONLY stack the SAME penalty type, play RELAX, or draw the stack.
    if (G.pendingPenalty && G.pendingPenalty.targetSid === me.sid) {
      const kind = G.pendingPenalty.kind;
      const allowed = new Set([kind, "wild_relax"]);
      if (!allowed.has(card.type)) {
        G.discard.pop();
        G.top = G.discard[G.discard.length - 1] || null;
        hand.splice(i, 0, card);
        io.to(me.id).emit("warn", "⚠️ Draw stack active: you must stack the SAME draw card, play RELAX, or draw the stack.");
        emitState(L);
        return;
      }
    }

    function legalPlay(card){
      if (String(card.color)==="wild") return true;
      if (card.type==="number"){
        return (card.color===G.color) || (card.value===G.value);
      }
      return (card.color===G.color) || (card.type===G.value);
    }

    // legality check (skip for wild + custom specials)
    if (String(card.color) !== "wild" &&
        !["yellow_shopping","yellow_pinkypromise","green_recycle","blue_moon","red_it","red_noc","blue_look","green_happy"].includes(card.type)) {
      if (!legalPlay(card)){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null;
        hand.splice(i,0,card);
        io.to(me.id).emit("warn","Illegal play.");
        emitState(L);
        return;
      }
    }

    // Standard actions
    if (card.type==="reverse"){
      G.direction *= -1;
      announce(L, `🔁 Order reversed.`);
      emitSoundToRoom(L, "reverse");
      G.color = card.color; G.value = "reverse";
      advanceTurn(L,1); return emitState(L);
    }

    if (card.type==="skip"){
      announce(L, `⏭️ Skip!`);
      emitSoundToRoom(L, "skip");
      G.color = card.color; G.value = "skip";
      advanceTurn(L,2); return emitState(L);
    }

    if (card.type==="draw2"){
      G.color = card.color; G.value = "draw2";
      emitSoundToRoom(L, "wild");
      const ok = beginPenalty(L, me.sid, "draw2");
      if (!ok) {
        // should not happen because we enforce same-type stacks, but keep it safe
        G.discard.pop();
        G.top = G.discard[G.discard.length - 1] || null;
        hand.splice(i, 0, card);
        io.to(me.id).emit("warn", "⚠️ Draw stack active: Draw 2 can only stack on Draw 2.");
        emitState(L);
        return;
      }
      return emitState(L);
    }

    // RELAX card from hand
    if (card.type==="wild_relax") {
      emitSoundToRoom(L, "special");

      if (G.pendingPenalty) {
        const targetSid = G.pendingPenalty?.targetSid || G.current;
        G.pendingPenalty = null;
        if (targetSid) G.current = targetSid;
        announce(L, `🧘 RELAX! ${me.name} canceled the draw stack.`);
        return endChooseColorAndFinish({
          io, L, G, me, specialType: "wild_relax",
          afterColor: () => { G.turnEndsAt = now() + TURN_SECONDS * 1000; emitState(L); }
        });
      }

      announce(L, `🧘 RELAX! ${me.name} played RELAX as a Wild.`);
      return endChooseColorAndFinish({
        io, L, G, me, specialType: "wild_relax",
        afterColor: () => { advanceTurn(L, 1); emitState(L); }
      });
    }

    // Blue Look — must be played when active color is BLUE
    if (card.type==="blue_look"){
      if (G.color!=="blue"){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        io.to(me.id).emit("warn","👀 Blue Look may only be played when the active color is BLUE.");
        emitState(L); return;
      }
      emitSoundToRoom(L, "special");

      const viewCount = Math.min(4, G.deck.length);
      restockDeckIfNeeded(G, viewCount);
      const peek = G.deck.slice(-viewCount);
      const safePeek = peek.map((c,idx)=>({ i: idx, color:c.color, type:c.type, value:c.value??null }));

      io.to(me.id).emit("lookTop", { cards: safePeek });
      const sock = io.sockets.sockets.get(me.id);
      const original = safePeek.map(x=>x.i);

      const applyOrder = (order)=>{
        const clean = Array.from(new Set((order||[]).map(Number))).filter(n=>Number.isInteger(n) && n>=0 && n<safePeek.length);
        if (clean.length!==safePeek.length){
          announce(L, `👀 Blue Look timed out/invalid; deck unchanged.`);
        } else {
          const newTop = clean.map(i=>peek[i]);
          for (let k=0;k<viewCount;k++) G.deck[G.deck.length-viewCount+k] = newTop[k];
          announce(L, `👀 ${me.name} reordered the top of the deck.`);
        }
        G.color = card.color; G.value = "blue_look";
        advanceTurn(L,1); emitState(L);
      };

      if (!sock) return applyOrder(original);

      // Never stall the game if the player closes/ignores the modal.
      const tLook = setTimeout(() => applyOrder(original), 20000);
      sock.once("lookTopOrder", ({order})=>{
        clearTimeout(tLook);
        applyOrder(order);
      });
      return;
    }

    // Green Happy — enables happy mode
    if (card.type==="green_happy"){
      emitSoundToRoom(L, "special");
      G.roundFlags = G.roundFlags || {};
      G.roundFlags.happy = true;
      announce(L, `😊 Happy Mode enabled. (Chat rule: if someone says "rude", previous chatter draws 1.)`);
      G.color = card.color; G.value = "green_happy";
      advanceTurn(L,1); return emitState(L);
    }

    // Yellow Shopping
    if (card.type==="yellow_shopping"){
      if (G.color!=="yellow"){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        io.to(me.id).emit("warn","🛒 Shopping may only be played when the active color is YELLOW."); emitState(L); return;
      }
      emitSoundToRoom(L, "special");

      const others = seatedPlayers(L).map(p=>p.sid).filter(sid=>sid!==me.sid);
      const eligible = others.filter(sid => (G.hands[sid]||[]).length>0);
      if ((G.hands[me.sid]||[]).length<2 || eligible.length===0){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        announce(L, `🛒 Shopping canceled — you need ≥2 cards and a target with ≥1.`); emitState(L); return;
      }

      announce(L, `🛒 ${me.name} is shopping…`);
      let canceled=false;

      const revert= (msg)=>{
        if (canceled) return; canceled=true;
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        if (msg) io.to(me.id).emit("warn", msg); emitState(L);
      };

      const sock = io.sockets.sockets.get(me.id);
      io.to(me.id).emit("shoppingChooseTarget",{ targets: eligible.map(sid=>({sid, name:sidToName(L,sid)})) });

      if (!sock) return revert("🛒 Shopping timed out.");
      const t = setTimeout(()=> revert("🛒 Shopping timed out."), 20000);

      sock.once("shoppingTargetChosen", ({sid:targetSid})=>{
        if (canceled) return;
        if (!eligible.includes(targetSid)) { clearTimeout(t); return revert("🛒 Invalid target."); }

        const mySnap = (G.hands[me.sid]||[]).map((c,i)=>({i,color:c.color,type:c.type,value:c.value??null}));
        const tgSnap = (G.hands[targetSid]||[]).map((c,i)=>({i,color:c.color,type:c.type,value:c.value??null}));

        if (mySnap.length<2 || tgSnap.length<1){ clearTimeout(t); return revert("🛒 Not enough cards to trade."); }
        io.to(me.id).emit("shoppingPickGive",{ hand: mySnap });

        sock.once("shoppingGiveChosen", ({idx1,idx2})=>{
          if (canceled) return;
          const a=Number(idx1), b=Number(idx2);
          if (!Number.isInteger(a)||!Number.isInteger(b)||a===b){ clearTimeout(t); return revert("🛒 Pick two different cards."); }

          io.to(me.id).emit("shoppingPickTake",{ hand: tgSnap });

          sock.once("shoppingTakeChosen", ({idx})=>{
            clearTimeout(t);

            const myHand = G.hands[me.sid]||[], tgHand = G.hands[targetSid]||[];
            if (myHand.length<2 || idx<0 || idx>=tgHand.length) return revert("🛒 Selection invalid.");

            const sorted=[a,b].sort((x,y)=>y-x);
            const giving=[];
            for (const ix of sorted){
              if (ix<0 || ix>=myHand.length) return revert("🛒 Your selection no longer valid.");
              giving.push(myHand.splice(ix,1)[0]);
            }
            const taking = tgHand.splice(idx,1)[0];

            tgHand.push(...giving); myHand.push(taking);

            announce(L, `🛒 ${me.name} swapped 2→1 with ${sidToName(L,targetSid)}.`);
            G.color = card.color; G.value = "yellow_shopping";

            const w = winnerIfAny(L); if (w){ return settleAndQueueNext(L,w); }
            advanceTurn(L,1); emitState(L);
          });
        });
      });

      return;
    }

    // Pinky Promise — always allowed when yellow
    if (card.type==="yellow_pinkypromise"){
      if (G.color!=="yellow"){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        io.to(me.id).emit("warn","🤝 Pinky Promise may only be played when the active color is YELLOW."); emitState(L); return;
      }
      emitSoundToRoom(L, "special");

      const others = seatedPlayers(L).map(p=>p.sid).filter(sid=>sid!==me.sid);
      if (!others.length){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        announce(L, `🤝 Pinky Promise canceled — no other players available.`); emitState(L); return;
      }

      announce(L, `🤝 ${me.name} is making a Pinky Promise…`);
      const sock = io.sockets.sockets.get(me.id);
      const targets = others.map(sid=>({sid, name:sidToName(L,sid)}));

      const resolvePP = (targetSid)=>{
        const a = G.hands[me.sid] = (G.hands[me.sid]||[]);
        const b = G.hands[targetSid] = (G.hands[targetSid]||[]);
        const pool = a.splice(0,a.length).concat(b.splice(0,b.length));
        for (let i=pool.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [pool[i],pool[j]]=[pool[j],pool[i]]; }
        const base = Math.floor(pool.length/2), extra = pool.length%2;
        const giveExtraToA = extra ? (Math.random()<0.5) : false;
        const aCount = base + (giveExtraToA?1:0);
        const bCount = base + (giveExtraToA?0:1);
        G.hands[me.sid] = pool.splice(0, aCount);
        G.hands[targetSid] = pool.splice(0, bCount);
        announce(L, `🤝 Pinky Promise! ${me.name} & ${sidToName(L,targetSid)} reshuffled and split (${aCount} & ${bCount}${extra?"; one extra assigned randomly":""}).`);
        G.color = card.color; G.value = "yellow_pinkypromise";
        const w = winnerIfAny(L); if (w){ return settleAndQueueNext(L,w); }
        advanceTurn(L,1); emitState(L);
      };

      if (targets.length===1) return resolvePP(targets[0].sid);

      io.to(me.id).emit("promiseChooseTarget",{targets});
      if (!sock) return resolvePP(sample(targets).sid);

      // Never stall the game if the player closes/ignores the modal.
      const tPP = setTimeout(() => resolvePP(sample(targets).sid), 20000);
      sock.once("promiseTargetChosen", ({sid})=>{
        clearTimeout(tPP);
        if (!others.includes(sid)) return resolvePP(sample(targets).sid);
        resolvePP(sid);
      });
      return;
    }

    // Blue Moon random
    if (card.type==="blue_moon"){
      if (G.color!=="blue"){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        io.to(me.id).emit("warn","🌙 To The Moon may only be played when the active color is BLUE."); emitState(L); return;
      }
      emitSoundToRoom(L, "special");

      const targets = seatedPlayers(L).filter(p=>p.sid!==me.sid);
      if (!targets.length){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        announce(L, `🌙 To The Moon canceled — no other players.`); emitState(L); return;
      }
      const recipient = sample(targets);
      const drew = drawExactOrEnd(L, 1, "To The Moon draw");
      if (!drew) return;
      (G.hands[recipient.sid] = G.hands[recipient.sid]||[]).push(...drew);
      announce(L, `🚀 To The Moon! A rocket lands near ${recipient.name}, delivering ${drew.length} extra card.`);
      G.color = card.color; G.value = "blue_moon";
      const w = winnerIfAny(L); if (w){ return settleAndQueueNext(L,w); }
      advanceTurn(L,1); return emitState(L);
    }

    // Recycle — must be green; everyone gets at least 1 (force deck draws)
    if (card.type==="green_recycle"){
      if (G.color!=="green"){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        io.to(me.id).emit("warn","♻️ Recycle may only be played when the active color is GREEN."); emitState(L); return;
      }
      emitSoundToRoom(L, "special");

      const acts = seatedPlayers(L);
      if (acts.length < 2){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        announce(L, `♻️ Recycle canceled — not enough players.`); emitState(L); return;
      }

      const pool=[];
      for (const p of acts){
        const h = G.hands[p.sid] || [];
        while(h.length) pool.push(h.pop());
      }

      if (pool.length < acts.length) {
        const need = acts.length - pool.length;
        const got = drawExactOrEnd(L, need, "Recycle refill");
        if (!got) return;
        pool.push(...got);
      }

      for (let i=pool.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [pool[i],pool[j]]=[pool[j],pool[i]]; }

      const newHands = {};
      for (const p of acts) newHands[p.sid] = [];

      for (const p of acts) {
        let c = pool.shift();
        if (!c) {
          const got = drawExactOrEnd(L, 1, "Recycle minimum enforcement");
          if (!got) return;
          c = got[0];
        }
        newHands[p.sid].push(c);
      }

      let idx=0;
      while (pool.length) {
        const p = acts[idx % acts.length];
        newHands[p.sid].push(pool.shift());
        idx++;
      }

      for (const p of acts) G.hands[p.sid] = newHands[p.sid];

      const zeros = acts.filter(p => (G.hands[p.sid]||[]).length === 0);
      if (zeros.length) {
        announce(L, `♻️ Recycle warning: could not guarantee 1 card for: ${zeros.map(z=>z.name).join(", ")} (deck empty).`);
      } else {
        announce(L, `♻️ Recycle! Everyone received at least 1 card.`);
      }

      G.color = card.color; G.value = "green_recycle";
      const w = winnerIfAny(L); if (w){ return settleAndQueueNext(L,w); }
      advanceTurn(L,1); return emitState(L);
    }

    // Red NOC (✅ includes self on first target)
    if (card.type==="red_noc"){
      if (G.color!=="red"){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        io.to(me.id).emit("warn","📄 NOC Notice may only be played when the active color is RED."); emitState(L); return;
      }
      emitSoundToRoom(L, "special");

      if (!G.nocTarget){
        const acts = seatedPlayers(L); // ✅ includes self (no filtering)
        const chosen = sample(acts);
        G.nocTarget = chosen.sid;
        const drawnNoc1 = drawExactOrEnd(L, 3, "NOC Notice draw");
        if (!drawnNoc1) return;
        (G.hands[chosen.sid] = G.hands[chosen.sid]||[]).push(...drawnNoc1);
        announce(L, `📄 NOC Notice issued! ${chosen.name} draws 3.`);
      } else {
        const target = sidToPlayer(L, G.nocTarget);
        if (target) {
          const drawnNoc2 = drawExactOrEnd(L, 3, "NOC reminder draw");
          if (!drawnNoc2) return;
          (G.hands[target.sid]=G.hands[target.sid]||[]).push(...drawnNoc2);
          announce(L, `📄 NOC reminder: ${target.name} draws 3 more.`);
        } else {
          announce(L, `📄 NOC reminder: previous target left.`);
        }
      }

      G.color = card.color; G.value = "red_noc";
      const w = winnerIfAny(L); if (w){ return settleAndQueueNext(L,w); }
      advanceTurn(L,1); return emitState(L);
    }

    // Red IT (✅ if 2 players, acts like Draw 2)
    if (card.type==="red_it"){
      if (G.color!=="red"){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        io.to(me.id).emit("warn","🧢 IT may only be played when the active color is RED."); emitState(L); return;
      }
      emitSoundToRoom(L, "special");

      const order = activeOrder(L);
      if (order.length === 2) {
        // ✅ Treat as Draw 2 against the other player
        announce(L, `🧢 IT! “We all float down here…” With only two players, IT becomes a Draw 2.`);
        G.color = card.color; G.value = "red_it";
        beginPenalty(L, me.sid, "draw2");
        return emitState(L);
      }

      const prevSid = previousActiveSid(L, me.sid);
      const nextSid = nextActiveSid(L, me.sid);
      const prevHand = G.hands[prevSid] = (G.hands[prevSid]||[]);
      const nextHand = G.hands[nextSid] = (G.hands[nextSid]||[]);
      if (!prevHand.length){
        announce(L, `🧢 IT tried to float a card from ${sidToName(L, prevSid)}, but there was nothing to float.`);
        G.color = card.color; G.value = "red_it";
        advanceTurn(L,1); return emitState(L);
      }

      const idx2 = (Math.random()*prevHand.length)|0;
      const floated = prevHand.splice(idx2,1)[0];
      nextHand.push(floated);
      announce(L, `🧢 IT! ${sidToName(L, prevSid)} floats 1 random card to ${sidToName(L, nextSid)}.`);
      G.color = card.color; G.value = "red_it";
      const w = winnerIfAny(L); if (w){ return settleAndQueueNext(L,w); }
      advanceTurn(L,1); return emitState(L);
    }

    // Wild Boss (Lori override)
    if (card.type==="wild_boss"){
      emitSoundToRoom(L, "special");

      const acts = seatedPlayers(L);
      if (acts.length>1){
        const lori = acts.find(p => String(p.name||"").trim().toLowerCase() === "lori");
        let recipientSid;

        if (lori) {
          recipientSid = lori.sid;
        } else {
          const ranked = acts.map(p=>{
            const s = scores[p.name] || { wins:0, points:0 };
            return { sid:p.sid, name:p.name, points:+(s.points||0), wins:+(s.wins||0) };
          }).sort((a,b)=> (b.points-a.points) || (b.wins-a.wins) || a.name.localeCompare(b.name));

          const top = ranked[0];
          const ties = ranked.filter(r=> r.points===top.points && r.wins===top.wins);
          recipientSid = ties.length>1 ? sample(ties).sid : top.sid;
        }

        const recipientName = sidToName(L, recipientSid);
        announce(L, `👑 THE BOSS: ${recipientName} receives a gift from each player!`);

        const recHand = G.hands[recipientSid] = (G.hands[recipientSid]||[]);
        for (const p of acts){
          if (p.sid===recipientSid) continue;
          const h = G.hands[p.sid] || [];
          if (!h.length){ announce(L, `🎁 ${p.name} has no card to gift.`); continue; }
          const ix = (Math.random()*h.length)|0;
          recHand.push(h.splice(ix,1)[0]);
        }
      }

      const w = winnerIfAny(L); if (w){ return settleAndQueueNext(L,w); }
      return endChooseColorAndFinish({
        io, L, G, me, specialType:"wild_boss",
        afterColor: ()=>{ advanceTurn(L,1); emitState(L); }
      });
    }

    // Wild Pack Your Bags — cannot be played during stack penalty; hands stay with seats
    if (card.type==="wild_packyourbags"){
      if (G.pendingPenalty) {
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        io.to(me.id).emit("warn","🧳 Pack Your Bags can't be played during a draw stack. The stack must be resolved first.");
        emitState(L); return;
      }

      emitSoundToRoom(L, "special");
      announce(L, `🧳 Pack Your Bags! Seats are being swapped — you take your new seat’s hand.`);

      const order = activeOrder(L);
      if (order.length>1){
        const seatHands = order.map(sid=> (G.hands[sid]||[]));
        const curSeatIdx = order.indexOf(G.current);

        const newOrder = order.slice();
        for (let j=newOrder.length-1;j>0;j--){ const k=(Math.random()*(j+1))|0; [newOrder[j],newOrder[k]]=[newOrder[k],newOrder[j]]; }

        for (let j=0;j<newOrder.length;j++) G.hands[newOrder[j]] = seatHands[j];
        if (curSeatIdx>=0) G.current = newOrder[curSeatIdx];

        const pairs=[];
        for (let j=0;j<order.length;j++){
          const a=sidToName(L, order[j]), b=sidToName(L, newOrder[j]);
          if (a!==b) pairs.push(`${a} → ${b}`);
        }
        if (pairs.length) announce(L, `🪑 Seats swapped: ${pairs.join(", ")}.`);
      }

      return endChooseColorAndFinish({
        io, L, G, me, specialType:"wild_packyourbags",
        afterColor: ()=>{ advanceTurn(L,1); emitState(L); }
      });
    }

    // Wild Rainbow — requires 1 of each color
    if (card.type==="wild_rainbow"){
      emitSoundToRoom(L, "special");

      const my = G.hands[me.sid]||[];
      const has = (col) => my.some(c => c && c.color === col);
      if (!(has("red") && has("yellow") && has("green") && has("blue"))) {
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        io.to(me.id).emit("warn","🌈 Rainbow requires you to have at least one Red, Yellow, Green, and Blue card.");
        emitState(L); return;
      }

      const sock = io.sockets.sockets.get(me.id);
      io.to(me.id).emit("rainbowPick", { hand: my.map((c,i)=>({i,color:c.color,type:c.type,value:c.value??null})) });

      const t = setTimeout(()=> autoPick(), 20000);

      function autoPick(){
        const picks=[];
        const used=new Set();
        for (let j=0;j<my.length && used.size<4;j++){
          if (COLORS.includes(my[j].color) && !used.has(my[j].color)){
            used.add(my[j].color); picks.push(j);
          }
        }
        applyPick(picks);
      }

      function applyPick(indices){
        clearTimeout(t);

        const sorted = Array.from(new Set(indices)).sort((a,b)=>b-a);
        const chosen=[]; const used=new Set();

        for (const ix of sorted){
          if (ix<0 || ix>=my.length) continue;
          const c = my[ix];
          if (!COLORS.includes(c.color) || used.has(c.color)) continue;
          used.add(c.color); chosen.push(my.splice(ix,1)[0]);
        }

        for (const col of ["red","yellow","green","blue"]) {
          if (!chosen.find(x=>x.color===col)) {
            const j = my.findIndex(x=>x.color===col);
            if (j>=0) chosen.push(my.splice(j,1)[0]);
          }
        }

        if (chosen.length !== 4) {
          announce(L, `🌈 Rainbow failed to select 4 colors; no changes made.`);
        } else {
          putUnderSpecial(G, chosen);
          announce(L, `🌈 Rainbow! ${me.name} discarded one of each color.`);
        }

        endChooseColorAndFinish({
          io, L, G, me, specialType:"wild_rainbow",
          afterColor: ()=>{ advanceTurn(L,1); emitState(L); }
        });
      }

      if (!sock) return autoPick();
      sock.once("rainbowChosen", ({indices})=> applyPick(Array.isArray(indices)?indices:[]));
      return;
    }

    // Wild
    if (card.type==="wild"){
      emitSoundToRoom(L, "wild");
      return endChooseColorAndFinish({
        io, L, G, me, specialType:"wild",
        afterColor: ()=>{ advanceTurn(L,1); emitState(L); }
      });
    }

    // Wild Draw4 (stackable)
    if (card.type==="wild_draw4"){
      emitSoundToRoom(L, "wild");
      const ok = beginPenalty(L, me.sid, "wild_draw4");
      if (!ok) {
        // should not happen because we enforce same-type stacks, but keep it safe
        G.discard.pop();
        G.top = G.discard[G.discard.length - 1] || null;
        hand.splice(i, 0, card);
        io.to(me.id).emit("warn", "⚠️ Draw stack active: Wild Draw 4 can only stack on Wild Draw 4.");
        emitState(L);
        return;
      }
      return endChooseColorAndFinish({
        io, L, G, me, specialType:"wild_draw4",
        afterColor: ()=> emitState(L)
      });
    }

    // Number
    if (card.type==="number"){
      emitSoundToRoom(L, "number");
      G.color = card.color; G.value = card.value; G.top = card;
      const w = winnerIfAny(L); if (w){ return settleAndQueueNext(L,w); }
      advanceTurn(L,1); return emitState(L);
    }

    // Fallback
    G.color = card.color; G.value = card.type; G.top = card;
    const w = winnerIfAny(L); if (w){ return settleAndQueueNext(L,w); }
    advanceTurn(L,1); emitState(L);
  });

  socket.on("disconnect", () => {
    let foundLobby = null, foundIdx = -1;
    for (const L of lobbies.values()) {
      const i = L.players.findIndex(p => p.id === socket.id);
      if (i !== -1) { foundLobby = L; foundIdx = i; break; }
    }
    if (!foundLobby) return;

    const L = foundLobby;
    const G = L.game;
    const leaving = L.players.splice(foundIdx, 1)[0];

    if (leaving && G && G.hands && G.hands[leaving.sid]) {
      reshuffleCardsIntoDeck(G, G.hands[leaving.sid]);
      delete G.hands[leaving.sid];
      announce(L, `👋 ${leaving.name} left — their hand returned to the deck.`);
    } else {
      announce(L, `👋 ${leaving?.name || "A player"} left.`);
    }

    if (G && G.started && seatedPlayers(L).length < 2) {
      announce(L, "ℹ️ Not enough seated players to continue — game reset.");
      L.game = emptyGame();
      emitState(L);
    } else if (G && G.started && G.current === (leaving && leaving.sid)) {
      const order = activeOrder(L);
      if (order.length) beginTurn(L, order[0]);
      else { G.started = false; emitState(L); }
    } else {
      emitState(L);
    }

    if (L.players.length === 0) { closeLobby(L.name); return; }
    if (seatedPlayers(L).length === 0) {
      announce(L, "ℹ️ No seated players remain — lobby game reset.");
      L.game = emptyGame();
      emitState(L);
    }
  });
});

function emitHands(L){
  const G = L.game;
  for (const p of L.players) {
    if (!p.id) continue;
    const raw = (G.hands[p.sid] || []);
    const hand = raw.filter(Boolean).map(c => ({
      color: c.color,
      type: c.type,
      value: (typeof c.value==="number" ? c.value : null),
      img: c.img
    }));
    io.to(p.id).emit("hand", hand);
  }
}
function emitState(L){
  const G = L.game;
  const state = {
    started: G.started,
    color: G.color,
    value: G.value,
    current: G.current,
    direction: G.direction,
    top: G.top,
    penalty: G.pendingPenalty ? { amount: G.pendingPenalty.amount, kind: G.pendingPenalty.kind, targetSid:G.pendingPenalty.targetSid } : null,
    players: L.players.map(p=> ({ id: p.id, sid:p.sid, name:p.name, spectator: !!p.spectator })),
    turnEndsAt: G.turnEndsAt,
    countdownEndsAt: null
  };
  io.in(L.room).emit("state", state);
  io.in(L.room).emit("admin:state", buildAdminState(L));
  emitHands(L);
}
function findLobbyBySocket(socket){
  for (const L of lobbies.values()){
    if (io.sockets.adapter.rooms.get(L.room)?.has(socket.id)) return L;
  }
  return null;
}

server.listen(PORT, ()=> console.log(`Server on :${PORT}`));
