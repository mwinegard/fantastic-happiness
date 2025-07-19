const express = require("express");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");
const http = require("http");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const LOBBY_TIMEOUT_HOURS = 12;

let lobbies = {};
const scoresFile = path.join(__dirname, "scores.json");

function loadScores() {
  try {
    return JSON.parse(fs.readFileSync(scoresFile, "utf-8"));
  } catch {
    return {};
  }
}

function saveScores(scores) {
  fs.writeFileSync(scoresFile, JSON.stringify(scores, null, 2));
}

function cleanupLobbies() {
  const now = Date.now();
  for (const [lobbyId, lobby] of Object.entries(lobbies)) {
    if (now - lobby.createdAt > LOBBY_TIMEOUT_HOURS * 3600000) {
      delete lobbies[lobbyId];
    }
  }
}

setInterval(cleanupLobbies, 3600000);

function initDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  const numbers = [...Array(10).keys()];
  const actions = ["skip", "reverse", "draw"];
  const deck = [];

  for (const color of colors) {
    for (const num of numbers) deck.push(`${color}_${num}`);
    for (const act of actions) deck.push(`${color}_${act}`, `${color}_${act}`);
  }
  deck.push("wild", "wild", "wild_draw4", "wild_draw4");
  return shuffle(deck);
}

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

function emitState(lobby) {
  const state = {
    players: lobby.players.map(p => ({
      name: p.name,
      cards: p.name === lobby.currentPlayer ? p.cards : p.cards.map(() => "back"),
      score: p.score,
    })),
    currentPlayer: lobby.currentPlayer,
    topCard: lobby.topCard,
  };
  for (const p of lobby.players) {
    io.to(p.id).emit("updateState", state);
  }

  console.log(`[EMIT STATE] Sent to: ${lobby.players.map(p => p.name).join(", ")}`);
}

function broadcastChat(lobby, sender, message) {
  for (const p of lobby.players) {
    io.to(p.id).emit("chat", { sender, message });
  }
  console.log(`[CHAT] ${sender}: ${message}`);
}

function nextTurn(lobby) {
  lobby.currentIndex = (lobby.currentIndex + 1) % lobby.players.length;
  lobby.currentPlayer = lobby.players[lobby.currentIndex].name;
  emitState(lobby);
}

function startGame(lobby) {
  lobby.deck = initDeck();
  for (const p of lobby.players) {
    p.cards = lobby.deck.splice(0, 7);
  }

  // Ensure top card isn't wild
  let drawn;
  do {
    drawn = lobby.deck.pop();
  } while (drawn.startsWith("wild"));
  lobby.topCard = drawn;

  lobby.currentIndex = 0;
  lobby.currentPlayer = lobby.players[0].name;

  broadcastChat(lobby, "SUE", "Game started!");
  emitState(lobby);

  console.log(`[GAME START] Players: ${lobby.players.map(p => p.name).join(", ")}`);
}

function removePlayer(id, lobby) {
  const index = lobby.players.findIndex(p => p.id === id);
  if (index !== -1) {
    const [removed] = lobby.players.splice(index, 1);
    broadcastChat(lobby, "SUE", `${removed.name} has left or been removed.`);
    emitState(lobby);
  }
}

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", socket => {
  socket.on("joinLobby", ({ name, lobby }) => {
    if (!name || !lobby) return;
    if (!lobbies[lobby]) {
      lobbies[lobby] = {
        createdAt: Date.now(),
        players: [],
        deck: [],
        topCard: null,
        currentPlayer: null,
        currentIndex: 0,
      };
    }

    const lobbyData = lobbies[lobby];

    if (lobbyData.players.length >= MAX_PLAYERS) {
      socket.emit("lobbyFull");
      return;
    }

    lobbyData.players.push({ name, id: socket.id, cards: [], score: 0 });
    socket.join(lobby);
    broadcastChat(lobbyData, "SUE", `${name} has joined the game.`);

    console.log(`[JOIN] ${name} joined lobby ${lobby}`);

    if (lobbyData.players.length === 2) {
      broadcastChat(lobbyData, "SUE", "Game will start in 30 seconds...");
      let seconds = 30;
      const interval = setInterval(() => {
        seconds -= 5;
        if (seconds <= 0) {
          clearInterval(interval);
          startGame(lobbyData);
        } else {
          broadcastChat(lobbyData, "SUE", `${seconds} seconds until game starts...`);
        }
      }, 5000);
    } else {
      emitState(lobbyData); // immediately update UI on join
    }
  });

  socket.on("chat", ({ sender, message, lobby }) => {
    const l = lobbies[lobby];
    if (l) broadcastChat(l, sender, message);
  });

  socket.on("drawCard", ({ name, lobby }) => {
    const l = lobbies[lobby];
    const p = l?.players.find(p => p.name === name);
    if (p && l?.deck.length) {
      p.cards.push(l.deck.pop());
      nextTurn(l);
    }
  });

  socket.on("playCard", ({ name, lobby, index }) => {
    const l = lobbies[lobby];
    const p = l?.players.find(p => p.name === name);
    if (!l || !p) return;

    const card = p.cards[index];
    if (!card) return;

    const [topColor] = l.topCard.split("_");
    const [cardColor] = card.split("_");

    if (cardColor === topColor || card.startsWith("wild")) {
      l.topCard = card;
      p.cards.splice(index, 1);

      if (p.cards.length === 0) {
        broadcastChat(l, "SUE", `${p.name} wins the round!`);
        const scores = loadScores();
        const points = l.players.flatMap(p => p.cards).length * 10;
        scores[p.name] = (scores[p.name] || 0) + points;
        saveScores(scores);
      } else {
        nextTurn(l);
      }
    }
  });

  socket.on("leaveLobby", ({ name, lobby }) => {
    const l = lobbies[lobby];
    if (l) removePlayer(socket.id, l);
  });

  socket.on("disconnect", () => {
    for (const [lobbyId, lobby] of Object.entries(lobbies)) {
      removePlayer(socket.id, lobby);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
