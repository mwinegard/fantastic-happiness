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

function createDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  const numbers = [...Array(10).keys()].map(n => n.toString());
  const specials = ["draw", "skip", "reverse"];
  const wilds = [
    "wild", "wild_draw4", "wild_boss", "wild_packyourbags", "wild_rainbow", "wild_relax"
  ];
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
        started: false
      };
    }

    const game = lobbies[lobby];
    if (game.order.length >= 10) {
      socket.emit("chat", { from: "SUE", message: "Lobby is full (max 10)." });
      return;
    }

    game.players[socket.id] = { id: socket.id, name, score: 0 };
    game.order.push(socket.id);
    socket.join(lobby);

    io.to(lobby).emit("chat", { from: "SUE", message: `${name} joined.` });

    // Start countdown if 2 or more players and not started
    if (game.order.length >= 2 && !game.started && !countdowns[lobby]) {
      io.to(lobby).emit("chat", { from: "SUE", message: "⏳ Game starts in 30 seconds..." });
      countdowns[lobby] = setTimeout(() => {
        startGame(game);
        delete countdowns[lobby];
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
      const colorsInHand = hand.map(c => c.split("_")[0]);
      const hasAll = ["red", "blue", "green", "yellow"].every(color => colorsInHand.includes(color));
      if (!hasAll) {
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
      const requiredColors = ["red", "blue", "green", "yellow"];
      const discards = [];
      requiredColors.forEach(color => {
        const match = hand.find(c => c.startsWith(color));
        if (match) discards.push(match);
      });
      discards.forEach(c => {
        const i = hand.indexOf(c);
        if (i !== -1) {
          hand.splice(i, 1);
          game.discardPile.push(c);
        }
      });

      const lastCard = discards[discards.length - 1];
      if (lastCard?.includes("draw")) {
        const next = getNextPlayer(game);
        game.hands[next].push(...game.deck.splice(0, 2));
      } else if (lastCard?.includes("skip")) {
        advanceTurn(game);
      } else if (lastCard?.includes("reverse")) {
        if (game.order.length === 2) advanceTurn(game);
        else game.direction *= -1;
      }

      game.lastColor = lastCard.split("_")[0];
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
    const from = lobbies[lobby].players[socket.id]?.name || "Unknown";
    io.to(lobby).emit("chat", { from, message });
  });

  socket.on("disconnect", () => {
    for (const game of Object.values(lobbies)) {
      if (game.players[socket.id]) {
        const name = game.players[socket.id].name;
        delete game.players[socket.id];
        delete game.hands[socket.id];
        game.order = game.order.filter(id => id !== socket.id);

        io.to(game.id).emit("chat", { from: "SUE", message: `⚠️ ${name} left the game.` });

        // Distribute their hand
        const leaverCards = game.hands[socket.id] || [];
        const remaining = game.order;
        leaverCards.forEach((card, i) => {
          const pid = remaining[i % remaining.length];
          game.hands[pid].push(card);
        });

        if (game.order.length === 1) {
          const winnerId = game.order[0];
          game.players[winnerId].score += 50;
          io.to(game.id).emit("chat", {
            from: "SUE",
            message: `🏆 ${game.players[winnerId].name} wins by default and earns 50 points!`
          });
          resetGame(game);
        } else if (game.currentTurn === socket.id) {
          advanceTurn(game);
        }

        sendState(game.id);
        break;
      }
    }
  });
});

function startGame(game) {
  game.started = true;
  game.deck = createDeck();
  game.discardPile = [game.deck.pop()];
  game.hands = {};
  game.order.forEach(id => {
    game.hands[id] = game.deck.splice(0, 7);
  });
  game.currentTurn = game.order[0];
  io.to(game.id).emit("chat", { from: "SUE", message: "🎮 Game started!" });
  sendState(game.id);
}

function resetGame(game) {
  game.deck = createDeck();
  game.discardPile = [game.deck.pop()];
  game.hands = {};
  game.started = false;
  game.happyActive = false;
  game.order.forEach(id => {
    game.hands[id] = game.deck.splice(0, 7);
  });
  game.currentTurn = game.order[0];
  sendState(game.id);
}

function advanceTurn(game) {
  const idx = game.order.indexOf(game.currentTurn);
  const nextIdx = (idx + game.direction + game.order.length) % game.order.length;
  game.currentTurn = game.order[nextIdx];
}

function getNextPlayer(game) {
  const idx = game.order.indexOf(game.currentTurn);
  return game.order[(idx + game.direction + game.order.length) % game.order.length];
}

function sendState(lobbyId) {
  const game = lobbies[lobbyId];
  if (!game) return;
  io.to(lobbyId).emit("state", {
    players: Object.values(game.players),
    hands: game.hands,
    discardPile: game.discardPile,
    currentTurn: game.currentTurn
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
