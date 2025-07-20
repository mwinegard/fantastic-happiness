// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, "public")));

const lobbies = {};
let scores = {};
const SCORES_FILE = path.join(__dirname, "scores.json");
if (fs.existsSync(SCORES_FILE)) {
  scores = JSON.parse(fs.readFileSync(SCORES_FILE));
}

const specialCards = [
  "blue_look", "blue_moon",
  "green_happy", "green_recycle",
  "red_it", "red_noc",
  "yellow_pinkypromise", "yellow_shopping",
  "wild_boss", "wild_packyourbags", "wild_rainbow", "wild_relax"
];

function createDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw2"];
  const wilds = ["wild", "wild_draw4"];
  const deck = [];

  for (let color of colors) {
    for (let val of values) {
      deck.push(`${color}_${val}`);
      if (val !== "0") deck.push(`${color}_${val}`);
    }
  }

  for (let w of wilds) for (let i = 0; i < 4; i++) deck.push(w);
  specialCards.forEach(c => deck.push(c)); // add specials
  return deck;
}

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

function getPlayerOrder(lobby) {
  return Object.keys(lobby.players);
}

function saveScores() {
  fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2));
}

function sendSystemMessage(lobby, msg) {
  io.to(lobby.id).emit("chat", { from: "SUE", message: msg });
}

function emitState(lobby) {
  const state = {
    players: Object.values(lobby.players).map(p => ({
      id: p.id,
      name: p.name,
      score: scores[p.name]?.score || 0,
      handSize: lobby.hands?.[p.id]?.length || 0
    })),
    hands: lobby.hands,
    discardPile: lobby.discardPile,
    currentTurn: lobby.currentTurn
  };
  io.to(lobby.id).emit("state", state);
}

function startTurnTimer(lobby) {
  if (lobby.turnTimeout) clearTimeout(lobby.turnTimeout);
  lobby.turnTimeout = setTimeout(() => {
    const pid = lobby.currentTurn;
    const hand = lobby.hands[pid];
    if (!hand) return;

    const card = lobby.deck.pop();
    hand.push(card);
    sendSystemMessage(lobby, `${lobby.players[pid].name} took too long. Auto-draw.`);

    nextTurn(lobby);
  }, 60000);
}

function nextTurn(lobby) {
  const ids = getPlayerOrder(lobby);
  const currentIdx = ids.indexOf(lobby.currentTurn);
  lobby.currentTurn = ids[(currentIdx + (lobby.direction || 1) + ids.length) % ids.length];
  lobby.turnStart = Date.now();
  emitState(lobby);
  startTurnTimer(lobby);
}

function handleSpecialCard(lobby, card, playerId) {
  const name = lobby.players[playerId].name;
  if (card === "green_happy") {
    io.to(lobby.id).emit("specialTrigger", { type: "happy", playerId });
    sendSystemMessage(lobby, `🌟 ${name} played Happy: Be nice or draw a card!`);
  } else if (card === "red_noc") {
    const others = Object.keys(lobby.players).filter(id => id !== playerId);
    const victim = others[Math.floor(Math.random() * others.length)];
    lobby.hands[victim].push(...lobby.deck.splice(0, 3));
    sendSystemMessage(lobby, `📄 ${name} played NOC Notice! ${lobby.players[victim].name} draws 3!`);
  } else if (card === "wild_relax") {
    lobby.wildColor = null;
    sendSystemMessage(lobby, `💆 ${name} played Relax: Skipping draw effect!`);
  } else {
    sendSystemMessage(lobby, `✨ ${name} played special: ${card.replace(/_/g, " ")}`);
  }
  io.to(lobby.id).emit("playSound", "special");
}

function startGame(lobby) {
  if (Object.keys(lobby.players).length < 2) return;

  lobby.deck = shuffle(createDeck());
  lobby.hands = {};
  lobby.discardPile = [];

  let card;
  do { card = lobby.deck.pop(); } while (card.startsWith("wild"));
  lobby.discardPile.push(card);

  for (const pid of Object.keys(lobby.players)) {
    lobby.hands[pid] = lobby.deck.splice(0, 7);
  }

  lobby.turnMissed = {};
  lobby.direction = 1;
  lobby.currentTurn = Object.keys(lobby.players)[0];

  sendSystemMessage(lobby, `Game started!`);
  emitState(lobby);
  startTurnTimer(lobby);
}

