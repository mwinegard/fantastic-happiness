const express = require("express");
const basicAuth = require("express-basic-auth");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const lobbies = {};
const highScores = {}; // To track cumulative player scores

// Serve frontend
app.use(express.static("public"));
app.use("/admin.html", basicAuth({
  users: { admin: "password" },
  challenge: true
}));

// When lobby is full, send error
function sendLobbyFull(socket) {
  socket.emit("chatMessage", { from: "SUE", text: "**Lobby is full, try another.**" });
  socket.disconnect(true);
}

// Utility: broadcast game messages as SUE
function broadcastGameMsg(lobbyId, msg) {
  io.to(lobbyId).emit("chatMessage", { from: "SUE", text: `**${msg}**` });
}

io.on("connection", socket => {
  socket.on("joinLobby", ({ playerName, lobbyId }) => {
    if (!lobbies[lobbyId]) {
      lobbies[lobbyId] = {
        players: [],
        deck: [],
        discard: [],
        currentTurnIndex: 0,
        countdown: null
      };
    }
    const lobby = lobbies[lobbyId];
    if (lobby.players.length >= 10) return sendLobbyFull(socket);

    // Assign consistent UNO color to player
    const usedColors = lobby.players.map(p => p.color);
    const colors = ["red","blue","green","yellow"];
    const color = colors.find(c => !usedColors.includes(c)) || colors[Math.floor(Math.random()*4)];

    socket.join(lobbyId);
    const newPlayer = {
      id: socket.id,
      name: playerName,
      color,
      hand: [],
      score: 0,
      missed: 0
    };
    lobby.players.push(newPlayer);

    // Pre-game checks:
    io.to(lobbyId).emit("chatMessage", { from: "SUE", text: `**${playerName} has joined the lobby.**` });

    if (lobby.players.length < 2) {
      broadcastGameMsg(lobbyId, "Waiting for players...");
    } else if (!lobby.countdown) {
      // Start countdown
      let t = 30;
      broadcastGameMsg(lobbyId, "Game will begin in 30 seconds");
      lobby.countdown = setInterval(() => {
        t -= 5;
        if (t > 0) broadcastGameMsg(lobbyId, `Game starts in ${t} seconds`);
        else {
          clearInterval(lobby.countdown);
          lobby.countdown = null;
          startGame(lobbyId);
        }
      }, 5000);
    }

    emitState(lobbyId);
  });

  socket.on("playCard", data => {
    const lobbyId = getLobbyId(socket.id);
    if (!lobbyId) return;
    const lobby = lobbies[lobbyId];
    const player = lobby.players.find(p => p.id === socket.id);
    if (!player) return;

    // Remove played card
    const i = player.hand.indexOf(data.card);
    if (i === -1) return;
    player.hand.splice(i,1);
    lobby.discard.push(data.card);
    lobby.lastWildColor = data.wildColor || null;
    lobby.currentTurnIndex = (lobby.currentTurnIndex + 1) % lobby.players.length;
    emitState(lobbyId);
  });

  socket.on("drawCard", () => {
    const lobbyId = getLobbyId(socket.id);
    if (!lobbyId) return;
    const lobby = lobbies[lobbyId];
    const player = lobby.players.find(p => p.id === socket.id);
    if (player) {
      player.hand.push(draw(lobby));
      lobby.currentTurnIndex = (lobby.currentTurnIndex + 1) % lobby.players.length;
      emitState(lobbyId);
    }
  });

  socket.on("turnTimeout", () => {
    const lobbyId = getLobbyId(socket.id);
    if (!lobbyId) return;
    const lobby = lobbies[lobbyId];
    const player = lobby.players.find(p => p.id === socket.id);
    if (!player) return;

    player.hand.push(draw(lobby));
    player.missed++;
    if (player.missed >= 3) removePlayer(peer.id, lobby);
    else lobby.currentTurnIndex = (lobby.currentTurnIndex + 1) % lobby.players.length;
    emitState(lobbyId);
  });

  socket.on("chatMessage", msg => {
    const lobbyId = getLobbyId(socket.id);
    if (!lobbyId) return;
    const player = lobbies[lobbyId].players.find(p => p.id === socket.id);
    if (!player) return;
    io.to(lobbyId).emit("chatMessage", { from: player.name, color: player.color, text: msg });
  });

  socket.on("leaveGame", () => {
    const lobbyId = getLobbyId(socket.id);
    if (!lobbyId) return;
    removePlayer(socket.id, lobbies[lobbyId]);
    emitState(lobbyId);
  });

  socket.on("disconnect", () => {
    const lobbyId = getLobbyId(socket.id);
    if (!lobbyId) return;
    removePlayer(socket.id, lobbies[lobbyId]);
    emitState(lobbyId);
  });

  // --- Admin handlers ---
  socket.on("adminRequestLobbies", () => socket.emit("adminLobbies", {
    lobbies,
    highScores
  }));

  socket.on("adminKickPlayer", ({ lobbyId, playerId }) => {
    const l = lobbies[lobbyId];
    if (l) {
      removePlayer(playerId, l);
      emitState(lobbyId);
    }
  });

  socket.on("adminCloseLobby", lobbyId => {
    delete lobbies[lobbyId];
  });
});

