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
        started: false,
        startCountdown: null,
        happyActive: false
      };
    }

    const lobbyObj = lobbies[lobby];

    if (Object.keys(lobbyObj.players).length >= 10) {
      socket.emit("chat", { from: "SUE", message: `❌ Lobby full. Max 10 players.` });
      return;
    }

    lobbyObj.players[socket.id] = { id: socket.id, name, score: 0 };
    lobbyObj.order.push(socket.id);
    socket.join(lobby);

    io.to(lobby).emit("chat", { from: "SUE", message: `${name} joined.` });

    if (!lobbyObj.started && Object.keys(lobbyObj.players).length >= 2 && !lobbyObj.startCountdown) {
      lobbyObj.startCountdown = setTimeout(() => {
        if (Object.keys(lobbyObj.players).length >= 2) {
          startGame(lobbyObj);
        }
      }, 30000);

      io.to(lobby).emit("chat", {
        from: "SUE",
        message: `🕒 Game will start in 30 seconds...`
      });
    }

    sendState(lobby);
  });

  socket.on("playCard", ({ lobby, card, chosenColor }) => {
    const game = lobbies[lobby];
    if (!game || game.currentTurn !== socket.id) return;

    const hand = game.hands[socket.id];
    if (!hand.includes(card)) return;

    const topCard = game.discardPile[game.discardPile.length - 1];
    const topColor = topCard.split("_")[0];
    const cardColor = card.split("_")[0];

    if (card === "wild_rainbow") {
      const colorsInHand = hand.map(c => c.split("_")[0]);
      const required = ["red", "blue", "green", "yellow"];
      const hasAll = required.every(color => colorsInHand.includes(color));

      if (!hasAll) {
        game.hands[socket.id].push(game.deck.pop());
        advanceTurn(game);
        sendState(lobby);
        return;
      }
    }

    if (cardColor !== "wild" && cardColor !== topColor && !topCard.startsWith(cardColor)) return;

    hand.splice(hand.indexOf(card), 1);
    game.discardPile.push(card);

    if (specialCardLogic[card]) {
      specialCardLogic[card](game, socket.id, io);
    }

    if (card === "wild_rainbow") {
      const required = ["red", "blue", "green", "yellow"];
      const discards = [];
      required.forEach(color => {
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
        if (game.order.length === 2) {
          advanceTurn(game);
        } else {
          game.direction *= -1;
        }
      }

      const newColor = lastCard?.split("_")[0];
      game.lastColor = newColor;
    }

    if (hand.length === 0) {
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

        if (lobby.order.length < 2 && lobby.startCountdown) {
          clearTimeout(lobby.startCountdown);
          lobby.startCountdown = null;
          io.to(lobby.id).emit("chat", {
            from: "SUE",
            message: `⚠️ Countdown canceled. Not enough players.`
          });
        }

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

function startGame(lobby) {
  lobby.started = true;
  lobby.startCountdown = null;
  lobby.deck = createDeck();
  lobby.discardPile = [];

  let firstCard;
  do {
    firstCard = lobby.deck.pop();
  } while (firstCard.startsWith("wild") || specialCardLogic[firstCard]);
  lobby.discardPile.push(firstCard);

  lobby.hands = {};
  lobby.order.forEach(pid => {
    lobby.hands[pid] = lobby.deck.splice(0, 7);
  });

  lobby.currentTurn = lobby.order[0];

  io.to(lobby.id).emit("chat", {
    from: "SUE",
    message: `🎮 Game started! First card is ${firstCard.toUpperCase().replace("_", " ")}`
  });

  sendState(lobby.id);
}

function resetGame(game) {
  game.started = false;
  game.startCountdown = null;

  if (game.order.length >= 2) {
    game.startCountdown = setTimeout(() => {
      if (game.order.length >= 2) {
        startGame(game);
      }
    }, 30000);

    io.to(game.id).emit("chat", {
      from: "SUE",
      message: `🔁 Next round starts in 30 seconds...`
    });
  } else {
    io.to(game.id).emit("chat", {
      from: "SUE",
      message: `⏳ Waiting for more players to start again.`
    });
  }
}

function advanceTurn(game) {
  const idx = game.order.indexOf(game.currentTurn);
  game.currentTurn = game.order[(idx + game.direction + game.order.length) % game.order.length];
}

function getNextPlayer(game) {
  const idx = game.order.indexOf(game.currentTurn);
  return game.order[(idx + game.direction + game.order.length) % game.order.length];
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
  console.log(`🚀 Server running on port ${PORT}`);
});
