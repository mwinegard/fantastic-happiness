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

  for (let i = 0; i < 4; i++) {
    deck.push("wild", "wild_draw4");
  }

  return deck;
}

function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

function emitState(lobby) {
  const state = {
    players: Object.values(lobby.players).map(p => ({
      id: p.id,
      name: p.name,
      score: scores[p.name]?.score || 0,
      handSize: (lobby.hands[p.id] || []).length,
    })),
    hands: lobby.hands,
    discardPile: lobby.discardPile,
    currentTurn: lobby.currentTurn,
  };
  io.to(lobby.id).emit("state", state);
}

function sendSUE(lobby, msg) {
  io.to(lobby.id).emit("chat", { from: "SUE", message: msg });
}

function calculateScore(hand) {
  return hand.reduce((sum, c) => {
    if (c.includes("wild")) return sum + 50;
    if (c.includes("skip") || c.includes("reverse") || c.includes("draw")) return sum + 20;
    return sum + parseInt(c.split("_")[1]) || 0;
  }, 0);
}

function endRound(lobby, winnerId) {
  const winnerName = lobby.players[winnerId].name;
  const total = Object.entries(lobby.hands)
    .filter(([pid]) => pid !== winnerId)
    .reduce((sum, [_, h]) => sum + calculateScore(h), 0);

  scores[winnerName] = scores[winnerName] || { score: 0, wins: 0 };
  scores[winnerName].score += total;
  scores[winnerName].wins += 1;
  saveScores();

  sendSUE(lobby, `${winnerName} wins the round and earns ${total} points! 🎉`);
  delete lobbies[lobby.id];
}

function nextTurn(lobby) {
  const ids = Object.keys(lobby.players);
  if (ids.length < 2) return;
  const dir = lobby.reverse ? -1 : 1;
  const idx = ids.indexOf(lobby.currentTurn);
  lobby.currentTurn = ids[(idx + dir + ids.length) % ids.length];
  emitState(lobby);
}

function startGame(lobby) {
  lobby.deck = shuffle(createDeck());
  lobby.hands = {};
  lobby.discardPile = [];

  let top;
  do { top = lobby.deck.pop(); } while (top.startsWith("wild"));
  lobby.discardPile.push(top);

  for (const pid of Object.keys(lobby.players)) {
    lobby.hands[pid] = lobby.deck.splice(0, 7);
  }

  lobby.reverse = false;
  lobby.currentTurn = Object.keys(lobby.players)[0];
  sendSUE(lobby, "Game started!");
  emitState(lobby);
}

function startCountdown(lobby) {
  if (lobby.started || lobby.countdown) return;
  let seconds = 30;

  lobby.countdown = setInterval(() => {
    if (Object.keys(lobby.players).length < 2) {
      clearInterval(lobby.countdown);
      lobby.countdown = null;
      sendSUE(lobby, "Waiting for more players...");
      return;
    }

    if (seconds % 5 === 0) sendSUE(lobby, `Game starting in ${seconds}s...`);
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
        hands: {},
        discardPile: [],
        reverse: false,
      };
    }

    const l = lobbies[lobby];
    l.players[socket.id] = { id: socket.id, name };
    if (!l.hands[socket.id]) l.hands[socket.id] = [];

    sendSUE(l, `${name} joined.`);
    emitState(l);
    startCountdown(l);
  });

  socket.on("chat", ({ message }) => {
    const lobby = Object.values(lobbies).find(l => l.players[socket.id]);
    if (lobby) {
      const name = lobby.players[socket.id].name;
      io.to(lobby.id).emit("chat", { from: name, message });
    }
  });

  socket.on("playCard", ({ lobby, card, chosenColor }) => {
    lobby = lobby.toLowerCase();
    const l = lobbies[lobby];
    if (!l) return;
    const pid = socket.id;
    const hand = l.hands[pid];
    if (!hand || l.currentTurn !== pid) return;

    const i = hand.indexOf(card);
    if (i === -1) return;

    const top = l.discardPile[l.discardPile.length - 1];
    const [topColor, topValue] = top.split("_");
    const [cColor, cVal] = card.includes("_") ? card.split("_") : [null, card];

    const isWild = card.startsWith("wild");
    const valid =
      isWild || cColor === topColor || cVal === topValue || (top === "wild" && cColor === l.wildColor);

    if (!valid) return;

    hand.splice(i, 1);
    l.discardPile.push(card);

    if (isWild) {
      if (!["red", "green", "blue", "yellow"].includes(chosenColor)) return;
      l.wildColor = chosenColor;
      sendSUE(l, `Wild color selected: ${chosenColor}`);
    } else {
      l.wildColor = null;
    }

    const ids = Object.keys(l.players);
    let idx = ids.indexOf(pid);
    let skip = 0;

    if (cVal === "reverse") {
      l.reverse = !l.reverse;
      sendSUE(l, "Play direction reversed.");
    } else if (cVal === "skip") {
      skip = 1;
      sendSUE(l, `${l.players[ids[(idx + 1) % ids.length]].name} was skipped.`);
    } else if (cVal.includes("draw")) {
      const draw = card === "wild_draw4" ? 4 : 2;
      const victim = ids[(idx + 1) % ids.length];
      l.hands[victim].push(...l.deck.splice(0, draw));
      skip = 1;
      sendSUE(l, `${l.players[victim].name} draws ${draw} and is skipped.`);
    }

    if (hand.length === 0) {
      endRound(l, pid);
      return;
    }

    for (let s = 0; s <= skip; s++) {
      idx = l.reverse ? (ids.length + idx - 1) % ids.length : (idx + 1) % ids.length;
    }

    l.currentTurn = ids[idx];
    emitState(l);
  });

  socket.on("drawCard", ({ lobby }) => {
    const l = lobbies[lobby.toLowerCase()];
    if (!l) return;
    const pid = socket.id;
    if (pid !== l.currentTurn) return;

    const c = l.deck.pop();
    l.hands[pid].push(c);
    nextTurn(l);
  });

  socket.on("disconnect", () => {
    for (const lid in lobbies) {
      const l = lobbies[lid];
      if (l.players[socket.id]) {
        const name = l.players[socket.id].name;
        sendSUE(l, `${name} left.`);

        const remaining = Object.keys(l.players).filter(id => id !== socket.id);
        const hand = l.hands[socket.id];
        let i = 0;
        for (const card of hand) {
          const pid = remaining[i++ % remaining.length];
          l.hands[pid].push(card);
        }

        delete l.players[socket.id];
        delete l.hands[socket.id];

        if (remaining.length < 2) delete lobbies[lid];
        else emitState(l);
        break;
      }
    }
  });
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO server running at http://localhost:${PORT}`);
});