// --- Utility Functions ---

function startGame(lobbyId) {
  const lobby = lobbies[lobbyId];
  clearInterval(lobby.countdown);
  lobby.countdown = null;

  lobby.deck = createDeck();
  shuffle(lobby.deck);
  lobby.discard = [draw(lobby)];
  lobby.players.forEach((p, idx) => {
    p.hand = [];
    for (let i = 0; i < 7; i++) p.hand.push(draw(lobby));
    p.missed = 0;
  });
  broadcastGameMsg(lobbyId, `Starting order: ${lobby.players.map(p => p.name).join(", ")}`);
  emitState(lobbyId);
}

function emitState(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  const turnId = lobby.players[lobby.currentTurnIndex]?.id;

  lobby.players.forEach(p => {
    io.to(p.id).emit("gameState", {
      players: lobby.players.map(pl => ({
        id: pl.id,
        name: pl.name,
        handCount: pl.hand.length,
        score: pl.score
      })),
      currentTurn: turnId,
      topCard: lobby.discard[lobby.discard.length - 1],
      lastWildColor: lobby.lastWildColor,
      yourHand: p.hand
    });
  });
}

function removePlayer(playerId, lobby) {
  const idx = lobby.players.findIndex(p => p.id === playerId);
  if (idx === -1) return;
  const removed = lobby.players.splice(idx,1)[0];
  const hand = removed.hand;
  if (lobby.players.length === 1) {
    const winner = lobby.players[0];
    const pts = calculatePoints(hand);
    winner.score += pts;
    highScores[winner.name] = (highScores[winner.name]||0) + pts;
    io.to(winner.id).emit("chatMessage", { from:"SUE", text:"**Congratulations, you are the Champion!**" });
    delete lobbies[getLobbyIdByLobby(lobby)];
  } else {
    // redistribute cards
    hand.forEach((c,i) => {
      lobby.players[i % lobby.players.length].hand.push(c);
    });
  }
}

function draw(lobby) {
  if (lobby.deck.length === 0) {
    lobby.deck = [...lobby.discard];
    lobby.discard = [];
    shuffle(lobby.deck);
  }
  return lobby.deck.pop();
}

function calculatePoints(cards) {
  return cards.reduce((acc,c) => {
    if (/\d/.test(c)) return acc + parseInt(c.match(/\d/)[0]);
    if (c.includes("draw4")||c.includes("wild")) return acc + 50;
    return acc + 20;
  },0);
}

function getLobbyId(socketId) {
  return Object.entries(lobbies).find(([_, lb]) => 
    lb.players.some(p => p.id === socketId)
  )?.[0];
}

function createDeck() {
  const colors = ["red","yellow","green","blue"];
  const vals = ["0","1","2","3","4","5","6","7","8","9","skip","reverse","draw"];
  const d = [];
  colors.forEach(col => {
    vals.forEach(v => {
      d.push(`${col}_${v}.png`);
      if (v !== "0") d.push(`${col}_${v}.png`);
    });
  });
  ["wild.png","wild_draw4.png"].forEach(c => { d.push(c,c); });
  return d;
}

function shuffle(a) {
  for (let i=a.length-1;i>0;i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
