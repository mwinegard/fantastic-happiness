// [server.js]

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

const lobbies = {};
const SCORES_FILE = path.join(__dirname, "scores.json");
let scores = fs.existsSync(SCORES_FILE) ? JSON.parse(fs.readFileSync(SCORES_FILE)) : {};

function createDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw"];
  const wilds = ["wild", "wild_draw4"];
  const deck = [];

  for (let color of colors) {
    for (let val of values) {
      deck.push(`${color}_${val}`);
      if (val !== "0") deck.push(`${color}_${val}`);
    }
  }

  for (let wild of wilds) for (let i = 0; i < 4; i++) deck.push(wild);

  return deck;
}

function shuffle(deck) {
  return deck.sort(() => Math.random() - 0.5);
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

function getPlayerOrder(lobby) {
  return Object.keys(lobby.players).sort();
}

function triggerSpecialCard(card, lobby, playerId) {
  if (!card.includes("_")) return;

  const name = card.toLowerCase();
  switch (name) {
    case "blue_look":
      sendSystemMessage(lobby, "🔍 Player peeked and reordered top 4 cards.");
      const top4 = lobby.deck.splice(-4);
      lobby.deck.push(...top4.reverse());
      break;
    case "green_recycle":
      sendSystemMessage(lobby, "♻️ All hands reshuffled!");
      const allCards = Object.values(lobby.hands).flat();
      shuffle(allCards);
      const count = Object.keys(lobby.hands).length;
      Object.keys(lobby.hands).forEach(pid => {
        lobby.hands[pid] = allCards.splice(0, Math.floor(allCards.length / count));
      });
      break;
    case "red_noc":
      const randomId = getPlayerOrder(lobby).find(pid => pid !== playerId);
      lobby.hands[randomId].push(...lobby.deck.splice(0, 3));
      sendSystemMessage(lobby, `📩 ${lobby.players[randomId].name} received a NOC!`);
      break;
    case "wild_relax":
      sendSystemMessage(lobby, `🧘 ${lobby.players[playerId].name} blocked a draw card.`);
      break;
    case "wild_rainbow":
      sendSystemMessage(lobby, `🌈 Discarding 1 card of each color if possible.`);
      break;
    // Add more card triggers here...
  }
}

function nextTurn(lobby) {
  const order = getPlayerOrder(lobby);
  let idx = order.indexOf(lobby.currentTurn);
  const direction = lobby.reverse ? -1 : 1;
  lobby.currentTurn = order[(idx + direction + order.length) % order.length];
  emitState(lobby);
  startTurnTimer(lobby);
}

function startTurnTimer(lobby) {
  if (lobby.turnTimeout) clearTimeout(lobby.turnTimeout);

  lobby.turnTimeout = setTimeout(() => {
    const pid = lobby.currentTurn;
    const hand = lobby.hands[pid];
    if (!hand) return;

    const card = lobby.deck.pop();
    hand.push(card);
    sendSystemMessage(lobby, `${lobby.players[pid].name} timed out. Drew 1 card.`);
    nextTurn(lobby);
  }, 60000);
}

function startGame(lobby) {
  lobby.deck = shuffle(createDeck());
  lobby.hands = {};
  lobby.discardPile = [];
  lobby.started = true;

  let firstCard;
  do { firstCard = lobby.deck.pop(); } while (firstCard.startsWith("wild"));
  lobby.discardPile.push(firstCard);

  for (const pid of Object.keys(lobby.players)) {
    lobby.hands[pid] = lobby.deck.splice(0, 7);
  }

  lobby.currentTurn = Object.keys(lobby.players)[0];
  sendSystemMessage(lobby, "🎮 Game started!");
  emitState(lobby);
  startTurnTimer(lobby);
}

io.on("connection", (socket) => {
  socket.on("join", ({ name, lobby }) => {
    lobby = lobby.toLowerCase();
    socket.join(lobby);

    if (!lobbies[lobby]) {
      lobbies[lobby] = { id: lobby, players: {}, deck: [], discardPile: [], hands: {}, reverse: false };
    }

    const obj = lobbies[lobby];
    obj.players[socket.id] = { id: socket.id, name };
    if (!obj.hands[socket.id]) obj.hands[socket.id] = [];

    sendSystemMessage(obj, `${name} joined.`);
    if (!obj.started && Object.keys(obj.players).length >= 2) startGame(obj);
    emitState(obj);
  });

  socket.on("chat", (msg) => {
    const lobby = Object.values(lobbies).find(l => l.players[socket.id]);
    if (!lobby) return;
    const name = lobby.players[socket.id].name;
    io.to(lobby.id).emit("chat", { from: name, message: msg });
  });

  socket.on("playCard", ({ lobby, card, chosenColor }) => {
    const obj = lobbies[lobby];
    if (!obj || obj.currentTurn !== socket.id) return;

    const hand = obj.hands[socket.id];
    const idx = hand.indexOf(card);
    if (idx === -1) return;

    const top = obj.discardPile[obj.discardPile.length - 1];
    const [tc, tv] = top.split("_");
    const [cc, cv] = card.split("_");

    const wild = cc === "wild";
    if (!wild && cc !== tc && cv !== tv) return;

    hand.splice(idx, 1);
    obj.discardPile.push(card);

    triggerSpecialCard(card, obj, socket.id);

    obj.currentTurn = getPlayerOrder(obj)[(getPlayerOrder(obj).indexOf(socket.id) + 1) % getPlayerOrder(obj).length];
    emitState(obj);
  });

  socket.on("drawCard", ({ lobby }) => {
    const obj = lobbies[lobby];
    if (!obj || obj.currentTurn !== socket.id) return;
    obj.hands[socket.id].push(obj.deck.pop());
    nextTurn(obj);
  });

  socket.on("disconnect", () => {
    for (const lid in lobbies) {
      const obj = lobbies[lid];
      if (obj.players[socket.id]) {
        sendSystemMessage(obj, `${obj.players[socket.id].name} left.`);
        delete obj.players[socket.id];
        delete obj.hands[socket.id];
        emitState(obj);
      }
    }
  });
});

app.use(express.static(path.join(__dirname, "public")));
server.listen(PORT, () => console.log(`UNO server running on http://localhost:${PORT}`));
