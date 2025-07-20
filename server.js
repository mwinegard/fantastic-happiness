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
const countdowns = {};
const TURN_TIMEOUT = 60000;
const TURN_MISS_LIMIT = 3;
const MAX_PLAYERS = 10;

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
  game.order.forEach(id => {
    game.hands[id] = game.deck.splice(0, 7);
  });
  game.currentTurn = game.order[0];
  game.hasStarted = true;
  game.turnMisses = {};
  startTurnTimer(game);
}

function startGameCountdown(lobbyId) {
  if (countdowns[lobbyId]) return;
  countdowns[lobbyId] = setTimeout(() => {
    const game = lobbies[lobbyId];
    if (!game || Object.keys(game.players).length < 2) return;
    resetGame(game);
    io.to(lobbyId).emit("chat", { from: "SUE", message: "🟢 Game started!" });
    sendState(lobbyId);
    delete countdowns[lobbyId];
  }, 30000);

  io.to(lobbyId).emit("chat", {
    from: "SUE",
    message: "⏱ Game will start in 30 seconds..."
  });
}

function startTurnTimer(game) {
  clearTimeout(game.turnTimeout);
  game.turnTimeout = setTimeout(() => {
    const curId = game.currentTurn;
    game.turnMisses[curId] = (game.turnMisses[curId] || 0) + 1;

    if (game.turnMisses[curId] >= TURN_MISS_LIMIT) {
      io.to(game.id).emit("chat", {
        from: "SUE",
        message: `⏳ ${game.players[curId].name} missed 3 turns and was removed.`
      });
      removePlayer(game, curId);
    } else {
      game.hands[curId].push(game.deck.pop());
      advanceTurn(game);
      sendState(game.id);
    }
  }, TURN_TIMEOUT);
}

function advanceTurn(game) {
  const idx = game.order.indexOf(game.currentTurn);
  const nextIdx = (idx + game.direction + game.order.length) % game.order.length;
  game.currentTurn = game.order[nextIdx];
  startTurnTimer(game);
}

function removePlayer(socketId) {
  for (const [lobbyId, game] of Object.entries(lobbies)) {
    if (game?.players?.[socketId]) {
      delete game.players[socketId];

      if (Array.isArray(game.order)) {
        game.order = game.order.filter(id => id !== socketId);
      }

      if (Object.keys(game.players).length === 0) {
        delete lobbies[lobbyId];
      } else {
        sendState(lobbyId);
      }

      break;
    }
  }
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

io.on("connection", (socket) => {
  socket.on("join", ({ name, lobby }) => {
    if (!lobbies[lobby]) {
      lobbies[lobby] = {
        id: lobby,
        players: {},
        order: [],
        hands: {},
        deck: createDeck(),
        discardPile: [],
        direction: 1,
        currentTurn: null,
        happyActive: false,
        hasStarted: false,
        turnMisses: {}
      };
    }

    const game = lobbies[lobby];
    if (Object.keys(game.players).length >= MAX_PLAYERS) {
      socket.emit("chat", { from: "SUE", message: "Lobby full." });
      return;
    }

    if (!game.players[socket.id]) {
      game.players[socket.id] = { id: socket.id, name, score: 0 };
      game.order.push(socket.id);
      game.hands[socket.id] = game.deck.splice(0, 7);
    }

    socket.join(lobby);
    io.to(lobby).emit("chat", { from: "SUE", message: `${name} joined.` });

    if (game.order.length >= 2 && !game.hasStarted) {
      startGameCountdown(lobby);
    }

    sendState(lobby);
  });

  socket.on("disconnect", () => {
    for (const game of Object.values(lobbies)) {
      if (game.players[socket.id]) {
        removePlayer(game, socket.id);
        if (Object.keys(game.players).length === 0) {
          delete lobbies[game.id];
        } else {
          sendState(game.id);
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});


app.get("/lobbies", (req, res) => {
  const activeLobbies = {};
  for (const [lobbyId, game] of Object.entries(lobbies)) {
    activeLobbies[lobbyId] = Object.values(game.players).map(p => p.name);
  }
  res.json(activeLobbies);
});
