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

  return deck;
}

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
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

function nextTurn(lobby) {
  const ids = Object.keys(lobby.players);
  const currentIdx = ids.indexOf(lobby.currentTurn);
  const direction = lobby.reverse ? -1 : 1;
  const nextIdx = (currentIdx + direction + ids.length) % ids.length;
  lobby.currentTurn = ids[nextIdx];
  emitState(lobby);
}

function endRound(lobby, winnerId) {
  const winnerName = lobby.players[winnerId].name;
  const points = Object.entries(lobby.hands)
    .filter(([id]) => id !== winnerId)
    .reduce((sum, [, hand]) => sum + hand.reduce((s, c) => {
      if (c.includes("wild")) return s + 50;
      if (c.includes("skip") || c.includes("reverse") || c.includes("draw")) return s + 20;
      return s + parseInt(c.split("_")[1]) || 0;
    }, 0), 0);

  scores[winnerName] = scores[winnerName] || { score: 0, wins: 0 };
  scores[winnerName].score += points;
  scores[winnerName].wins += 1;
  saveScores();

  sendSystemMessage(lobby, `🎉 ${winnerName} wins the round and earns ${points} points!`);
  delete lobbies[lobby.id];
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
        hands: {},
        wildColor: null,
        reverse: false,
        unoPressed: {}
      };
    }

    const lobbyObj = lobbies[lobby];
    lobbyObj.players[socket.id] = { id: socket.id, name };
    lobbyObj.hands[socket.id] = [];

    sendSystemMessage(lobbyObj, `${name} joined.`);
    if (Object.keys(lobbyObj.players).length === 2) {
      startGame(lobbyObj);
    } else {
      emitState(lobbyObj);
    }
  });

  socket.on("playCard", ({ lobby, card, chosenColor }) => {
    const lobbyObj = lobbies[lobby];
    if (!lobbyObj) return;

    const playerId = socket.id;
    if (playerId !== lobbyObj.currentTurn) return;

    const hand = lobbyObj.hands[playerId];
    const index = hand.indexOf(card);
    if (index === -1) return;

    const top = lobbyObj.discardPile[lobbyObj.discardPile.length - 1];
    const [topColor, topValue] = top.split("_");
    const [cardColor, cardValue] = card.split("_");

    const isWild = card.startsWith("wild");
    const valid = isWild || cardColor === topColor || cardValue === topValue || top === "wild";

    if (!valid) return;

    if (hand.length === 2 && !lobbyObj.unoPressed[playerId]) {
      sendSystemMessage(lobbyObj, `${lobbyObj.players[playerId].name} forgot to press UNO! Draw 2 penalty!`);
      hand.push(...lobbyObj.deck.splice(0, 2));
    }

    lobbyObj.unoPressed[playerId] = false;
    hand.splice(index, 1);
    lobbyObj.discardPile.push(card);

    if (hand.length === 0) {
      endRound(lobbyObj, playerId);
      return;
    }

    if (isWild) {
      if (!["red", "green", "blue", "yellow"].includes(chosenColor)) return;
      lobbyObj.wildColor = chosenColor;
      sendSystemMessage(lobbyObj, `Wild color selected: ${chosenColor}`);
    } else {
      lobbyObj.wildColor = null;
    }

    const ids = Object.keys(lobbyObj.players);
    const idx = ids.indexOf(playerId);
    let nextIdx = (idx + 1) % ids.length;

    if (cardValue === "reverse") {
      lobbyObj.reverse = !lobbyObj.reverse;
      sendSystemMessage(lobbyObj, `Play direction reversed.`);
    }

    if (cardValue === "skip") {
      nextIdx = (nextIdx + 1) % ids.length;
      sendSystemMessage(lobbyObj, `${lobbyObj.players[ids[nextIdx]].name} was skipped.`);
    }

    if (card === "wild_draw4" || cardValue === "draw") {
      const drawAmount = card.includes("4") ? 4 : 2;
      const targetId = ids[(idx + 1) % ids.length];
      lobbyObj.hands[targetId].push(...lobbyObj.deck.splice(0, drawAmount));
      sendSystemMessage(lobbyObj, `${lobbyObj.players[targetId].name} draws ${drawAmount} cards.`);
      nextIdx = (nextIdx + 1) % ids.length;
    }

    lobbyObj.currentTurn = ids[nextIdx];
    emitState(lobbyObj);
  });

  socket.on("drawCard", ({ lobby }) => {
    const lobbyObj = lobbies[lobby];
    const pid = socket.id;
    if (!lobbyObj || pid !== lobbyObj.currentTurn) return;

    lobbyObj.hands[pid].push(lobbyObj.deck.pop());
    const ids = Object.keys(lobbyObj.players);
    const idx = ids.indexOf(pid);
    lobbyObj.currentTurn = ids[(idx + 1) % ids.length];
    emitState(lobbyObj);
  });

  socket.on("chat", ({ message }) => {
    const lobby = Object.values(lobbies).find(l => l.players[socket.id]);
    if (!lobby) return;
    const name = lobby.players[socket.id].name;
    io.to(lobby.id).emit("chat", { from: name, message });

    if (message.toLowerCase().includes("uno")) {
      lobby.unoPressed[socket.id] = true;
    }
  });

  socket.on("disconnect", () => {
    for (let lid in lobbies) {
      const lobby = lobbies[lid];
      if (lobby.players[socket.id]) {
        sendSystemMessage(lobby, `${lobby.players[socket.id].name} left.`);
        delete lobby.players[socket.id];
        delete lobby.hands[socket.id];
        emitState(lobby);
        break;
      }
    }
  });
});

function startGame(lobby) {
  lobby.deck = shuffle(createDeck());
  lobby.hands = {};
  lobby.discardPile = [];
  lobby.unoPressed = {};

  let firstCard;
  do {
    firstCard = lobby.deck.pop();
  } while (firstCard.startsWith("wild"));

  lobby.discardPile.push(firstCard);

  for (const pid of Object.keys(lobby.players)) {
    lobby.hands[pid] = lobby.deck.splice(0, 7);
  }

  lobby.currentTurn = Object.keys(lobby.players)[0];
  emitState(lobby);
}

app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO server running at http://localhost:${PORT}`);
});