io.on("connection", (socket) => {
  socket.on("join", ({ name, lobby }) => {
    if (!name || !lobby) return;

    lobby = lobby.toLowerCase();
    socket.join(lobby);

    if (!lobbies[lobby]) {
      lobbies[lobby] = {
        id: lobby,
        players: {},
        deck: [],
        discardPile: [],
        direction: 1,
        hands: {}
      };
    }

    const lobbyObj = lobbies[lobby];
    lobbyObj.players[socket.id] = { id: socket.id, name };
    if (!lobbyObj.hands[socket.id]) {
      lobbyObj.hands[socket.id] = [];
    }

    sendSystemMessage(lobbyObj, `${name} joined.`);
    if (Object.keys(lobbyObj.players).length >= 2 && !lobbyObj.started) {
      lobbyObj.started = true;
      setTimeout(() => startGame(lobbyObj), 30000);
    }

    emitState(lobbyObj);
  });

  socket.on("playCard", ({ lobby, card, chosenColor }) => {
    const lobbyObj = lobbies[lobby];
    if (!lobbyObj) return;
    const pid = socket.id;
    const hand = lobbyObj.hands[pid];
    if (!hand || lobbyObj.currentTurn !== pid) return;

    const index = hand.indexOf(card);
    if (index === -1) return;

    const topCard = lobbyObj.discardPile.at(-1);
    const [topColor, topValue] = topCard?.split("_") || [];
    const [cardColor, cardValue] = card.includes("_") ? card.split("_") : [null, card];
    const isWild = card.startsWith("wild");
    const isSpecial = specialCards.includes(card);
    const isValid =
      isWild || cardColor === topColor || cardValue === topValue || card === lobbyObj.wildColor;

    if (!isValid) return;

    hand.splice(index, 1);
    lobbyObj.discardPile.push(card);

    if (isWild) {
      if (!chosenColor || !["red", "blue", "green", "yellow"].includes(chosenColor)) return;
      lobbyObj.wildColor = chosenColor;
      io.to(lobby).emit("chat", { from: "SUE", message: `🎨 Wild color chosen: ${chosenColor}` });
    } else {
      lobbyObj.wildColor = null;
    }

    if (isSpecial) {
      handleSpecialCard(lobbyObj, card, pid);
    }

    if (hand.length === 0) {
      sendSystemMessage(lobbyObj, `🎉 ${lobbyObj.players[pid].name} wins!`);
      scores[lobbyObj.players[pid].name] = scores[lobbyObj.players[pid].name] || { score: 0, wins: 0 };
      scores[lobbyObj.players[pid].name].wins += 1;
      saveScores();
      delete lobbies[lobby];
      return;
    }

    nextTurn(lobbyObj);
  });

  socket.on("drawCard", ({ lobby }) => {
    const lobbyObj = lobbies[lobby];
    if (!lobbyObj) return;
    const pid = socket.id;
    if (pid !== lobbyObj.currentTurn) return;
    const card = lobbyObj.deck.pop();
    lobbyObj.hands[pid].push(card);
    nextTurn(lobbyObj);
  });

  socket.on("chat", (msg) => {
    const lobby = Object.values(lobbies).find(l => l.players[socket.id]);
    if (!lobby) return;
    const name = lobby.players[socket.id].name;
    io.to(lobby.id).emit("chat", { from: name, message: msg });
  });

  socket.on("disconnect", () => {
    for (let lobbyId in lobbies) {
      const lobby = lobbies[lobbyId];
      if (lobby.players[socket.id]) {
        sendSystemMessage(lobby, `${lobby.players[socket.id].name} left.`);
        delete lobby.players[socket.id];
        delete lobby.hands[socket.id];
        if (Object.keys(lobby.players).length < 2) {
          delete lobbies[lobbyId];
        } else {
          emitState(lobby);
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO server running on http://localhost:${PORT}`);
});
