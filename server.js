// server.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");

app.use(express.static(publicDir));

let lobbies = {};
let scores = {};

// Load scores if file exists
const scoresPath = path.join(__dirname, "scores.json");
if (fs.existsSync(scoresPath)) {
  scores = JSON.parse(fs.readFileSync(scoresPath));
}

// Helper functions
function createDeck() {
  const colors = ["red", "green", "blue", "yellow"];
  const specials = ["draw", "skip", "reverse"];
  const deck = [];

  colors.forEach(color => {
    deck.push(`${color}_0`);
    for (let i = 1; i <= 9; i++) {
      deck.push(`${color}_${i}`, `${color}_${i}`);
    }
    specials.forEach(s => {
      deck.push(`${color}_${s}`, `${color}_${s}`);
    });
  });

  const wilds = ["wild", "wild_draw4"];
  wilds.forEach(w => {
    for (let i = 0; i < 4; i++) deck.push(w);
  });

  const extraWilds = [
    "wild_boss", "wild_packyourbags", "wild_rainbow", "wild_relax"
  ];
  const extras = [
    "blue_look", "blue_moon",
    "green_happy", "green_recycle",
    "red_it", "red_noc",
    "yellow_pinkypromise", "yellow_shopping"
  ];

  return [...deck, ...extraWilds, ...extras].sort(() => Math.random() - 0.5);
}

function nextTurn(lobby) {
  const ids = Object.keys(lobby.players);
  if (ids.length < 2) return;

  if (lobby.direction === 1) {
    lobby.turnIndex = (lobby.turnIndex + 1) % ids.length;
  } else {
    lobby.turnIndex = (lobby.turnIndex - 1 + ids.length) % ids.length;
  }

  lobby.currentTurn = ids[lobby.turnIndex];
}

function isPlayable(card, topCard) {
  const [aColor, aVal] = card.split("_");
  const [bColor, bVal] = topCard.split("_");

  return (
    aColor === bColor ||
    aVal === bVal ||
    aColor === "wild" ||
    card.startsWith("wild_")
  );
}

const { specialCardLogic } = require("./public/specialCards.js");

io.on("connection", socket => {
  socket.on("join", ({ name, lobby }) => {
    if (!lobbies[lobby]) {
      lobbies[lobby] = {
        id: lobby,
        players: {},
        hands: {},
        deck: createDeck(),
        discardPile: [],
        currentTurn: null,
        turnIndex: 0,
        direction: 1,
        happyActive: false
      };
    }

    const l = lobbies[lobby];
    l.players[socket.id] = { id: socket.id, name, score: 0 };
    l.hands[socket.id] = [];

    // Deal 7 cards
    for (let i = 0; i < 7; i++) {
      l.hands[socket.id].push(l.deck.pop());
    }

    // Start game if first player
    if (!l.currentTurn) {
      l.currentTurn = socket.id;
      l.turnIndex = 0;
      l.discardPile.push(l.deck.pop());
    }

    io.to(lobby).emit("chat", {
      from: "SUE",
      message: `${name} joined lobby ${lobby}`
    });

    socket.join(lobby);
    updateState(lobby);
  });

  socket.on("playCard", ({ lobby, card, chosenColor }) => {
    const l = lobbies[lobby];
    if (!l || l.currentTurn !== socket.id) return;

    const hand = l.hands[socket.id];
    const topCard = l.discardPile[l.discardPile.length - 1];
    const cardIndex = hand.indexOf(card);

    if (cardIndex === -1 || !isPlayable(card, topCard)) return;

    hand.splice(cardIndex, 1);
    l.discardPile.push(card);

    if (card.startsWith("wild")) {
      if (!chosenColor) return;
      l.discardPile.push(`${chosenColor}_wild`);
    }

    // Special card logic
    if (specialCardLogic[card]) {
      specialCardLogic[card](l, socket.id, io);
    }

    // Win check
    if (hand.length === 0) {
      io.to(lobby).emit("chat", {
        from: "SUE",
        message: `🎉 ${l.players[socket.id].name} wins this round!`
      });
      l.players[socket.id].score += 1;
      l.deck = createDeck();
      for (const pid in l.players) {
        l.hands[pid] = [];
        for (let i = 0; i < 7; i++) l.hands[pid].push(l.deck.pop());
      }
      l.discardPile = [l.deck.pop()];
      l.turnIndex = 0;
      l.currentTurn = Object.keys(l.players)[0];
      saveScores();
      updateState(lobby);
      return;
    }

    // Reverse skip logic
    if (card.includes("reverse") && Object.keys(l.players).length === 2) {
      nextTurn(l);
    } else if (card.includes("reverse")) {
      l.direction *= -1;
    } else if (card.includes("skip")) {
      nextTurn(l);
    }

    nextTurn(l);
    updateState(lobby);
  });

  socket.on("drawCard", ({ lobby }) => {
    const l = lobbies[lobby];
    if (!l || l.currentTurn !== socket.id) return;

    l.hands[socket.id].push(l.deck.pop());
    nextTurn(l);
    updateState(lobby);
  });

  socket.on("chat", ({ message }) => {
    const playerLobby = Object.values(lobbies).find(l =>
      l.players[socket.id]
    );
    if (playerLobby) {
      const name = playerLobby.players[socket.id].name;
      io.to(playerLobby.id).emit("chat", { from: name, message });
    }
  });

  socket.on("disconnect", () => {
    for (const lobby in lobbies) {
      const l = lobbies[lobby];
      if (l.players[socket.id]) {
        delete l.players[socket.id];
        delete l.hands[socket.id];
        if (l.currentTurn === socket.id) nextTurn(l);
        io.to(lobby).emit("chat", {
          from: "SUE",
          message: `${socket.id} left the game`
        });
        updateState(lobby);
      }
    }
  });
});

function updateState(lobby) {
  const l = lobbies[lobby];
  const state = {
    players: Object.values(l.players),
    hands: l.hands,
    discardPile: l.discardPile,
    currentTurn: l.currentTurn
  };
  io.to(lobby).emit("state", state);
}

function saveScores() {
  fs.writeFileSync(scoresPath, JSON.stringify(scores, null, 2));
}

server.listen(PORT, () => {
  console.log(`UNO server running at http://localhost:${PORT}`);
});
