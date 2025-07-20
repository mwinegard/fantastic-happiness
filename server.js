// a. server.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const lobbies = {};
let scores = {};

const SCORES_FILE = path.join(__dirname, "scores.json");
if (fs.existsSync(SCORES_FILE)) {
  scores = JSON.parse(fs.readFileSync(SCORES_FILE));
}

function createDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw"];
  const wilds = ["wild", "wild_draw4"];
  const specials = [
    "blue_look", "blue_moon",
    "green_happy", "green_recycle",
    "red_it", "red_noc",
    "yellow_pinkypromise", "yellow_shopping",
    "wild_boss", "wild_packyourbags", "wild_rainbow", "wild_relax"
  ];

  let deck = [];
  for (let color of colors) {
    for (let val of values) {
      deck.push(`${color}_${val}`);
      if (val !== "0") deck.push(`${color}_${val}`);
    }
  }
  for (let w of wilds) for (let i = 0; i < 4; i++) deck.push(w);
  for (let s of specials) deck.push(s);

  return deck.sort(() => Math.random() - 0.5);
}

function emitState(lobby) {
  const state = {
    players: Object.values(lobby.players).map(p => ({
      id: p.id,
      name: p.name,
      score: scores[p.name]?.score || 0,
      handSize: lobby.hands[p.id]?.length || 0
    })),
    hands: lobby.hands,
    discardPile: lobby.discardPile,
    currentTurn: lobby.currentTurn
  };
  io.to(lobby.id).emit("state", state);
}

function nextTurn(lobby) {
  const ids = Object.keys(lobby.players);
  const currentIdx = ids.indexOf(lobby.currentTurn);
  lobby.currentTurn = ids[(currentIdx + 1) % ids.length];
  emitState(lobby);
}

function handleSpecialCard(card, lobby, playerId) {
  let msg = "";
  switch (card) {
    case "green_happy":
      msg = `🟢 ${lobby.players[playerId].name} played Happy! Rude button enabled.`;
      break;
    case "red_noc":
      const victim = Object.keys(lobby.players)[Math.floor(Math.random() * Object.keys(lobby.players).length)];
      lobby.hands[victim].push(...lobby.deck.splice(0, 3));
      msg = `🔴 ${lobby.players[playerId].name} played NOC! ${lobby.players[victim].name} draws 3.`;
      break;
    case "wild_relax":
      msg = `🌈 ${lobby.players[playerId].name} played Relax! Blocks any draw.`;
      break;
    default:
      msg = `${card} effect activated.`;
  }
  io.to(lobby.id).emit("chat", { from: "SUE", message: msg });
}

io.on("connection", (socket) => {
  socket.on("join", ({ name, lobby }) => {
    if (!name || !lobby) return;
    lobby = lobby.toLowerCase();
    socket.join(lobby);

    if (!lobbies[lobby]) {
      lobbies[lobby] = { id: lobby, players: {}, deck: [], discardPile: [], hands: {} };
    }

    const l = lobbies[lobby];
    l.players[socket.id] = { id: socket.id, name };
    l.hands[socket.id] = l.deck.splice(0, 7);
    if (!l.discardPile.length) l.discardPile.push(l.deck.pop());
    l.currentTurn ||= socket.id;
    emitState(l);
  });

  socket.on("playCard", ({ lobby, card, chosenColor }) => {
    const l = lobbies[lobby];
    if (!l) return;
    const pid = socket.id;
    const hand = l.hands[pid];
    if (!hand || l.currentTurn !== pid) return;

    const cardIndex = hand.indexOf(card);
    if (cardIndex === -1) return;
    hand.splice(cardIndex, 1);
    l.discardPile.push(card);

    if (card.startsWith("wild")) {
      l.wildColor = chosenColor;
      io.to(l.id).emit("chat", { from: "SUE", message: `🌈 Wild color chosen: <b style='color:${chosenColor}'>${chosenColor}</b>` });
    }

    if (card.includes("happy") || card.includes("noc") || card.includes("relax")) {
      handleSpecialCard(card, l, pid);
    }

    if (hand.length === 0) {
      io.to(l.id).emit("chat", { from: "SUE", message: `🎉 ${l.players[pid].name} wins the round!` });
      return;
    }

    nextTurn(l);
  });

  socket.on("drawCard", ({ lobby }) => {
    const l = lobbies[lobby];
    if (!l) return;
    const pid = socket.id;
    if (pid !== l.currentTurn) return;
    l.hands[pid].push(l.deck.pop());
    nextTurn(l);
  });
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`UNO server on http://localhost:${PORT}`));
