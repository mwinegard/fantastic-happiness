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
const TURN_TIMEOUT_MS = 60000;

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
      cards: p.cards,
      score: p.score,
    })),
    currentPlayer: lobby.currentPlayer,
    topCard: lobby.topCard
  };

  lobby.players.forEach(p => {
    io.to(p.id).emit("updateState", {
      ...state,
      players: state.players.map(pl => ({
        ...pl,
        cards: pl.name === p.name ? pl.cards : pl.cards.map(() => "back")
      }))
    });
  });
}

function broadcastChat(lobby, sender, message) {
  const msg = typeof message === "string" ? message : JSON.stringify(message);
  const sdr = typeof sender === "string" ? sender : "SUE";
  for (const p of lobby.players) {
    io.to(p.id).emit("chat", { sender: sdr, message: msg });
  }
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

  // Ensure topCard is not wild
  do {
    lobby.topCard = lobby.deck.pop();
  } while (lobby.topCard.startsWith("wild"));

  lobby.currentIndex = 0;
  lobby.currentPlayer = lobby.players[0].name;
  broadcastChat(lobby, "SUE", "Game started!");
  emitState(lobby);
}

function removePlayer(id, lobby) {
  const index = lobby.players.findIndex(p => p.id === id);
  if (index !== -1) {
    const [removed] = lobby.players.splice(index, 1);
    if (lobby.players.length === 1) {
      const winner = lobby.players[0];
      broadcastChat(lobby, "SUE", `${winner.name} wins by default!`);
      const scores = loadScores();
      scores[winner.name] = (scores[winner.name] || 0) + 100;
      saveScores(scores);
    } else {
      for (let i = 0; i < removed.cards.length; i++) {
        const target = lobby.players[i % lobby.players.length];
        target.cards.push(lobby.deck.pop());
      }
    }
    broadcastChat(lobby, "SUE", `${removed.name} has left or been removed.`);
    emitState(lobby);
  }
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/leaderboard", (req, res) => {
  const scores = loadScores();
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  res.json(sorted);
});

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

    const room = lobbies[lobby];
    if (room.players.find(p => p.name === name)) {
      socket.emit("lobbyFull");
      return;
    }

    if (room.players.length >= MAX_PLAYERS) {
      socket.emit("lobbyFull");
      return;
    }

    const player = { name, id: socket.id, cards: [], score: 0 };
    room.players.push(player);
    socket.join(lobby);

    broadcastChat(room, "SUE", `${name} has joined the game.`);
    socket.emit("playerJoined", player);  // <- crucial line to unlock UI
    emitState(room);

    if (room.players.length === 2) {
      broadcastChat(room, "SUE", "Game will start in 30 seconds...");
      let seconds = 30;
      const interval = setInterval(() => {
        seconds -= 5;
        if (seconds <= 0) {
          clearInterval(interval);
          startGame(room);
        } else {
          broadcastChat(room, "SUE", `${seconds} seconds until game starts...`);
        }
      }, 5000);
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

    const top = l.topCard || "";
    const [topColor] = top.split("_");
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
    if (l) {
      removePlayer(socket.id, l);
    }
  });

  socket.on("disconnect", () => {
    for (const [lobbyId, lobby] of Object.entries(lobbies)) {
      removePlayer(socket.id, lobby);
    }
  });

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

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
