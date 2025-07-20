// server.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const lobbies = {};
const scoresPath = path.join(__dirname, "scores.json");

function generateDeck() {
  const colors = ["red", "green", "blue", "yellow"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw2"];
  const deck = [];

  for (let color of colors) {
    deck.push(`${color}_0`);
    for (let i = 1; i <= 9; i++) {
      deck.push(`${color}_${i}`, `${color}_${i}`);
    }
    for (let action of ["skip", "reverse", "draw2"]) {
      deck.push(`${color}_${action}`, `${color}_${action}`);
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push("wild", "wild_draw4", "wild_rainbow");
  }

  return deck.sort(() => Math.random() - 0.5);
}

function getScores() {
  if (!fs.existsSync(scoresPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(scoresPath, "utf-8"));
  } catch {
    return {};
  }
}

function saveScores(scores) {
  fs.writeFileSync(scoresPath, JSON.stringify(scores, null, 2));
}

function updateScores(winner, others) {
  const scores = getScores();
  if (!scores[winner]) scores[winner] = { score: 0, wins: 0 };

  let winnerPoints = 0;
  others.forEach(p => {
    const value = p.cards.reduce((sum, c) => {
      const parts = c.split("_");
      const val = parts[1];
      if (!isNaN(val)) return sum + parseInt(val);
      if (val === "skip" || val === "reverse" || val === "draw2") return sum + 20;
      if (val === "wild" || val === "draw4" || val === "rainbow") return sum + 50;
      return sum;
    }, 0);
    winnerPoints += value;
  });

  scores[winner].score += winnerPoints;
  scores[winner].wins += 1;
  saveScores(scores);
}

function emitState(lobbyId) {
  const game = lobbies[lobbyId];
  if (!game) return;

  const hands = {};
  game.players.forEach(p => {
    hands[p.id] = game.hands[p.id] || [];
  });

  io.to(lobbyId).emit("state", {
    hasStarted: game.started,
    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score || 0,
      handSize: (game.hands[p.id] || []).length
    })),
    hands,
    discardPile: game.discardPile || [],
    currentTurn: game.turn,
  });
}

function startGame(lobbyId) {
  const game = lobbies[lobbyId];
  if (!game || game.players.length < 2) return;

  game.deck = generateDeck();
  game.hands = {};
  game.discardPile = [];
  game.started = true;

  game.players.forEach(player => {
    game.hands[player.id] = [];
    for (let i = 0; i < 7; i++) {
      game.hands[player.id].push(game.deck.pop());
    }
  });

  game.discardPile.push(game.deck.pop());
  game.turnIndex = 0;
  game.turn = game.players[game.turnIndex].id;

  io.to(lobbyId).emit("chat", { from: "SUE", message: "Game has started!" });
  emitState(lobbyId);
}

function removePlayer(socket) {
  for (let [lobbyId, game] of Object.entries(lobbies)) {
    const index = game.players.findIndex(p => p.id === socket.id);
    if (index !== -1) {
      const [removed] = game.players.splice(index, 1);
      delete game.hands[socket.id];

      if (game.players.length === 0) {
        delete lobbies[lobbyId];
      } else {
        emitState(lobbyId);
      }
      break;
    }
  }
}

io.on("connection", (socket) => {
  socket.on("join", ({ name, lobby }) => {
    socket.join(lobby);
    if (!lobbies[lobby]) {
      lobbies[lobby] = {
        players: [],
        deck: [],
        discardPile: [],
        hands: {},
        started: false
      };
    }

    const game = lobbies[lobby];
    game.players.push({ id: socket.id, name, score: 0 });

    emitState(lobby);
    socket.to(lobby).emit("chat", { from: "SUE", message: `${name} joined.` });

    if (game.players.length >= 2 && !game.started) {
      io.to(lobby).emit("chat", { from: "SUE", message: "Game will start in 30s" });
      setTimeout(() => startGame(lobby), 30000);
    }
  });

  socket.on("playCard", ({ lobby, card, chosenColor }) => {
    const game = lobbies[lobby];
    if (!game || !game.started) return;
    const playerId = socket.id;
    const hand = game.hands[playerId];

    if (!hand || !hand.includes(card)) return;

    const index = hand.indexOf(card);
    hand.splice(index, 1);

    if (card.startsWith("wild") && chosenColor) {
      game.discardPile.push(`${chosenColor}_${card}`);
    } else {
      game.discardPile.push(card);
    }

    if (hand.length === 0) {
      const winner = game.players.find(p => p.id === playerId).name;
      const others = game.players
        .filter(p => p.id !== playerId)
        .map(p => ({ name: p.name, cards: game.hands[p.id] }));

      updateScores(winner, others);
      io.to(lobby).emit("chat", { from: "SUE", message: `${winner} has won the game!` });

      game.started = false;
      game.deck = [];
      emitState(lobby);
      return;
    }

    game.turnIndex = (game.turnIndex + 1) % game.players.length;
    game.turn = game.players[game.turnIndex].id;
    emitState(lobby);
  });

  socket.on("drawCard", ({ lobby }) => {
    const game = lobbies[lobby];
    if (!game || !game.started) return;
    const playerId = socket.id;
    const hand = game.hands[playerId];

    if (!hand) return;

    const drawn = game.deck.pop();
    hand.push(drawn);
    emitState(lobby);
  });

  socket.on("chat", ({ message }) => {
    const player = Object.values(lobbies)
      .flatMap(g => g.players)
      .find(p => p.id === socket.id);

    const from = player ? player.name : "Unknown";
    const lobbyId = Object.entries(lobbies).find(([_, g]) =>
      g.players.some(p => p.id === socket.id)
    )?.[0];

    if (lobbyId) {
      io.to(lobbyId).emit("chat", { from, message });
    }
  });

  socket.on("disconnect", () => {
    removePlayer(socket);
  });
});
