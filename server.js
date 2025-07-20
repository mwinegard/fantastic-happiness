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

  for (const color of colors) {
    for (const val of values) {
      deck.push(`${color}_${val}`);
      if (val !== "0") deck.push(`${color}_${val}`);
    }
  }

  for (const w of wilds) {
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
      handSize: lobby.hands[p.id]?.length || 0
    })),
    hands: lobby.hands,
    discardPile: lobby.discardPile,
    currentTurn: lobby.currentTurn
  };
  io.to(lobby.id).emit("state", state);
}

function nextPlayerId(lobby, skip = 0) {
  const ids = Object.keys(lobby.players);
  const idx = ids.indexOf(lobby.currentTurn);
  const step = lobby.reverse && ids.length > 2 ? -1 : 1;
  let next = (idx + step + ids.length) % ids.length;
  for (let i = 0; i < skip; i++) {
    next = (next + step + ids.length) % ids.length;
  }
  return ids[next];
}

function calculateScore(hand) {
  return hand.reduce((sum, card) => {
    if (card.includes("wild")) return sum + 50;
    if (card.includes("skip") || card.includes("reverse") || card.includes("draw")) return sum + 20;
    return sum + parseInt(card.split("_")[1]) || 0;
  }, 0);
}

function endRound(lobby, winnerId) {
  const winnerName = lobby.players[winnerId].name;
  const others = Object.entries(lobby.hands).filter(([id]) => id !== winnerId);
  const totalPoints = others.reduce((sum, [, hand]) => sum + calculateScore(hand), 0);

  scores[winnerName] = scores[winnerName] || { score: 0, wins: 0 };
  scores[winnerName].score += totalPoints;
  scores[winnerName].wins += 1;
  saveScores();

  sendSystemMessage(lobby, `🎉 ${winnerName} wins the round and earns ${totalPoints} points!`);
  delete lobbies[lobby.id];
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

  lobby.reverse = false;
  lobby.currentTurn = Object.keys(lobby.players)[0];
  sendSystemMessage(lobby, `Game started!`);
  emitState(lobby);
}

function startCountdown(lobby) {
  if (lobby.countdown || lobby.started) return;
  let secs = 30;
  lobby.countdown = setInterval(() => {
    if (Object.keys(lobby.players).length < 2) {
      sendSystemMessage(lobby, "Waiting for more players...");
      clearInterval(lobby.countdown);
      lobby.countdown = null;
      return;
    }
    if (secs % 5 === 0 || secs === 30) {
      sendSystemMessage(lobby, `Game starting in ${secs} seconds...`);
    }
    if (--secs <= 0) {
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
        hands: {},
        deck: [],
        discardPile: [],
        reverse: false
      };
    }

    const lobbyObj = lobbies[lobby];
    lobbyObj.players[socket.id] = { id: socket.id, name };
    sendSystemMessage(lobbyObj, `${name} joined.`);
    if (lobbyObj.started) {
      lobbyObj.hands[socket.id] = lobbyObj.deck.splice(0, 7);
    }
    startCountdown(lobbyObj);
    emitState(lobbyObj);
  });

  socket.on("chat", (msg) => {
    const lobby = Object.values(lobbies).find(l => l.players[socket.id]);
    if (lobby) {
      const name = lobby.players[socket.id].name;
      io.to(lobby.id).emit("chat", { from: name, message: msg });
    }
  });

  socket.on("playCard", ({ lobby, card, chosenColor }) => {
    const lobbyObj = lobbies[lobby];
    if (!lobbyObj) return;

    const pid = socket.id;
    const hand = lobbyObj.hands[pid];
    if (!hand || lobbyObj.currentTurn !== pid) return;

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
      endRound(lobbyObj, pid);
      return;
    }

    if (isWild) {
      if (!["red", "blue", "green", "yellow"].includes(chosenColor)) return;
      lobbyObj.wildColor = chosenColor;
      const emojiMap = { red: "🔴", blue: "🔵", green: "🟢", yellow: "🟡" };
      sendSystemMessage(lobbyObj, `Wild color chosen: ${emojiMap[chosenColor]} ${chosenColor}`);
    } else {
      lobbyObj.wildColor = null;
    }

    let skip = 0;

    if (cardValue === "reverse") {
      if (Object.keys(lobbyObj.players).length === 2) {
        skip = 1;
        sendSystemMessage(lobbyObj, `Reverse acts as skip in 2-player game.`);
      } else {
        lobbyObj.reverse = !lobbyObj.reverse;
        sendSystemMessage(lobbyObj, `Play direction has reversed.`);
      }
    }

    if (cardValue === "skip") {
      skip = 1;
      const skipped = nextPlayerId(lobbyObj);
      sendSystemMessage(lobbyObj, `${lobbyObj.players[skipped].name} was skipped.`);
    }

    if (cardValue === "draw" || cardValue === "draw2" || cardValue === "draw4") {
      const drawAmt = card.includes("4") ? 4 : 2;
      const victimId = nextPlayerId(lobbyObj);
      lobbyObj.hands[victimId].push(...lobbyObj.deck.splice(0, drawAmt));
      sendSystemMessage(lobbyObj, `${lobbyObj.players[victimId].name} drew ${drawAmt} cards.`);
      skip = 1;
    }

    lobbyObj.currentTurn = nextPlayerId(lobbyObj, skip);
    emitState(lobbyObj);
  });

  socket.on("drawCard", ({ lobby }) => {
    const lobbyObj = lobbies[lobby];
    if (!lobbyObj) return;

    const pid = socket.id;
    if (pid !== lobbyObj.currentTurn) return;

    const card = lobbyObj.deck.pop();
    lobbyObj.hands[pid].push(card);
    lobbyObj.currentTurn = nextPlayerId(lobbyObj);
    emitState(lobbyObj);
  });

  socket.on("disconnect", () => {
    for (const lobbyId in lobbies) {
      const lobby = lobbies[lobbyId];
      if (lobby.players[socket.id]) {
        const name = lobby.players[socket.id].name;
        delete lobby.players[socket.id];
        delete lobby.hands[socket.id];
        sendSystemMessage(lobby, `${name} left.`);
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
