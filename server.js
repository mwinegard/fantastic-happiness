// server.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { specialCardLogic } = require("./public/specialCards");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const lobbies = {};

function createDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  const numbers = [...Array(10).keys()].map(n => n.toString());
  const specials = ["draw", "skip", "reverse"];
  const wilds = ["wild", "wild_draw4", "wild_boss", "wild_packyourbags", "wild_rainbow", "wild_relax"];
  const extras = {
    red: ["red_it", "red_noc"],
    blue: ["blue_look", "blue_moon"],
    green: ["green_happy", "green_recycle"],
    yellow: ["yellow_pinkypromise", "yellow_shopping"]
  };

  const deck = [];
  colors.forEach(color => {
    numbers.forEach(n => deck.push(`${color}_${n}`));
    specials.forEach(s => deck.push(`${color}_${s}`));
    extras[color].forEach(x => deck.push(x));
  });
  deck.push(...wilds);

  return shuffle([...deck, ...deck]);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function resetGame(game) {
  game.deck = createDeck();
  game.discardPile = [game.deck.pop()];
  game.hands = {};
  game.turnMisses = {};
  game.currentTurn = game.order[0];
  game.turnStart = Date.now();
  game.order.forEach(id => {
    game.hands[id] = game.deck.splice(0, 7);
  });
}

function advanceTurn(game) {
  const idx = game.order.indexOf(game.currentTurn);
  const nextIdx = (idx + game.direction + game.order.length) % game.order.length;
  game.currentTurn = game.order[nextIdx];
  game.turnStart = Date.now();
  if (!game.turnMisses[game.currentTurn]) game.turnMisses[game.currentTurn] = 0;
}

function getNextPlayer(game) {
  const idx = game.order.indexOf(game.currentTurn);
  return game.order[(idx + game.direction + game.order.length) % game.order.length];
}

function sendState(lobbyId) {
  const game = lobbies[lobbyId];
  io.to(lobbyId).emit("state", {
    players: Object.values(game.players),
    hands: game.hands,
    discardPile: game.discardPile,
    currentTurn: game.currentTurn
  });
}

function startGameCountdown(lobby) {
  if (lobby.timer) return;
  lobby.timer = setTimeout(() => {
    resetGame(lobby);
    sendState(lobby.id);
    io.to(lobby.id).emit("chat", { from: "SUE", message: "Game started!" });
  }, 30000);
  io.to(lobby.id).emit("chat", { from: "SUE", message: "⏳ Game starting in 30 seconds..." });
}

function monitorTurnTimers() {
  setInterval(() => {
    Object.values(lobbies).forEach(lobby => {
      if (!lobby.currentTurn || !lobby.turnStart) return;
      const elapsed = Date.now() - lobby.turnStart;
      if (elapsed > 60000) {
        const player = lobby.currentTurn;
        lobby.turnMisses[player] = (lobby.turnMisses[player] || 0) + 1;
        io.to(lobby.id).emit("chat", { from: "SUE", message: `${lobby.players[player].name} missed their turn.` });

        if (lobby.turnMisses[player] >= 3) {
          const cards = lobby.hands[player] || [];
          const recipients = lobby.order.filter(id => id !== player);
          while (cards.length) {
            recipients.forEach(r => {
              if (cards.length) lobby.hands[r].push(cards.pop());
            });
          }
          delete lobby.players[player];
          delete lobby.hands[player];
          lobby.order = lobby.order.filter(id => id !== player);
          io.to(lobby.id).emit("chat", { from: "SUE", message: `${player} was removed for inactivity.` });

          if (lobby.order.length === 1) {
            const winner = lobby.order[0];
            lobby.players[winner].score += 50;
            io.to(lobby.id).emit("chat", {
              from: "SUE",
              message: `${lobby.players[winner].name} wins by default and gets 50 points.`
            });
            resetGame(lobby);
            return;
          }
        }
        advanceTurn(lobby);
        sendState(lobby.id);
      }
    });
  }, 5000);
}

monitorTurnTimers();

io.on("connection", (socket) => {
  socket.on("join", ({ name, lobby }) => {
    if (!lobbies[lobby]) {
      lobbies[lobby] = {
        id: lobby,
        players: {},
        order: [],
        hands: {},
        deck: [],
        discardPile: [],
        direction: 1,
        currentTurn: null,
        happyActive: false,
        turnMisses: {},
        reconnects: {},
        turnStart: null
      };
    }
    const game = lobbies[lobby];
    if (!game.players[socket.id] && game.order.length < 10) {
      game.players[socket.id] = { id: socket.id, name, score: 0 };
      game.order.push(socket.id);
      game.hands[socket.id] = game.deck.length ? game.deck.splice(0, 7) : [];
      io.to(lobby).emit("chat", { from: "SUE", message: `${name} joined.` });
    }
    socket.join(lobby);
    sendState(lobby);

    if (game.order.length >= 2 && !game.currentTurn) startGameCountdown(game);
  });

  socket.on("disconnect", () => {
    for (const lobby of Object.values(lobbies)) {
      if (lobby.players[socket.id]) {
        lobby.reconnects[socket.id] = lobby.hands[socket.id];
        io.to(lobby.id).emit("chat", { from: "SUE", message: `${lobby.players[socket.id].name} disconnected.` });
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
