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
  return shuffle([...deck, ...deck]); // double deck
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
        deck: createDeck(),
        discardPile: [],
        direction: 1,
        currentTurn: null,
        happyActive: false
      };
    }

    const lobbyObj = lobbies[lobby];
    lobbyObj.players[socket.id] = { id: socket.id, name, score: 0 };
    lobbyObj.order.push(socket.id);
    lobbyObj.hands[socket.id] = lobbyObj.deck.splice(0, 7);

    socket.join(lobby);
    if (lobbyObj.order.length === 1) {
      lobbyObj.discardPile.push(lobbyObj.deck.pop());
      lobbyObj.currentTurn = socket.id;
    }

    io.to(lobby).emit("chat", { from: "SUE", message: `${name} joined.` });
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

    // Rainbow Special
    if (card === "wild_rainbow") {
      const colorsInHand = hand.map(c => c.split("_")[0]);
      const requiredColors = ["red", "blue", "green", "yellow"];
      const hasAllColors = requiredColors.every(color => colorsInHand.includes(color));
      if (!hasAllColors) {
        game.hands[socket.id].push(game.deck.pop()); // auto draw
        advanceTurn(game);
        sendState(lobby);
        return;
      }
    }

    // Color matching logic
    if (cardColor !== "wild" && topColor !== cardColor && !topCard.startsWith(cardColor)) return;

    game.discardPile.push(hand.splice(cardIndex, 1)[0]);

    // Execute special card logic if applicable
    if (specialCardLogic[card]) {
      specialCardLogic[card](game, socket.id, io);
    }

    // Rainbow play post-discard
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
      if (lastCard.includes("draw")) {
        const next = getNextPlayer(game);
        game.hands[next].push(...game.deck.splice(0, 2));
      } else if (lastCard.includes("skip")) {
        advanceTurn(game); // skip
      } else if (lastCard.includes("reverse")) {
        if (game.order.length === 2) {
          advanceTurn(game); // treat reverse as skip
        } else {
          game.direction *= -1;
        }
      }

      const newColor = lastCard.split("_")[0];
      game.lastColor = newColor;
    }

    // Win check
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
    for (const lobby of Object.values(lobbies)) {
      if (lobby.players[socket.id]) {
        delete lobby.players[socket.id];
        delete lobby.hands[socket.id];
        lobby.order = lobby.order.filter(id => id !== socket.id);
        if (lobby.order.length === 0) {
          delete lobbies[lobby.id];
        } else {
          advanceTurn(lobby);
          sendState(lobby.id);
        }
        break;
      }
    }
  });
});

function advanceTurn(game) {
  const idx = game.order.indexOf(game.currentTurn);
  const nextIdx = (idx + game.direction + game.order.length) % game.order.length;
  game.currentTurn = game.order[nextIdx];
}

function getNextPlayer(game) {
  const idx = game.order.indexOf(game.currentTurn);
  return game.order[(idx + game.direction + game.order.length) % game.order.length];
}

function resetGame(game) {
  game.deck = createDeck();
  game.discardPile = [game.deck.pop()];
  game.hands = {};
  game.order.forEach(id => {
    game.hands[id] = game.deck.splice(0, 7);
  });
  game.currentTurn = game.order[0];
}

function sendState(lobbyId) {
  const lobby = lobbies[lobbyId];
  io.to(lobbyId).emit("state", {
    players: Object.values(lobby.players),
    hands: lobby.hands,
    discardPile: lobby.discardPile,
    currentTurn: lobby.currentTurn
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
