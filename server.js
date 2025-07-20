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

function getPlayerOrder(lobby) {
  return Object.keys(lobby.players).sort();
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
  const ids = getPlayerOrder(lobby);
  const curIdx = ids.indexOf(lobby.currentTurn);
  lobby.currentTurn = ids[(curIdx + lobby.direction + ids.length) % ids.length];
  lobby.turnStart = Date.now();
  emitState(lobby);
  startTurnTimer(lobby);
}

function startTurnTimer(lobby) {
  if (lobby.turnTimeout) clearTimeout(lobby.turnTimeout);
  lobby.turnTimeout = setTimeout(() => {
    const pid = lobby.currentTurn;
    const hand = lobby.hands[pid];
    if (!hand) return;

    sendSystemMessage(lobby, `${lobby.players[pid].name} took too long. Auto-draw.`);
    const card = lobby.deck.pop();
    hand.push(card);
    lobby.turnMissed[pid] = (lobby.turnMissed[pid] || 0) + 1;

    if (lobby.turnMissed[pid] >= 3) {
      sendSystemMessage(lobby, `${lobby.players[pid].name} removed after 3 missed turns.`);
      delete lobby.players[pid];
      delete lobby.hands[pid];
      if (Object.keys(lobby.players).length < 2) {
        sendSystemMessage(lobby, `Game ended. Not enough players.`);
        delete lobbies[lobby.id];
        return;
      }
    }

    nextTurn(lobby);
  }, 60000);
}

function calculateScore(hand) {
  return hand.reduce((total, card) => {
    if (card.includes("wild")) return total + 50;
    if (card.includes("skip") || card.includes("reverse") || card.includes("draw")) return total + 20;
    return total + parseInt(card.split("_")[1]) || 0;
  }, 0);
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

function startCountdown(lobby) {
  if (lobby.started || lobby.countdown) return;
  let seconds = 30;

  lobby.countdown = setInterval(() => {
    if (Object.keys(lobby.players).length < 2) {
      clearInterval(lobby.countdown);
      lobby.countdown = null;
      sendSystemMessage(lobby, "Waiting for more players...");
      return;
    }

    if (seconds % 5 === 0 || seconds === 30) {
      sendSystemMessage(lobby, `Game starting in ${seconds} seconds...`);
    }

    if (--seconds <= 0) {
      clearInterval(lobby.countdown);
      lobby.started = true;
      startGame(lobby);
    }
  }, 1000);
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
      sendSystemMessage(lobbies[lobby], `${name} created lobby.`);
    }

    const lobbyObj = lobbies[lobby];
    lobbyObj.players[socket.id] = { id: socket.id, name };
    if (lobbyObj.started) {
      lobbyObj.hands[socket.id] = lobbyObj.deck.splice(0, 7);
    }
    if (!lobbyObj.hands[socket.id]) {
      lobbyObj.hands[socket.id] = [];
    }

    sendSystemMessage(lobbyObj, `${name} joined.`);
    startCountdown(lobbyObj);
    emitState(lobbyObj);
  });

  socket.on("chat", (message) => {
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

    const cardIndex = hand.indexOf(card);
    if (cardIndex === -1) return;

    const topCard = lobbyObj.discardPile[lobbyObj.discardPile.length - 1];
    const [topColor, topValue] = topCard.split("_");
    const [cardColor, cardValue] = card.includes("_") ? card.split("_") : [null, card];

    const isWild = card.startsWith("wild");
    const isValidPlay =
      isWild ||
      cardColor === topColor ||
      cardValue === topValue ||
      (topCard === "wild" && cardColor === lobbyObj.wildColor);

    if (!isValidPlay) return;

    hand.splice(cardIndex, 1);
    lobbyObj.discardPile.push(card);

    if (hand.length === 0) {
      endRound(lobbyObj, playerId);
      return;
    }

    if (isWild) {
      if (!chosenColor || !["red", "blue", "green", "yellow"].includes(chosenColor)) return;
      lobbyObj.wildColor = chosenColor;
      io.to(lobby).emit("chat", { from: "SUE", message: `Wild card color chosen: ${chosenColor}` });
    } else {
      lobbyObj.wildColor = null;
    }

    const playerIds = getPlayerOrder(lobbyObj);
    let curIndex = playerIds.indexOf(playerId);
    let nextIndex = (curIndex + 1) % playerIds.length;
    let skipCount = 0;

    if (cardValue === "reverse") {
      lobbyObj.direction *= -1;
      io.to(lobby).emit("chat", { from: "SUE", message: `Play direction has reversed.` });
    }

    if (cardValue === "skip") {
      skipCount = 1;
      const skipped = playerIds[nextIndex];
      io.to(lobby).emit("chat", { from: "SUE", message: `${lobbyObj.players[skipped].name} was skipped.` });
    }

    if (cardValue === "draw" || cardValue === "draw2" || cardValue === "draw4") {
      const drawAmount = card.includes("4") ? 4 : 2;
      const victimId = playerIds[nextIndex];
      lobbyObj.hands[victimId].push(...lobbyObj.deck.splice(0, drawAmount));
      io.to(lobby).emit("chat", {
        from: "SUE",
        message: `${lobbyObj.players[victimId].name} drew ${drawAmount} cards.`
      });
      skipCount = 1;
    }

    for (let i = 0; i < skipCount + 1; i++) {
      nextIndex = (nextIndex + lobbyObj.direction + playerIds.length) % playerIds.length;
    }

    lobbyObj.currentTurn = playerIds[nextIndex];
    emitState(lobbyObj);
  });

  socket.on("drawCard", ({ lobby }) => {
    lobby = lobby.toLowerCase();
    const lobbyObj = lobbies[lobby];
    if (!lobbyObj) return;

    const pid = socket.id;
    if (pid !== lobbyObj.currentTurn) return;

    const card = lobbyObj.deck.pop();
    lobbyObj.hands[pid].push(card);
    nextTurn(lobbyObj);
  });

  socket.on("disconnect", () => {
    for (let lobbyId in lobbies) {
      const lobby = lobbies[lobbyId];
      if (lobby.players[socket.id]) {
        const name = lobby.players[socket.id].name;
        sendSystemMessage(lobby, `${name} left.`);
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

app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO server running on http://localhost:${PORT}`);
});
