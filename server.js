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
const MAX_PLAYERS = 10;
const TURN_TIMEOUT = 60000;
const MAX_MISSES = 3;

function createDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  const numbers = [...Array(10).keys()].map(n => n.toString());
  const specials = ["draw", "skip", "reverse"];
  const wilds = [
    "wild", "wild_draw4", "wild_boss",
    "wild_packyourbags", "wild_rainbow", "wild_relax"
  ];
  const extras = {
    red: ["red_it", "red_noc"],
    blue: ["blue_look", "blue_moon"],
    green: ["green_happy", "green_recycle"],
    yellow: ["yellow_pinkypromise", "yellow_shopping"]
  };
  let deck = [];
  colors.forEach(color => {
    numbers.forEach(n => deck.push(`${color}_${n}`));
    specials.forEach(s => deck.push(`${color}_${s}`));
    extras[color].forEach(x => deck.push(x));
  });
  return shuffle([...deck, ...deck, ...wilds]);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function advanceTurn(game) {
  const idx = game.order.indexOf(game.currentTurn);
  const nextIdx = (idx + game.direction + game.order.length) % game.order.length;
  game.currentTurn = game.order[nextIdx];
  clearTimeout(game.turnTimer);
  startTurnTimer(game);
}

function startTurnTimer(game) {
  game.misses[game.currentTurn] = (game.misses[game.currentTurn] || 0);
  game.turnTimer = setTimeout(() => {
    game.misses[game.currentTurn]++;
    if (game.misses[game.currentTurn] >= MAX_MISSES) {
      bootPlayer(game, game.currentTurn);
    } else {
      advanceTurn(game);
      sendState(game.id);
    }
  }, TURN_TIMEOUT);
}

function bootPlayer(game, playerId) {
  const idx = game.order.indexOf(playerId);
  const hand = game.hands[playerId] || [];
  const others = game.order.filter(id => id !== playerId);
  hand.forEach((card, i) => {
    const target = others[i % others.length];
    game.hands[target].push(card);
  });

  delete game.players[playerId];
  delete game.hands[playerId];
  delete game.misses[playerId];
  game.order = game.order.filter(id => id !== playerId);
  io.to(game.id).emit("chat", { from: "SUE", message: `⚠️ A player was removed for inactivity.` });

  if (game.order.length === 1) {
    const winnerId = game.order[0];
    game.players[winnerId].score += 50;
    io.to(game.id).emit("chat", {
      from: "SUE",
      message: `🏆 ${game.players[winnerId].name} wins by default and earns 50 points!`
    });
    resetGame(game);
  } else {
    advanceTurn(game);
  }

  sendState(game.id);
}

function getNextPlayer(game) {
  const idx = game.order.indexOf(game.currentTurn);
  return game.order[(idx + game.direction + game.order.length) % game.order.length];
}

function resetGame(game) {
  game.deck = createDeck();
  game.discardPile = [game.deck.pop()];
  game.hands = {};
  game.misses = {};
  game.currentTurn = game.order[0];
  game.order.forEach(id => {
    game.hands[id] = game.deck.splice(0, 7);
  });
  startTurnTimer(game);
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
        hands: {},
        order: [],
        deck: createDeck(),
        discardPile: [],
        direction: 1,
        currentTurn: null,
        misses: {},
        happyActive: false
      };
    }

    const game = lobbies[lobby];
    if (Object.keys(game.players).length >= MAX_PLAYERS) {
      socket.emit("chat", { from: "SUE", message: "Lobby is full." });
      return;
    }

    if (!game.players[socket.id]) {
      game.players[socket.id] = { id: socket.id, name, score: 0 };
      game.order.push(socket.id);
      game.hands[socket.id] = game.deck.splice(0, 7);
    }

    socket.join(lobby);

    if (game.order.length === 2 && !game.timerStarted) {
      game.timerStarted = true;
      io.to(lobby).emit("chat", { from: "SUE", message: "⏳ Game starts in 30 seconds..." });
      setTimeout(() => {
        if (!game.currentTurn) {
          game.currentTurn = game.order[0];
          game.discardPile.push(game.deck.pop());
          startTurnTimer(game);
          sendState(lobby);
        }
      }, 30000);
    }

    sendState(lobby);
  });

  socket.on("playCard", ({ lobby, card, chosenColor }) => {
    const game = lobbies[lobby];
    if (!game || game.currentTurn !== socket.id) return;

    const hand = game.hands[socket.id];
    const cardIndex = hand.indexOf(card);
    if (cardIndex === -1) return;

    const topCard = game.discardPile[game.discardPile.length - 1];
    const topColor = topCard.split("_")[0];
    const cardColor = card.split("_")[0];

    if (card === "wild_rainbow") {
      const handColors = hand.map(c => c.split("_")[0]);
      const valid = ["red", "blue", "green", "yellow"].every(col => handColors.includes(col));
      if (!valid) {
        game.hands[socket.id].push(game.deck.pop());
        advanceTurn(game);
        sendState(lobby);
        return;
      }
    }

    if (cardColor !== "wild" && topColor !== cardColor && !topCard.startsWith(cardColor)) return;

    game.discardPile.push(hand.splice(cardIndex, 1)[0]);

    if (specialCardLogic[card]) {
      specialCardLogic[card](game, socket.id, io);
    }

    if (card === "wild_rainbow") {
      const reqColors = ["red", "blue", "green", "yellow"];
      const discards = [];
      reqColors.forEach(color => {
        const match = hand.find(c => c.startsWith(color));
        if (match) {
          hand.splice(hand.indexOf(match), 1);
          game.discardPile.push(match);
          discards.push(match);
        }
      });
      const last = discards[discards.length - 1];
      const newColor = last.split("_")[0];
      game.lastColor = newColor;

      if (last.includes("draw")) {
        const next = getNextPlayer(game);
        game.hands[next].push(...game.deck.splice(0, 2));
      } else if (last.includes("skip")) {
        advanceTurn(game);
      } else if (last.includes("reverse")) {
        if (game.order.length === 2) advanceTurn(game);
        else game.direction *= -1;
      }
    }

    if (game.hands[socket.id].length === 0) {
      game.players[socket.id].score += 1;
      io.to(lobby).emit("chat", {
        from: "SUE",
        message: `🎉 ${game.players[socket.id].name} has won the round!`
      });
      resetGame(game);
    } else {
      advanceTurn(game);
    }

    sendState(lobby);
  });

  socket.on("drawCard", ({ lobby }) => {
    const game = lobbies[lobby];
    if (!game || game.currentTurn !== socket.id) return;
    game.hands[socket.id].push(game.deck.pop());
    advanceTurn(game);
    sendState(lobby);
  });

  socket.on("chat", ({ message }) => {
    const lobby = Object.keys(lobbies).find(l => lobbies[l].players[socket.id]);
    if (!lobby) return;
    const game = lobbies[lobby];
    const from = game.players[socket.id]?.name || "Unknown";
    io.to(lobby).emit("chat", { from, message });
  });

  socket.on("disconnect", () => {
    const lobby = Object.values(lobbies).find(l => l.players[socket.id]);
    if (!lobby) return;

    if (!lobby.disconnected) lobby.disconnected = {};
    lobby.disconnected[socket.id] = Date.now();

    setTimeout(() => {
      const stillGone = Date.now() - (lobby.disconnected[socket.id] || 0) > 60000;
      if (stillGone && lobby.players[socket.id]) {
        bootPlayer(lobby, socket.id);
      }
    }, 60000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
