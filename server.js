const express = require("express");
const basicAuth = require("express-basic-auth");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const lobbies = {};

app.use(express.static("public"));

// Admin login
app.use("/admin.html", basicAuth({
  users: { admin: "password" },
  challenge: true
}));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

io.on("connection", (socket) => {
  socket.on("joinLobby", ({ playerName, lobbyId }) => {
    if (!lobbies[lobbyId]) {
      lobbies[lobbyId] = { players: [], deck: [], discard: [], timer: null };
    }

    const player = {
      id: socket.id,
      name: playerName,
      hand: [],
      handCount: 0,
      score: 0,
      missedTurns: 0
    };

    lobbies[lobbyId].players.push(player);
    socket.join(lobbyId);
    startGame(lobbyId);
  });

  socket.on("playCard", ({ card, wildColor }) => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby) return;
    lobby.discard.push(card);
    if (card.includes("wild") && wildColor) {
      lobby.lastWildColor = wildColor;
    } else {
      lobby.lastWildColor = null;
    }
    nextTurn(lobby);
    emitState(lobby);
  });

  socket.on("drawCard", () => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby) return;
    const player = lobby.players.find(p => p.id === socket.id);
    if (player) player.hand.push(drawFromDeck(lobby));
    emitState(lobby);
  });

  socket.on("turnTimeout", () => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby) return;
    const player = lobby.players.find(p => p.id === socket.id);
    if (!player) return;
    player.hand.push(drawFromDeck(lobby));
    player.missedTurns++;
    if (player.missedTurns >= 3) removePlayer(socket.id, lobby);
    else nextTurn(lobby);
    emitState(lobby);
  });

  socket.on("chatMessage", (msg) => {
    const lobbyId = getLobbyId(socket.id);
    if (lobbyId) io.to(lobbyId).emit("chatMessage", msg);
  });

  socket.on("leaveGame", () => {
    const lobby = getLobbyForSocket(socket.id);
    if (lobby) {
      removePlayer(socket.id, lobby);
      emitState(lobby);
    }
  });

  socket.on("disconnect", () => {
    const lobby = getLobbyForSocket(socket.id);
    if (lobby) {
      removePlayer(socket.id, lobby);
      emitState(lobby);
    }
  });

  // 🔧 Admin features
  socket.on("adminRequestLobbies", () => {
    socket.emit("adminLobbies", lobbies);
  });

  socket.on("adminKickPlayer", ({ lobbyId, playerId }) => {
    const lobby = lobbies[lobbyId];
    if (lobby) {
      removePlayer(playerId, lobby);
      emitState(lobby);
    }
  });

  socket.on("adminCloseLobby", (lobbyId) => {
    delete lobbies[lobbyId];
  });
});

function startGame(lobbyId) {
  const lobby = lobbies[lobbyId];
  const deck = createDeck();
  shuffle(deck);
  lobby.deck = deck;
  lobby.discard = [deck.pop()];
  lobby.lastWildColor = null;

  for (const p of lobby.players) {
    p.hand = [];
    for (let i = 0; i < 7; i++) {
      p.hand.push(deck.pop());
    }
    p.handCount = p.hand.length;
  }

  lobby.currentTurn = lobby.players[0]?.id;
  emitState(lobby);
}

function nextTurn(lobby) {
  const currentIndex = lobby.players.findIndex(p => p.id === lobby.currentTurn);
  const nextIndex = (currentIndex + 1) % lobby.players.length;
  lobby.currentTurn = lobby.players[nextIndex].id;
}

function drawFromDeck(lobby) {
  if (lobby.deck.length === 0) {
    lobby.deck = [...lobby.discard];
    lobby.discard = [];
    shuffle(lobby.deck);
  }
  return lobby.deck.pop();
}

function removePlayer(socketId, lobby) {
  const leaving = lobby.players.find(p => p.id === socketId || p.id === socketId.id);
  if (!leaving) return;
  const handToSplit = [...leaving.hand];
  lobby.players = lobby.players.filter(p => p.id !== socketId && p.id !== socketId.id);

  if (lobby.players.length === 1) {
    lobby.players[0].score += calculatePoints(handToSplit);
    io.to(lobby.players[0].id).emit("chatMessage", "🎉 Congratulations, you are the Champion!");
    delete lobbies[getLobbyId(socketId)];
  } else {
    let i = 0;
    while (handToSplit.length > 0) {
      lobby.players[i % lobby.players.length].hand.push(handToSplit.pop());
      i++;
    }
  }

  if (lobby.players.length === 0) {
    delete lobbies[getLobbyId(socketId)];
  }
}

function calculatePoints(cards) {
  let total = 0;
  for (const c of cards) {
    if (c.match(/[0-9]/)) total += parseInt(c.match(/[0-9]/)[0]);
    else if (c.includes("draw4") || c.includes("wild")) total += 50;
    else if (c.includes("draw") || c.includes("skip") || c.includes("reverse")) total += 20;
  }
  return total;
}

function emitState(lobby) {
  for (const p of lobby.players) {
    io.to(p.id).emit("gameState", {
      players: lobby.players.map(pl => ({
        id: pl.id,
        name: pl.name,
        handCount: pl.hand.length,
        score: pl.score
      })),
      currentTurn: lobby.currentTurn,
      topCard: lobby.discard[lobby.discard.length - 1],
      lastWildColor: lobby.lastWildColor,
      deckSize: lobby.deck.length,
      discardSize: lobby.discard.length,
      yourHand: p.hand
    });
  }
}

function getLobbyId(socketId) {
  return Object.keys(lobbies).find(lobbyId =>
    lobbies[lobbyId].players.some(p => p.id === socketId || p.id === socketId.id)
  );
}

function getLobbyForSocket(socketId) {
  const lobbyId = getLobbyId(socketId);
  return lobbies[lobbyId];
}

function createDeck() {
  const colors = ["red", "yellow", "green", "blue"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw"];
  const deck = [];

  for (const color of colors) {
    for (const value of values) {
      if (value === "0") deck.push(`${color}_0.png`);
      else {
        deck.push(`${color}_${value}.png`);
        deck.push(`${color}_${value}.png`);
      }
    }
  }

  ["wild.png", "wild_draw4.png"].forEach(card => {
    deck.push(card, card);
  });

  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
