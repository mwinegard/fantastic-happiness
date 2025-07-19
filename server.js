const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const LOBBY_TIMEOUT_HOURS = 12;

let lobbies = {};
const scoresFile = path.join(__dirname, "scores.json");

// Utility: load/save scores
function loadScores() {
  try { return JSON.parse(fs.readFileSync(scoresFile, "utf-8")); }
  catch { return {}; }
}
function saveScores(scores) {
  fs.writeFileSync(scoresFile, JSON.stringify(scores, null, 2));
}

// Cleanup old lobbies
setInterval(() => {
  const now = Date.now();
  for (const [id, lb] of Object.entries(lobbies)) {
    if (now - lb.createdAt > LOBBY_TIMEOUT_HOURS * 3600000) {
      delete lobbies[id];
    }
  }
}, 3600000);

// Deck helpers
function initDeck() {
  const colors = ["red","blue","green","yellow"];
  const values = [...Array(10).keys()].map(String).concat(["skip","reverse","draw"]);
  let deck = [];
  for (const c of colors) {
    for (const v of values) {
      deck.push(`${c}_${v}`, `${c}_${v}`);
    }
  }
  for (let i=0;i<4;i++) deck.push("wild","wild_draw4");
  return deck.sort(()=>Math.random()-0.5);
}

// Emit game state to each player
function emitState(lobby) {
  const state = {
    players: lobby.players.map(p=>({
      name: p.name,
      cards: p.name === lobby.currentPlayer
             ? p.cards
             : p.cards.map(()=> "back"),
      score: p.score
    })),
    currentPlayer: lobby.currentPlayer,
    topCard: lobby.topCard
  };
  lobby.players.forEach(p => {
    io.to(p.id).emit("updateState", state);
  });
}

// Broadcast chat from SUE or player
function broadcastChat(lobby, sender, message) {
  lobby.players.forEach(p => {
    io.to(p.id).emit("chat", { sender, message });
  });
}

// Advance turn in round-robin
function nextTurn(lobby) {
  lobby.currentIndex = (lobby.currentIndex + 1) % lobby.players.length;
  lobby.currentPlayer = lobby.players[lobby.currentIndex].name;
  emitState(lobby);
}

// Start the game once 2+ players have joined
function startGame(lobby) {
  lobby.deck = initDeck();
  lobby.players.forEach(p => { p.cards = lobby.deck.splice(0,7); p.score = 0; });
  lobby.topCard = lobby.deck.pop();
  lobby.currentIndex = 0;
  lobby.currentPlayer = lobby.players[0].name;
  broadcastChat(lobby, "SUE", "Game started!");
  emitState(lobby);
}

// Remove a player (disconnect or leave)
function removePlayer(socketId, lobby) {
  const idx = lobby.players.findIndex(p => p.id === socketId);
  if (idx === -1) return;
  const [rem] = lobby.players.splice(idx,1);
  // Redistribute cards if more remain
  lobby.players.forEach((p,i)=>{
    while (rem.cards.length) {
      p.cards.push(rem.cards.pop());
    }
  });
  broadcastChat(lobby,"SUE", `${rem.name} has left.`);
  if (lobby.players.length === 0) {
    delete lobbies[lobby.id];
  } else {
    emitState(lobby);
  }
}

// Serve static assets & scores.json
app.use(express.static(path.join(__dirname,"public")));
app.get("/scores.json", (_,res)=> res.sendFile(scoresFile));

io.on("connection", socket => {
  console.log("🔌 Connection:", socket.id);

  socket.on("joinLobby", ({ name, lobby }) => {
    console.log("📥 joinLobby:", name, lobby);
    if (!name||!lobby) return;
    if (!lobbies[lobby]) {
      lobbies[lobby] = {
        id: lobby,
        createdAt: Date.now(),
        players: [],
        deck: [],
        topCard: null,
        currentPlayer: null,
        currentIndex: 0
      };
    }
    const L = lobbies[lobby];
    if (L.players.length >= MAX_PLAYERS
        || L.players.find(p=>p.name===name)) {
      socket.emit("lobbyFull");
      return;
    }
    L.players.push({ name, id: socket.id, cards: [], score: 0 });
    socket.join(lobby);

    broadcastChat(L,"SUE", `${name} joined the lobby.`);
    emitState(L);

    // Trigger 30s countdown once second player arrives
    if (L.players.length === 2) {
      broadcastChat(L,"SUE","Game starting in 30s...");
      let sec=30;
      const iv = setInterval(()=>{
        sec-=5;
        if (sec<=0) {
          clearInterval(iv);
          startGame(L);
        } else {
          broadcastChat(L,"SUE", `${sec}s until start...`);
        }
      },5000);
    }
  });

  socket.on("chat", ({ sender, message, lobby }) => {
    const L = lobbies[lobby];
    if (L) broadcastChat(L, sender, message);
  });

  socket.on("drawCard", ({ name, lobby })=>{
    const L = lobbies[lobby];
    const p = L?.players.find(x=>x.name===name);
    if (p && L.deck.length) {
      p.cards.push(L.deck.pop());
      nextTurn(L);
    }
  });

  socket.on("playCard", ({ name, lobby, index })=>{
    const L = lobbies[lobby];
    const p = L?.players.find(x=>x.name===name);
    if (!L||!p) return;
    const card = p.cards[index];
    if (!card) return;
    const topCol = L.topCard?.split("_")[0];
    const [col] = card.split("_");
    if (col===topCol||card.startsWith("wild")) {
      p.cards.splice(index,1);
      L.topCard=card;
      if (p.cards.length===0) {
        broadcastChat(L,"SUE",`${p.name} wins!`);
        // calculate points
        let pts=0;
        L.players.forEach(o=>o.cards.forEach(c=>{
          if (c.startsWith("wild")) pts+=50;
          else if (/_skip|_reverse|_draw/.test(c)) pts+=20;
          else pts+=parseInt(c.split("_")[1])||0;
        }));
        const scores = loadScores();
        scores[p.name]=(scores[p.name]||0)+pts;
        saveScores(scores);
      } else nextTurn(L);
    }
  });

  socket.on("leaveLobby", ({ lobby })=>{
    const L = lobbies[lobby];
    if (L) removePlayer(socket.id,L);
  });

  socket.on("disconnect", ()=>{
    console.log("❌ Disconnect:", socket.id);
    for (const L of Object.values(lobbies)) removePlayer(socket.id,L);
  });
});

server.listen(PORT, ()=>console.log(`🚀 Server on :${PORT}`));
