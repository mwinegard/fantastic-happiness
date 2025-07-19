const express = require("express");
const http = require("http");
const fs = require("fs");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const lobbies = {};
const SCORES_FILE = "./scores.json";

// Serve static files
app.use(express.static("public"));

// Leaderboard API
app.get("/api/leaderboard", (req, res) => {
  if (fs.existsSync(SCORES_FILE)) {
    const scores = JSON.parse(fs.readFileSync(SCORES_FILE));
    const sorted = Object.entries(scores)
      .map(([name, score]) => ({ name, score }))
      .sort((a, b) => b.score - a.score);
    res.json(sorted);
  } else {
    res.json([]);
  }
});

io.on("connection", (socket) => {
  let currentLobby = "";
  let currentPlayer = "";

  socket.on("joinLobby", ({ playerName, lobbyId }) => {
    if (!lobbies[lobbyId]) {
      lobbies[lobbyId] = {
        players: [],
        deck: [],
        pile: [],
        started: false,
        chat: [],
      };
    }

    const lobby = lobbies[lobbyId];

    if (lobby.players.length >= MAX_PLAYERS) {
      socket.emit("chatMessage", {
        sender: "SUE",
        message: "Lobby is full. Please try another.",
        system: true,
      });
      return;
    }

    if (lobby.started) {
      lobby.players.push({ id: socket.id, name: playerName, hand: [] });
      socket.join(lobbyId);
      socket.emit("joinedLobby", lobby);
      broadcastChat(lobbyId, `🃏 ${playerName} joined late and was added to the game.`);
      return;
    }

    lobby.players.push({ id: socket.id, name: playerName, hand: [] });
    socket.join(lobbyId);
    currentLobby = lobbyId;
    currentPlayer = playerName;

    io.to(lobbyId).emit("joinedLobby", lobby);

    broadcastChat(lobbyId, `🃏 ${playerName} joined the lobby.`);

    if (lobby.players.length >= 2 && !lobby.started) {
      broadcastChat(lobbyId, "Waiting for players… Game starts in 30 seconds.");
      setTimeout(() => startGame(lobbyId), 30000);
    }
  });

  socket.on("chatMessage", ({ lobbyId, sender, message }) => {
    io.to(lobbyId).emit("chatMessage", {
      sender,
      message,
      system: sender === "SUE",
    });
  });

  socket.on("leaveLobby", ({ lobbyId, playerName }) => {
    removePlayer(socket.id, lobbyId, playerName);
  });

  socket.on("disconnect", () => {
    removePlayer(socket.id, currentLobby, currentPlayer);
  });

  function removePlayer(socketId, lobbyId, name) {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    lobby.players = lobby.players.filter(p => p.id !== socketId);
    broadcastChat(lobbyId, `${name} has left the game.`);

    if (lobby.players.length === 0) {
      delete lobbies[lobbyId];
    } else {
      io.to(lobbyId).emit("gameState", lobby);
    }
  }

  function broadcastChat(lobbyId, message) {
    io.to(lobbyId).emit("chatMessage", {
      sender: "SUE",
      message,
      system: true
    });
  }

  function startGame(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby || lobby.started) return;

    const deck = buildDeck();
    shuffle(deck);
    lobby.deck = deck;
    lobby.pile = [];

    for (let player of lobby.players) {
      player.hand = deck.splice(0, 7);
    }

    const topCard = deck.shift();
    lobby.pile.push(topCard);
    lobby.started = true;

    io.to(lobbyId).emit("chatMessage", {
      sender: "SUE",
      message: `Game starting! First card is ${topCard}`,
      system: true
    });

    io.to(lobbyId).emit("gameState", {
      players: lobby.players.map(p => ({ name: p.name, hand: p.hand })),
      pileTopCard: topCard,
      drawPileCount: lobby.deck.length,
    });
  }
});

// Util functions
function buildDeck() {
  const colors = ["red", "green", "blue", "yellow"];
  const deck = [];

  for (let color of colors) {
    for (let n = 0; n <= 9; n++) deck.push(`${color}_${n}.png`);
    deck.push(`${color}_skip.png`);
    deck.push(`${color}_reverse.png`);
    deck.push(`${color}_draw.png`);
  }

  deck.push("wild.png", "wild_draw4.png", "wild.png", "wild_draw4.png");
  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
