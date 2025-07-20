// /server.js

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

function saveScores() {
  fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2));
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

  const deck = [];
  for (let color of colors) {
    for (let val of values) {
      deck.push(`${color}_${val}`);
      if (val !== "0") deck.push(`${color}_${val}`);
    }
  }

  for (let w of wilds) {
    for (let i = 0; i < 4; i++) deck.push(w);
  }

  for (let s of specials) {
    deck.push(s);
  }

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

function sendSystemMessage(lobby, msg) {
  io.to(lobby.id).emit("chat", { from: "SUE", message: msg });
}

function calculateScore(hand) {
  return hand.reduce((total, card) => {
    if (card.includes("wild")) return total + 50;
    if (card.includes("skip") || card.includes("reverse") || card.includes("draw")) return total + 20;
    return total + parseInt(card.split("_")[1]) || 0;
  }, 0);
}

function nextTurn(lobby) {
  const ids = Object.keys(lobby.players);
  const currentIdx = ids.indexOf(lobby.currentTurn);
  lobby.currentTurn = ids[(currentIdx + 1) % ids.length];
  emitState(lobby);
}

function endRound(lobby, winnerId) {
  const winnerName = lobby.players[winnerId].name;
  const others = Object.entries(lobby.hands).filter(([pid]) => pid !== winnerId);
  const totalScore = others.reduce((sum, [, hand]) => sum + calculateScore(hand), 0);

  scores[winnerName] = scores[winnerName] || { score: 0, wins: 0 };
  scores[winnerName].score += totalScore;
  scores[winnerName].wins += 1;
  saveScores();

  sendSystemMessage(lobby, `${winnerName} wins the round and earns ${totalScore} points!`);
  delete lobbies[lobby.id];
}

function handleSpecialCard(card, lobby, playerId) {
  const broadcast = (msg) => sendSystemMessage(lobby, msg);
  const hand = lobby.hands[playerId];
  const playerName = lobby.players[playerId].name;
  const otherPlayers = Object.keys(lobby.players).filter(pid => pid !== playerId);

  switch (card) {
    case "green_happy":
      lobby.happyActive = true;
      broadcast(`🌟 ${playerName} played Happy. Watch your words! Players can punish rudeness!`);
      break;

    case "red_noc":
      const target = otherPlayers[Math.floor(Math.random() * otherPlayers.length)];
      if (target) {
        lobby.hands[target].push(...createDeck().slice(0, 3));
        broadcast(`📄 NOC activated! ${lobby.players[target].name} draws 3 cards!`);
      }
      break;

    case "wild_relax":
      // This one should be auto-triggered when draw is about to occur, handled elsewhere.
      broadcast(`😌 Relax played! Draw effect cancelled.`);
      break;

    case "blue_look":
      const topFour = lobby.deck.splice(0, 4);
      lobby.deck.unshift(...topFour);
      broadcast(`🔍 ${playerName} looked at the top 4 cards and reordered them.`);
      break;

    case "green_recycle":
      let allCards = [];
      for (const pid of Object.keys(lobby.players)) {
        allCards = allCards.concat(lobby.hands[pid]);
      }
      const newHands = {};
      const shuffled = allCards.sort(() => Math.random() - 0.5);
      const perPlayer = Math.floor(shuffled.length / Object.keys(lobby.players).length);
      for (const pid of Object.keys(lobby.players)) {
        newHands[pid] = shuffled.splice(0, perPlayer);
      }
      lobby.hands = newHands;
      broadcast(`♻️ Recycle played! Hands shuffled and redistributed!`);
      break;

    // ...handle the rest with similar logic
  }
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
        hands: {},
        deck: [],
        discardPile: []
      };
    }

    const l = lobbies[lobby];
    l.players[socket.id] = { id: socket.id, name };
    l.hands[socket.id] = [];

    sendSystemMessage(l, `${name} joined the lobby.`);
    if (Object.keys(l.players).length >= 2 && !l.started) {
      l.deck = createDeck();
      for (const pid in l.players) {
        l.hands[pid] = l.deck.splice(0, 7);
      }
      let card;
      do {
        card = l.deck.pop();
      } while (card.startsWith("wild"));
      l.discardPile.push(card);
      l.currentTurn = Object.keys(l.players)[0];
      l.started = true;
      sendSystemMessage(l, `Game started!`);
    }

    emitState(l);
  });

  socket.on("playCard", ({ lobby, card, chosenColor }) => {
    const l = lobbies[lobby];
    const pid = socket.id;
    const hand = l.hands[pid];
    if (!hand || l.currentTurn !== pid) return;

    const index = hand.indexOf(card);
    if (index === -1) return;

    const topCard = l.discardPile[l.discardPile.length - 1];
    const [topColor, topValue] = topCard.split("_");
    const [cardColor, cardValue] = card.split("_");

    const isWild = card.startsWith("wild");
    const isValidPlay =
      isWild || cardColor === topColor || cardValue === topValue;

    if (!isValidPlay) return;

    hand.splice(index, 1);
    l.discardPile.push(card);

    if (card.startsWith("wild")) {
      if (!["red", "green", "blue", "yellow"].includes(chosenColor)) return;
      l.wildColor = chosenColor;
      sendSystemMessage(l, `🌈 Wild color set to ${chosenColor}`);
    }

    handleSpecialCard(card, l, pid);

    if (hand.length === 0) {
      endRound(l, pid);
      return;
    }

    const ids = Object.keys(l.players);
    l.currentTurn = ids[(ids.indexOf(pid) + 1) % ids.length];
    emitState(l);
  });

  socket.on("drawCard", ({ lobby }) => {
    const l = lobbies[lobby];
    const pid = socket.id;
    if (pid !== l.currentTurn) return;

    const card = l.deck.pop();
    l.hands[pid].push(card);
    nextTurn(l);
  });

  socket.on("chat", ({ message }) => {
    const lobby = Object.values(lobbies).find(l => l.players[socket.id]);
    if (!lobby) return;
    const name = lobby.players[socket.id].name;
    io.to(lobby.id).emit("chat", { from: name, message });
  });

  socket.on("disconnect", () => {
    for (const lid in lobbies) {
      const l = lobbies[lid];
      if (l.players[socket.id]) {
        sendSystemMessage(l, `${l.players[socket.id].name} disconnected.`);
        delete l.players[socket.id];
        delete l.hands[socket.id];
        if (Object.keys(l.players).length < 2) delete lobbies[lid];
        else emitState(l);
        break;
      }
    }
  });
});

app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO server running on http://localhost:${PORT}`);
});
