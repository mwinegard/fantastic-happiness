const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const fs = require("fs");

const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

let scores = {};
let players = [];
let game = null;
let countdownTimer = null;
let turnTimer = null;
let isReversed = false;

try {
  scores = JSON.parse(fs.readFileSync("scores.json", "utf8"));
} catch {
  scores = {};
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function generateDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  const deck = [];

  colors.forEach(color => {
    for (let i = 0; i <= 9; i++) {
      deck.push(`${color}_${i}`);
      if (i !== 0) deck.push(`${color}_${i}`);
    }
    ["skip", "reverse", "draw2"].forEach(action => {
      deck.push(`${color}_${action}`, `${color}_${action}`);
    });
  });

  for (let i = 0; i < 4; i++) {
    deck.push("wild", "wild_draw4");
  }

  deck.push("wild_boss", "green_recycle");
  shuffle(deck);
  return deck;
}

function emitGameState() {
  if (!game) return;
  io.emit("state", {
    players: players.map(p => ({
      id: p.id,
      name: p.name,
      handSize: game.hands[p.id] ? game.hands[p.id].length : 0,
      score: scores[p.name]?.points || 0,
      isSpectator: p.spectator
    })),
    discardTop: game.discardPile.at(-1),
    turn: game.turn,
    deckSize: game.deck.length
  });
}

function startTurnTimer() {
  clearTimeout(turnTimer);
  turnTimer = setTimeout(() => {
    const current = players.find(p => p.id === game.turn);
    if (!current) return;
    const hand = game.hands[game.turn];
    const drawn = game.deck.pop();
    hand.push(drawn);
    io.to(game.turn).emit("chat", { from: "SUE", message: `⏳ You took too long. Drew 1 card.` });
    advanceTurn();
  }, 60000);
}

function broadcastSound(name) {
  io.emit("sound", name);
}

function announce(msg) {
  io.emit("chat", { from: "SUE", message: msg });
}

function advanceTurn(skip = 1) {
  const activePlayers = players.filter(p => !p.spectator);
  const idx = activePlayers.findIndex(p => p.id === game.turn);
  const direction = isReversed ? -1 : 1;
  let nextIdx = (idx + (skip * direction) + activePlayers.length) % activePlayers.length;
  game.turn = activePlayers[nextIdx].id;
  announce(`🎮 It's ${activePlayers[nextIdx].name}'s turn.`);
  emitGameState();
  startTurnTimer();
}

function updateScores(winnerId) {
  const winner = players.find(p => p.id === winnerId);
  if (!winner) return;
  scores[winner.name] = scores[winner.name] || { wins: 0, points: 0 };
  scores[winner.name].wins += 1;

  let points = 0;
  Object.entries(game.hands).forEach(([pid, hand]) => {
    if (pid !== winnerId) {
      hand.forEach(card => {
        if (card.includes("wild")) points += 50;
        else if (card.includes("draw") || card.includes("reverse") || card.includes("skip")) points += 20;
        else points += 10;
      });
    }
  });
  scores[winner.name].points += points;
  fs.writeFileSync("scores.json", JSON.stringify(scores, null, 2));
}

function startGame() {
  game = {
    deck: generateDeck(),
    discardPile: [],
    hands: {},
    turn: null
  };

  const active = players.filter(p => !p.spectator);
  active.forEach(p => {
    game.hands[p.id] = [];
    for (let i = 0; i < 7; i++) game.hands[p.id].push(game.deck.pop());
  });

  game.discardPile.push(game.deck.pop());
  game.turn = active[0].id;
  isReversed = false;
  announce("🃏 Game started!");
  broadcastSound("start");
  emitGameState();
  startTurnTimer();
}

function checkUno(id) {
  if (game && game.hands[id]?.length === 1) {
    broadcastSound("uno");
    announce(`🔔 ${players.find(p => p.id === id)?.name} calls UNO!`);
  } else {
    const hand = game.hands[id];
    for (let i = 0; i < 2; i++) hand.push(game.deck.pop());
    announce(`❌ UNO failed. Penalty: 2 cards.`);
  }
  emitGameState();
}

io.on("connection", socket => {
  socket.on("join", ({ name }) => {
    if (players.some(p => p.name === name)) {
      socket.emit("joinDenied", "Name already taken.");
      return;
    }

    const spectator = players.length >= 10;
    players.push({ id: socket.id, name, spectator });
    socket.emit("joined", { id: socket.id, name });
    announce(`👤 ${name} joined.`);
    broadcastSound("joined");

    if (!game && players.length >= 2 && players.length <= 10) {
      countdownTimer = setTimeout(() => startGame(), 30000);
      announce("⏳ Game will begin in 30 seconds...");
    }

    if (game && !spectator) {
      game.hands[socket.id] = [];
      for (let i = 0; i < 7; i++) game.hands[socket.id].push(game.deck.pop());
      announce(`🆕 ${name} joined late and was dealt a hand.`);
    }

    emitGameState();
  });

  socket.on("playCard", ({ card, chosenColor }) => {
    if (!game || socket.id !== game.turn) return;
    const hand = game.hands[socket.id];
    const index = hand.indexOf(card);
    if (index === -1) return;

    hand.splice(index, 1);

    if (card.includes("reverse")) {
      isReversed = !isReversed;
      broadcastSound("reverse");
      announce("🔄 Turn order reversed!");
    }

    if (card.includes("wild")) {
      if (chosenColor) {
        game.discardPile.push(`${chosenColor}_${card}`);
      } else {
        game.discardPile.push(card);
      }
    } else {
      game.discardPile.push(card);
    }

    if (hand.length === 0) {
      announce(`🏆 ${players.find(p => p.id === socket.id)?.name} wins the round!`);
      updateScores(socket.id);
      game = null;
      emitGameState();
      return;
    }

    emitGameState();
    advanceTurn(card.includes("skip") ? 2 : 1);
  });

  socket.on("drawCard", () => {
    if (!game || socket.id !== game.turn) return;
    const drawn = game.deck.pop();
    game.hands[socket.id].push(drawn);
    advanceTurn();
  });

  socket.on("callUno", () => {
    checkUno(socket.id);
  });

  socket.on("chooseColor", ({ color }) => {
    const last = game.discardPile.at(-1);
    if (last && last.includes("wild")) {
      game.discardPile[game.discardPile.length - 1] = `${color}_${last}`;
      emitGameState();
    }
  });

  socket.on("disconnect", () => {
    players = players.filter(p => p.id !== socket.id);
    if (players.length <= 1) {
      game = null;
      announce("❗ Game ended. Not enough players.");
    }
    emitGameState();
  });
});

http.listen(PORT, () => console.log("Server running on port", PORT));
