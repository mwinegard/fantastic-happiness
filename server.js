// server.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const specialCards = require("./specialCards");
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

  for (let w of wilds) for (let i = 0; i < 4; i++) deck.push(w);
  return deck;
}

function shuffle(deck) {
  return deck.sort(() => Math.random() - 0.5);
}

function sendSystemMessage(lobby, message) {
  io.to(lobby.id).emit("chat", { from: "SUE", message });
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
    sendSystemMessage(lobby, `${lobby.players[pid].name} took too long. Drew a card.`);
    advanceTurn(lobby);
  }, 60000);
}

function advanceTurn(lobby, skip = false) {
  const ids = Object.keys(lobby.players);
  let idx = ids.indexOf(lobby.currentTurn);
  if (lobby.direction === -1) {
    idx = (idx - 1 + ids.length) % ids.length;
  } else {
    idx = (idx + 1) % ids.length;
  }
  lobby.currentTurn = ids[idx];
  emitState(lobby);
  startTurnTimer(lobby);
}

function startGame(lobby) {
  lobby.deck = shuffle(createDeck());
  lobby.hands = {};
  lobby.discardPile = [];

  let firstCard;
  do {
    firstCard = lobby.deck.pop();
  } while (firstCard.startsWith("wild"));
  lobby.discardPile.push(firstCard);

  for (const pid of Object.keys(lobby.players)) {
    lobby.hands[pid] = lobby.deck.splice(0, 7);
  }

  lobby.direction = 1;
  lobby.currentTurn = Object.keys(lobby.players)[0];
  sendSystemMessage(lobby, `Game started!`);
  emitState(lobby);
  startTurnTimer(lobby);
}

function processSpecialCard(card, lobby, playerId, io) {
  if (specialCards[card]) {
    specialCards[card](lobby, playerId, io);
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
        discardPile: [],
        direction: 1
      };
      sendSystemMessage(lobbies[lobby], `${name} created lobby.`);
    }

    const lobbyObj = lobbies[lobby];
    lobbyObj.players[socket.id] = { id: socket.id, name };
    if (!lobbyObj.hands[socket.id]) {
      lobbyObj.hands[socket.id] = [];
    }

    if (lobbyObj.started) {
      lobbyObj.hands[socket.id] = lobbyObj.deck.splice(0, 7);
    }

    sendSystemMessage(lobbyObj, `${name} joined.`);
    if (!lobbyObj.started && Object.keys(lobbyObj.players).length >= 2) {
      lobbyObj.started = true;
      startGame(lobbyObj);
    } else {
      emitState(lobbyObj);
    }
  });

  socket.on("chat", ({ message }) => {
    const lobby = Object.values(lobbies).find(l => l.players[socket.id]);
    if (!lobby) return;
    const name = lobby.players[socket.id].name;
    io.to(lobby.id).emit("chat", { from: name, message });
  });

  socket.on("playCard", ({ lobby, card, chosenColor }) => {
    const lobbyObj = lobbies[lobby];
    if (!lobbyObj) return;

    const playerId = socket.id;
    const hand = lobbyObj.hands[playerId];
    if (!hand || lobbyObj.currentTurn !== playerId) return;

    const topCard = lobbyObj.discardPile[lobbyObj.discardPile.length - 1];
    const [topColor, topValue] = topCard.includes("_") ? topCard.split("_") : [null, topCard];
    const [cardColor, cardValue] = card.includes("_") ? card.split("_") : [null, card];
    const isWild = card.startsWith("wild");

    const isValidPlay = isWild ||
      cardColor === topColor ||
      cardValue === topValue ||
      (topCard === "wild" && cardColor === lobbyObj.wildColor);

    if (!isValidPlay) return;

    const cardIndex = hand.indexOf(card);
    if (cardIndex === -1) return;

    hand.splice(cardIndex, 1);
    lobbyObj.discardPile.push(card);

    if (isWild) {
      if (!["red", "blue", "green", "yellow"].includes(chosenColor)) return;
      lobbyObj.wildColor = chosenColor;
      io.to(lobby).emit("chat", {
        from: "SUE",
        message: `Wild color chosen: ${chosenColor.toUpperCase()} 🎨`
      });
    } else {
      lobbyObj.wildColor = null;
    }

    processSpecialCard(card, lobbyObj, playerId, io);

    if (hand.length === 0) {
      const winnerName = lobbyObj.players[playerId].name;
      sendSystemMessage(lobbyObj, `🎉 ${winnerName} has won the round!`);
      scores[winnerName] = scores[winnerName] || { score: 0, wins: 0 };
      scores[winnerName].wins += 1;
      saveScores();
      return;
    }

    advanceTurn(lobbyObj);
  });

  socket.on("drawCard", ({ lobby }) => {
    const lobbyObj = lobbies[lobby];
    if (!lobbyObj) return;

    const pid = socket.id;
    if (pid !== lobbyObj.currentTurn) return;

    const card = lobbyObj.deck.pop();
    lobbyObj.hands[pid].push(card);
    advanceTurn(lobbyObj);
  });

  socket.on("disconnect", () => {
    for (const lid in lobbies) {
      const lobby = lobbies[lid];
      if (lobby.players[socket.id]) {
        sendSystemMessage(lobby, `${lobby.players[socket.id].name} disconnected.`);
        delete lobby.players[socket.id];
        delete lobby.hands[socket.id];
        if (Object.keys(lobby.players).length < 2) {
          delete lobbies[lid];
        } else {
          emitState(lobby);
        }
        break;
      }
    }
  });
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
