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
      handSize: (lobby.hands[p.id] || []).length
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
  lobby.currentTurn = ids[(currentIdx + (lobby.direction || 1) + ids.length) % ids.length];
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
    lobby.turnMissed = (lobby.turnMissed || {});
    lobby.turnMissed[pid] = (lobby.turnMissed[pid] || 0) + 1;

    if (lobby.turnMissed[pid] >= 3) {
      sendSystemMessage(lobby, `${lobby.players[pid].name} removed after 3 missed turns.`);
      delete lobby.players[pid];
      delete lobby.hands[pid];
      if (Object.keys(lobby.players).length < 2) {
        sendSystemMessage(lobby, `Game ended. Not enough players.`);
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

  sendSystemMessage(lobby, `🎉 ${winnerName} wins the round and earns ${totalScore} points!`);

  // Reset
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
        direction: 1
      };
      sendSystemMessage(lobbies[lobby], `${name} created lobby.`);
    }

    const lobbyObj = lobbies[lobby];
    lobbyObj.players[socket.id] = { id: socket.id, name };
    sendSystemMessage(lobbyObj, `${name} joined.`);

    startCountdown(lobbyObj);
    emitState(lobbyObj);
  });

  socket.on("chat", ({ message }) => {
    const lobby = Object.values(lobbies).find(l => l.players[socket.id]);
    if (!lobby) return;
    const name = lobby.players[socket.id].name;
    io.to(lobby.id).emit("chat", { from: name, message });
  });

  socket.on("playCard", ({ lobby, card, chosenColor }) => {
    lobby = lobby.toLowerCase();
    const lobbyObj = lobbies[lobby];
    if (!lobbyObj) return;

    const pid = socket.id;
    if (pid !== lobbyObj.currentTurn) return;

    const hand = lobbyObj.hands[pid];
    const topCard = lobbyObj.discardPile.slice(-1)[0];
    if (!hand.includes(card)) return;

    const [topColor, topVal] = topCard.split("_");
    const [playColor, playVal] = card.split("_");

    if (!card.startsWith("wild") && playColor !== topColor && playVal !== topVal) return;

    hand.splice(hand.indexOf(card), 1);
    lobbyObj.discardPile.push(card);

    if (card === "wild_draw4" || card === "wild") {
      lobbyObj.lastWildColor = chosenColor;
      sendSystemMessage(lobbyObj, `Color changed to ${chosenColor}`);
    }

    if (card.includes("draw")) {
      const ids = Object.keys(lobbyObj.players);
      const currentIdx = ids.indexOf(pid);
      const nextIdx = (currentIdx + lobbyObj.direction + ids.length) % ids.length;
      const nextPid = ids[nextIdx];
      const drawCount = card === "draw2" || card === "draw" ? 2 : 4;

      lobbyObj.hands[nextPid].push(...lobbyObj.deck.splice(0, drawCount));
      sendSystemMessage(lobbyObj, `${lobbyObj.players[nextPid].name} draws ${drawCount} cards.`);
      lobbyObj.currentTurn = ids[(nextIdx + lobbyObj.direction + ids.length) % ids.length];
    } else if (card.includes("skip")) {
      const ids = Object.keys(lobbyObj.players);
      const currentIdx = ids.indexOf(pid);
      const skipIdx = (currentIdx + lobbyObj.direction * 2 + ids.length) % ids.length;
      lobbyObj.currentTurn = ids[skipIdx];
      sendSystemMessage(lobbyObj, `${lobbyObj.players[ids[(currentIdx + lobbyObj.direction) % ids.length]].name} is skipped.`);
    } else if (card.includes("reverse")) {
      lobbyObj.direction *= -1;
      sendSystemMessage(lobbyObj, `Play direction has reversed!`);
      if (Object.keys(lobbyObj.players).length === 2) {
        // stay on same player
      } else {
        nextTurn(lobbyObj);
      }
    } else {
      nextTurn(lobbyObj);
    }

    if (hand.length === 0) {
      endRound(lobbyObj, pid);
    } else {
      emitState(lobbyObj);
    }
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
