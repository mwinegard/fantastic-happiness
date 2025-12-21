// server.js — updated with admin controls, lobby lifecycle, hand rendering, and specials
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

const lobbies = new Map(); // name -> { name, room, players[], game, log[] }
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

function log(L, txt){
  L.log.push(`[${new Date().toLocaleTimeString()}] ${txt}`);
  if (L.log.length > 500) L.log.shift();
  io.in(L.room).emit("announce", txt);
}
const announce = log;

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
function secs(ms){ return Math.max(0, Math.ceil((+ms||0)/1000)); }

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
    for (let k=0;k<NUM_COPIES;k++){
      deck.push({ color, type:"skip", img:`${color}_skip.png`});
      deck.push({ color, type:"reverse", img:`${color}_reverse.png`});
      deck.push({ color, type:"draw2", img:`${color}_draw2.png`});
    }
    // color-gated specials
    deck.push({ color:"yellow", type:"yellow_shopping", img:`yellow_shopping.png`});
    deck.push({ color:"green", type:"green_recycle", img:`green_recycle.png`});
    deck.push({ color:"blue", type:"blue_moon", img:`blue_moon.png`});
    deck.push({ color:"red", type:"red_it", img:`red_it.png`});
    deck.push({ color:"red", type:"red_noc", img:`red_noc.png`});
  }
  for (let i=0;i<4;i++){
    deck.push({ color:"wild", type:"wild", img:`wild.png`});
    deck.push({ color:"wild", type:"wild_draw4", img:`wild_draw4.png`});
    deck.push({ color:"wild", type:"wild_relax", img:`wild_relax.png`});
    deck.push({ color:"wild", type:"wild_rainbow", img:`wild_rainbow.png`});
    deck.push({ color:"wild", type:"wild_boss", img:`wild_boss.png`});
    deck.push({ color:"wild", type:"wild_packyourbags", img:`wild_packyourbags.png`});
  }
  deck.push({ color:"blue", type:"blue_look", img:`blue_look.png`});
  deck.push({ color:"green", type:"green_happy", img:`green_happy.png`});

  for (let i=deck.length-1;i>0;i--){
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
  for (const p of L.players){
    if (p.spectator) continue;
    const cards = drawCards(G, START_HAND);
    G.hands[p.sid] = cards;
  }
  const first = drawCards(G,1)[0];
  if (!first) return;
  G.discard.push(first); G.top = first;
  G.color = COLORS.includes(first.color) ? first.color : sample(COLORS);
  G.value = first.type==="number" ? first.value : first.type;
}
function winnerIfAny(L){
  const G = L.game;
  for (const sid of Object.keys(G.hands)){
    if ((G.hands[sid]||[]).length===0) return sid;
  }
  return null;
}
function settleAndQueueNext(L, winnerSid){
  const G = L.game;
  const winnerName = sidToName(L, winnerSid);
  announce(L, `🏆 Round Winner: ${winnerName}!`);
  let pts = 0;
  for (const sid of Object.keys(G.hands)){
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
    G.pendingPenalty.amount += add;
    G.pendingPenalty.lastFromSid = fromSid;
    G.pendingPenalty.kind = kind;
  } else {
    G.pendingPenalty = { kind, amount: add, targetSid, lastFromSid: fromSid };
  }
  beginTurn(L, targetSid);
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
  socket.on("join", ({ name, lobby })=>{
    const playerName = (String(name||"Player").trim() || "Player").slice(0,24);
    const lobbyName = (String(lobby||"default").trim() || "default").slice(0,24);
    const L = ensureLobby(lobbyName);
    for (const r of socket.rooms) if (r!==socket.id) socket.leave(r);
    socket.join(L.room);

    let p = L.players.find(x=>x.id===socket.id);
    if (!p){
      p = { id: socket.id, sid: id(), name: playerName, spectator: false };
      L.players.push(p);
    } else {
      p.name = playerName;
    }

    // include sid so client can compare turn ownership
    socket.emit("me", { id: socket.id, sid: p.sid, name: p.name, lobby: lobbyName, spectator: p.spectator });
    announce(L, `👋 ${p.name} joined ${lobbyName}.`);

    if (!L.game.started && seatedPlayers(L).length>=2){
      L.game = emptyGame();
      L.game.started = true;
      L.game.nocTarget = null;
      deal(L);
      const order = activeOrder(L);
      beginTurn(L, order[0]);
    } else {
      emitState(L);
    }
  });

  socket.on("drawCard", ()=>{
    const L = findLobbyBySocket(socket); if (!L) return;
    const G = L.game; if (!G.started) return;
    const me = L.players.find(p=>p.id===socket.id); if (!me || me.sid!==G.current) return;

    if (G.pendingPenalty && G.pendingPenalty.targetSid===me.sid){
      restockDeckIfNeeded(G, G.pendingPenalty.amount);
      const hand = G.hands[me.sid] || [];
      hand.push(...drawCards(G, G.pendingPenalty.amount));
      announce(L, `😵 ${me.name} drew ${G.pendingPenalty.amount} (stack ended).`);
      G.pendingPenalty = null;
      advanceTurn(L,1); return emitState(L);
    }

    const card = drawCards(G,1)[0];
    (G.hands[me.sid] = G.hands[me.sid] || []).push(card);
    announce(L, `🃏 ${me.name} drew 1 card.`);
    advanceTurn(L,1); emitState(L);
  });

  socket.on("callUno", ()=>{
    const L = findLobbyBySocket(socket); if (!L) return;
    const me = L.players.find(p=>p.id===socket.id); if (!me) return;
    const hand = (L.game.hands[me.sid]||[]);
    if (hand.length===2){ announce(L, `📣 ${me.name} called UNO!`); }
    else { io.to(me.id).emit("warn", "You can only call UNO at 2 cards."); }
  });

  // Out-of-turn RELAX
  socket.on("playRelaxRequested", ()=>{
    const L = findLobbyBySocket(socket); if (!L?.game?.started) return;
    const G = L.game;
    const me = L.players.find(p=>p.id===socket.id); if (!me) return;
    const hand = G.hands[me.sid] || [];
    const idx = hand.findIndex(c => c.type==="wild_relax");
    if (idx<0) { io.to(me.id).emit("warn","🧘 You don't have a RELAX card."); return; }

    const penaltyActive = !!G.pendingPenalty;
    const myTurn = (G.current===me.sid);
    if (!penaltyActive && !myTurn) { io.to(me.id).emit("warn","🧘 RELAX can only be used on your turn or during a draw stack."); return; }
    if (!penaltyActive) { io.to(me.id).emit("warn","🧘 RELAX cancels draw stacks — there's no stack to cancel."); return; }

    const card = hand.splice(idx,1)[0];
    G.discard.push(card); G.top = card;

    const targetSid = G.pendingPenalty?.targetSid || G.current;
    G.pendingPenalty = null;
    if (targetSid) G.current = targetSid;
    announce(L, `🧘 RELAX! ${me.name} canceled the draw stack.`);

    endChooseColorAndFinish({
      io, L, G, me, specialType: "wild_relax",
      afterColor: ()=>{ G.turnEndsAt = now()+TURN_SECONDS*1000; emitState(L); }
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

  // Admin: new controls
  socket.on("admin:forceRoundEnd", () => {
    const L = findLobbyBySocket(socket); if (!L) return;
    const G = L.game; if (!G.started) return;
    const hands = Object.entries(G.hands).map(([sid,h])=>({sid, n:(h||[]).length}));
    if (!hands.length) return;
    hands.sort((a,b)=>a.n-b.n);
    const best = hands[0].n;
    const tied = hands.filter(x=>x.n===best);
    const winnerSid = (tied.length>1) ? tied[(Math.random()*tied.length)|0].sid : tied[0].sid;
    announce(L, "🛠️ Admin forced round end.");
    settleAndQueueNext(L, winnerSid);
  });
  socket.on("admin:resetGame", () => {
    const L = findLobbyBySocket(socket); if (!L) return;
    announce(L, "🛠️ Admin reset the game.");
    L.game = emptyGame();
    const seated = seatedPlayers(L);
    if (seated.length >= 2) {
      L.game.started = true;
      deal(L);
      beginTurn(L, activeOrder(L)[0]);
    } else {
      emitState(L);
    }
  });
  socket.on("admin:lobbyReset", () => {
    const L = findLobbyBySocket(socket); if (!L) return;
    announce(L, "🛠️ Admin reset the lobby (game cleared).");
    L.game = emptyGame();
    emitState(L);
  });
  socket.on("admin:lobbyClose", () => {
    const L = findLobbyBySocket(socket); if (!L) return;
    announce(L, "🛠️ Admin closed the lobby.");
    const room = io.sockets.adapter.rooms.get(L.room);
    if (room) {
      for (const sid of room) {
        const s = io.sockets.sockets.get(sid);
        try { s && s.leave(L.room); } catch {}
      }
    }
    closeLobby(L.name);
  });

  // Chat
  socket.on("chat", ({text})=>{
    const L = findLobbyBySocket(socket); if (!L) return;
    const me = L.players.find(p=>p.id===socket.id); if (!me) return;
    const msg = String(text||"").slice(0,400);
    io.in(L.room).emit("chat", { fromName: me.name, text: msg });
  });

  // Play a card
  socket.on("playCard", ({ index })=>{
    const L = findLobbyBySocket(socket); if (!L) return;
    const G = L.game; if (!G.started) return;
    const me = L.players.find(p=>p.id===socket.id); if (!me || me.sid!==G.current) return;
    const hand = G.hands[me.sid] || [];
    const i = Number(index);
    if (!Number.isInteger(i) || i<0 || i>=hand.length) return;

    const card = hand.splice(i,1)[0];
    G.discard.push(card); G.top = card;

    function legalPlay(card){
      if (String(card.color)==="wild") return true;
      if (card.type==="number"){
        return (card.color===G.color) || (card.value===G.value);
      }
      return (card.color===G.color) || (card.type===G.value);
    }
    if (!String(card.color).startsWith("wild") && !["yellow_shopping","green_recycle","blue_moon","red_it","red_noc","blue_look","green_happy"].includes(card.type)){
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
      G.color = card.color; G.value = "reverse";
      advanceTurn(L,1); return emitState(L);
    }
    if (card.type==="skip"){
      announce(L, `⏭️ Skip!`);
      G.color = card.color; G.value = "skip";
      advanceTurn(L,2); return emitState(L);
    }
    if (card.type==="draw2"){
      beginPenalty(L, me.sid, "draw2");
      return emitState(L);
    }

    // LOOK (top 4)
    if (card.type==="blue_look"){
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
      sock.once("lookTopOrder", ({order})=> applyOrder(order));
      return;
    }

    if (card.type==="green_happy"){
      G.roundFlags = G.roundFlags || {};
      G.roundFlags.happy = true;
      announce(L, `😊 Happy Mode enabled for the rest of the game.`);
      G.color = card.color; G.value = "green_happy";
      advanceTurn(L,1); return emitState(L);
    }

    // ---------------- Special color-gated ----------------
    if (card.type==="yellow_shopping"){
      if (G.color!=="yellow"){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        io.to(me.id).emit("warn","🛒 Shopping may only be played when the active color is YELLOW."); emitState(L); return;
      }
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
        if (canceled) return; if (!eligible.includes(targetSid)) { clearTimeout(t); return revert("🛒 Invalid target."); }
        const mySnap = (G.hands[me.sid]||[]).map((c,i)=>({i,color:c.color,type:c.type,value:c.value??null}));
        const tgSnap = (G.hands[targetSid]||[]).map((c,i)=>({i,color:c.color,type:c.type,value:c.value??null}));
        if (mySnap.length<2 || tgSnap.length<1){ clearTimeout(t); return revert("🛒 Not enough cards to trade."); }
        io.to(me.id).emit("shoppingPickGive",{ hand: mySnap });
        sock.once("shoppingGiveChosen", ({idx1,idx2})=>{
          if (canceled) return; const a=Number(idx1), b=Number(idx2);
          if (!Number.isInteger(a)||!Number.isInteger(b)||a===b){ clearTimeout(t); return revert("🛒 Pick two different cards."); }
          io.to(me.id).emit("shoppingPickTake",{ hand: tgSnap });
          sock.once("shoppingTakeChosen", ({idx})=>{
            clearTimeout(t);
            const myHand = G.hands[me.sid]||[], tgHand = G.hands[targetSid]||[];
            if (myHand.length<2 || idx<0 || idx>=tgHand.length) return revert("🛒 Selection invalid.");
            const sorted=[a,b].sort((x,y)=>y-x);
            const giving=[]; for (const ix of sorted){ if (ix<0 || ix>=myHand.length) return revert("🛒 Your selection no longer valid."); giving.push(myHand.splice(ix,1)[0]); }
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

    if (card.type==="blue_moon"){
      if (G.color!=="blue"){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        io.to(me.id).emit("warn","🌙 To The Moon may only be played when the active color is BLUE."); emitState(L); return;
      }
      const targets = seatedPlayers(L).filter(p=>p.sid!==me.sid);
      if (!targets.length){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        announce(L, `🌙 To The Moon canceled — no other players.`); emitState(L); return;
      }
      const recipient = sample(targets);
      (G.hands[recipient.sid] = G.hands[recipient.sid]||[]).push(...drawCards(G,1));
      announce(L, `🚀 To The Moon! A rocket lands near ${recipient.name}, delivering 1 extra card.`);
      G.color = card.color; G.value = "blue_moon";
      const w = winnerIfAny(L); if (w){ return settleAndQueueNext(L,w); }
      advanceTurn(L,1); return emitState(L);
    }

    if (card.type==="green_recycle"){
      if (G.color!=="green"){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        io.to(me.id).emit("warn","♻️ Recycle may only be played when the active color is GREEN."); emitState(L); return;
      }
      const acts = seatedPlayers(L); if (acts.length<2){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        announce(L, `♻️ Recycle canceled — not enough players.`); emitState(L); return;
      }
      const pool=[];
      for (const p of acts){ const h=G.hands[p.sid]||[]; while(h.length) pool.push(h.pop()); }
      for (let i=pool.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [pool[i],pool[j]]=[pool[j],pool[i]]; }
      const each = Math.floor(pool.length/acts.length);
      const extras = pool.length % acts.length;
      for (const p of acts){ G.hands[p.sid] = pool.splice(0, each); }
      const extraCards = pool.splice(0, extras);
      if (extraCards.length) putUnderSpecial(G, extraCards);
      announce(L, `♻️ Recycle! Each player received ${each} card(s). ${extras? `${extras} card(s) were recycled under the pile.` : `No extras this time.`}`);
      G.color = card.color; G.value = "green_recycle";
      const w = winnerIfAny(L); if (w){ return settleAndQueueNext(L,w); }
      advanceTurn(L,1); return emitState(L);
    }

    if (card.type==="red_noc"){
      if (G.color!=="red"){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        io.to(me.id).emit("warn","📄 NOC Notice may only be played when the active color is RED."); emitState(L); return;
      }
      if (!G.nocTarget){
        const acts = seatedPlayers(L);
        if (!acts.length){
          G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
          announce(L, `📄 NOC canceled — no seated players.`); emitState(L); return;
        }
        const chosen = sample(acts);
        G.nocTarget = chosen.sid;
        (G.hands[chosen.sid] = G.hands[chosen.sid]||[]).push(...drawCards(G,3));
        announce(L, `📄 NOC Notice issued! ${chosen.name} has been flagged and must draw 3.`);
      } else {
        const target = sidToPlayer(L, G.nocTarget);
        if (!target){
          announce(L, `📄 NOC Notice reminder attempted, but previous target left the game.`);
        } else {
          (G.hands[target.sid]=G.hands[target.sid]||[]).push(...drawCards(G,3));
          announce(L, `📄 NOC Notice reminder: ${target.name} is still flagged and draws 3 more.`);
        }
      }
      G.color = card.color; G.value = "red_noc";
      const w = winnerIfAny(L); if (w){ return settleAndQueueNext(L,w); }
      advanceTurn(L,1); return emitState(L);
    }

    if (card.type==="red_it"){
      if (G.color!=="red"){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        io.to(me.id).emit("warn","🧢 IT may only be played when the active color is RED."); emitState(L); return;
      }
      const order = activeOrder(L);
      if (order.length===2){
        announce(L, "🧢 IT peeks from the sewer… with only two players, Georgie’s paper boat just sails by. ‘We all float,’ whispers Pennywise.");
        G.color = card.color; G.value = "red_it";
        advanceTurn(L,1); return emitState(L);
      }
      const prevSid = previousActiveSid(L, me.sid);
      const nextSid = nextActiveSid(L, me.sid);
      if (!prevSid || !nextSid || prevSid===nextSid){
        announce(L, "🧢 IT slinks back into the sewer. Georgie’s boat vanishes down the drain…");
        G.color = card.color; G.value = "red_it";
        advanceTurn(L,1); return emitState(L);
      }
      const prevHand = G.hands[prevSid] = (G.hands[prevSid]||[]);
      const nextHand = G.hands[nextSid] = (G.hands[nextSid]||[]);
      if (!prevHand.length){
        announce(L, `🧢 IT tried to float a card from ${sidToName(L, prevSid)}, but there was nothing to float.`);
        G.color = card.color; G.value = "red_it";
        advanceTurn(L,1); return emitState(L);
      }
      const idx = (Math.random()*prevHand.length)|0;
      const floated = prevHand.splice(idx,1)[0];
      nextHand.push(floated);
      announce(L, `🧢 IT! ${sidToName(L, prevSid)} floats 1 random card to ${sidToName(L, nextSid)}.`);
      G.color = card.color; G.value = "red_it";
      const w = winnerIfAny(L); if (w){ return settleAndQueueNext(L,w); }
      advanceTurn(L,1); return emitState(L);
    }

    if (card.type==="wild_boss"){
      const acts = seatedPlayers(L);
      if (acts.length>1){
        const ranked = acts.map(p=>{
          const s = scores[p.name] || { wins:0, points:0 };
          return { sid:p.sid, name:p.name, points:+(s.points||0), wins:+(s.wins||0) };
        }).sort((a,b)=> (b.points-a.points) || (b.wins-a.wins) || a.name.localeCompare(b.name));
        let recipientSid;
        if (!ranked.length) recipientSid = sample(acts).sid;
        else {
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
          const idx = (Math.random()*h.length)|0;
          const given = h.splice(idx,1)[0];
          recHand.push(given);
          announce(L, `🎁 ${p.name} gifts 1 card to ${recipientName}.`);
        }
      }
      const w = winnerIfAny(L); if (w){ return settleAndQueueNext(L,w); }
      return endChooseColorAndFinish({
        io, L, G, me, specialType:"wild_boss",
        afterColor: ()=>{ advanceTurn(L,1); emitState(L); }
      });
    }

    if (card.type==="wild_packyourbags"){
      announce(L, `🧳 Pack Your Bags! Seats are being swapped — hands stay with seats.`);
      const order = activeOrder(L);
      if (order.length>1){
        const seatHands = order.map(sid=> (G.hands[sid]||[]));
        const curSeatIdx = order.indexOf(G.current);
        let penSeatIdx=null, fromSeatIdx=null;
        if (G.pendingPenalty){
          penSeatIdx = order.indexOf(G.pendingPenalty.targetSid);
          fromSeatIdx = order.indexOf(G.pendingPenalty.lastFromSid);
        }
        const newOrder = order.slice();
        for (let i=newOrder.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [newOrder[i],newOrder[j]]=[newOrder[j],newOrder[i]]; }
        for (let i=0;i<newOrder.length;i++) G.hands[newOrder[i]] = seatHands[i];
        for (const sid of Object.keys(G.hands)) if (!newOrder.includes(sid)) delete G.hands[sid];
        if (curSeatIdx>=0) G.current = newOrder[curSeatIdx];
        if (G.pendingPenalty){
          if (penSeatIdx!=null && penSeatIdx>=0) G.pendingPenalty.targetSid = newOrder[penSeatIdx];
          if (fromSeatIdx!=null && fromSeatIdx>=0) G.pendingPenalty.lastFromSid = newOrder[fromSeatIdx];
        }
        const nameAt = sid=>sidToName(L,sid); const pairs=[];
        for (let i=0;i<order.length;i++){ const a=nameAt(order[i]), b=nameAt(newOrder[i]); if (a!==b) pairs.push(`${a} → ${b}`); }
        if (pairs.length) announce(L, `🪑 Seats swapped: ${pairs.join(", ")}.`);
      }
      return endChooseColorAndFinish({
        io, L, G, me, specialType:"wild_packyourbags",
        afterColor: ()=> emitState(L)
      });
    }

    if (card.type==="yellow_pinkypromise"){
      if (G.color!=="yellow"){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        io.to(me.id).emit("warn","🤝 Pinky Promise may only be played when the active color is YELLOW."); emitState(L); return;
      }
      const others = seatedPlayers(L).map(p=>p.sid).filter(sid=>sid!==me.sid);
      if (!others.length){
        G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card);
        announce(L, `🤝 Pinky Promise canceled — no other players available.`); emitState(L); return;
      }
      announce(L, `🤝 ${me.name} is making a Pinky Promise…`);
      let canceled=false;
      const revert=(msg)=>{ if (canceled) return; canceled=true; G.discard.pop(); G.top = G.discard[G.discard.length-1] || null; hand.push(card); if (msg) io.to(me.id).emit("warn",msg); emitState(L); };
      const sock = io.sockets.sockets.get(me.id);
      const targets = others.map(sid=>({sid, name:sidToName(L,sid)}));
      if (targets.length===1){
        resolvePP(targets[0].sid);
      } else {
        io.to(me.id).emit("promiseChooseTarget",{targets});
        if (!sock) return revert("🤝 Pinky Promise timed out.");
        const t = setTimeout(()=> revert("🤝 Pinky Promise timed out."), 20000);
        sock.once("promiseTargetChosen", ({sid})=>{ clearTimeout(t); if (!others.includes(sid)) return revert("🤝 Invalid target."); resolvePP(sid); });
      }
      function resolvePP(targetSid){
        if (canceled) return;
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
      }
      return;
    }

    if (card.type==="wild_rainbow"){
      const my = G.hands[me.sid]||[];
      const sock = io.sockets.sockets.get(me.id);
      io.to(me.id).emit("rainbowPick", { hand: my.map((c,i)=>({i,color:c.color,type:c.type,value:c.value??null})) });
      const t = setTimeout(()=> autoPick(), 20000);
      function autoPick(){
        const picks=[]; const used=new Set();
        for (let i=0;i<my.length && used.size<4;i++){
          if (COLORS.includes(my[i].color) && !used.has(my[i].color)){ used.add(my[i].color); picks.push(i); }
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
        if (chosen.length<4){
          for (let i=0;i<my.length && chosen.length<4;i++){
            const c = my[i];
            if (COLORS.includes(c.color) && !chosen.find(x=>x.color===c.color)){
              chosen.push(my.splice(i,1)[0]); i--;
            }
          }
        }
        putUnderSpecial(G, chosen);
        announce(L, `🌈 Rainbow! ${sidToName(L, me.sid)} discarded one of each color.`);
        endChooseColorAndFinish({
          io, L, G, me, specialType:"wild_rainbow",
          afterColor: ()=>{ advanceTurn(L,1); emitState(L); }
        });
      }
      if (!sock) return autoPick();
      sock.once("rainbowChosen", ({indices})=> applyPick(Array.isArray(indices)?indices:[]));
      return;
    }

    if (card.type==="wild"){
      return endChooseColorAndFinish({
        io, L, G, me, specialType:"wild",
        afterColor: ()=>{ advanceTurn(L,1); emitState(L); }
      });
    }

    if (card.type==="wild_draw4"){
      beginPenalty(L, me.sid, "wild_draw4");
      return endChooseColorAndFinish({
        io, L, G, me, specialType:"wild_draw4",
        afterColor: ()=> emitState(L)
      });
    }

    if (card.type==="number"){
      G.color = card.color; G.value = card.value; G.top = card;
      advanceTurn(L,1); return emitState(L);
    }
    G.color = card.color; G.value = card.type; G.top = card;
    advanceTurn(L,1); emitState(L);
  });

  socket.on("disconnect", () => {
    let foundLobby = null, foundIdx = -1, player = null;
    for (const L of lobbies.values()) {
      const i = L.players.findIndex(p => p.id === socket.id);
      if (i !== -1) {
        foundLobby = L; foundIdx = i; player = L.players[i]; break;
      }
    }
    if (!foundLobby) return;
    const L = foundLobby;
    const G = L.game;
    const leaving = L.players.splice(foundIdx, 1)[0];

    if (leaving && G && G.hands && G.hands[leaving.sid]) {
      const giveBack = G.hands[leaving.sid];
      delete G.hands[leaving.sid];
      reshuffleCardsIntoDeck(G, giveBack);
      announce(L, `👋 ${leaving.name} left — their hand returned to the deck.`);
    } else {
      announce(L, `👋 ${leaving?.name || "A player"} left.`);
    }

    if (G && G.started && G.current === (leaving && leaving.sid)) {
      const order = activeOrder(L);
      if (order.length) {
        beginTurn(L, order[0]);
      } else {
        G.started = false;
        emitState(L);
      }
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
    const s = io.sockets.sockets.get(p.id);
    if (!s) continue;
    const hand = (G.hands[p.sid] || []).map(c => ({
      color: c.color, type: c.type, value: (typeof c.value==="number" ? c.value : null), img: c.img
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
    current: G.current,            // SID of current turn
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

// ---------- Boot ----------
server.listen(PORT, ()=> console.log(`Server on :${PORT}`));
