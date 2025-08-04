const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

let game = {
  players: [],
  spectators: [],
  hands: {},
  discardPile: [],
  deck: [],
  started: false,
  turnIndex: 0,
  turn: null,
  direction: 1,
  unoCalled: {},
  missedTurns: {}
};

let scores = {};
try {
  scores = JSON.parse(fs.readFileSync("scores.json", "utf8"));
} catch {
  scores = {};
}

const specialCardLogic = {
  wild_boss: (currentPlayerId) => {
    game.players.forEach(p => {
      if (p.id !== currentPlayerId && game.hands[p.id]?.length) {
        const card = game.hands[p.id].pop();
        game.hands[currentPlayerId].push(card);
      }
    });
    sendToAll("chat", { from: "SUE", message: `🎁 THE BOSS: ${getPlayer(currentPlayerId).name} steals 1 card from each player.` });
  },
  green_recycle: () => {
    const allCards = [];
    Object.keys(game.hands).forEach(pid => {
      allCards.push(...game.hands[pid]);
      game.hands[pid] = [];
    });
    shuffle(allCards);
    const pids = Object.keys(game.hands);
    allCards.forEach((card, i) => {
      game.hands[pids[i % pids.length]].push(card);
    });
    sendToAll("chat", { from: "SUE", message: "♻️ RECYCLING: Hands shuffled and redistributed!" });
  }
};

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function generateDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  const deck = [];
  colors.forEach(color => {
    for (let i = 0; i <= 9; i++) {
      deck.push(`${color}_${i}`);
      if (i !== 0) deck.push(`${color}_${i}`);
    }
    ["skip", "reverse", "draw2"].forEach(action => {
      deck.push(`${color}_${action}`);
      deck.push(`${color}_${action}`);
    });
  });
  for (let i = 0; i < 4; i++) {
    deck.push("wild", "wild_draw4");
  }
  deck.push("wild_boss", "green_recycle");
  shuffle(deck);
  return deck;
}

function getPlayer(id) {
  return game.players.find(p => p.id === id);
}

function sendToAll(event, payload) {
  game.players.concat(game.spectators).forEach(p => io.to(p.id).emit(event, payload));
}

function emitGameState() {
  const state = {
    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      handSize: game.hands[p.id].length,
      score: scores[p.name]?.points || 0,
      wins: scores[p.name]?.wins || 0,
      isTurn: p.id === game.turn
    })),
    spectators: game.spectators.map(p => p.name),
    discardTop: game.discardPile.at(-1),
    drawPileSize: game.deck.length
  };

  sendToAll("state", state);

  game.players.forEach(p => {
    io.to(p.id).emit("yourHand", game.hands[p.id]);
  });
}

function advanceTurn(skip = 1) {
  game.turnIndex = (game.turnIndex + skip * game.direction + game.players.length) % game.players.length;
  game.turn = game.players[game.turnIndex].id;
  game.unoCalled = {}; // Reset UNO call tracker
  startTurnTimer();
}

function updateScores(winnerId) {
  const winner = getPlayer(winnerId).name;
  if (!scores[winner]) scores[winner] = { wins: 0, points: 0 };
  scores[winner].wins++;
  let points = 0;
  Object.entries(game.hands).forEach(([pid, hand]) => {
    if (pid !== winnerId) {
      hand.forEach(card => {
        if (card.includes("wild")) points += 50;
        else if (card.includes("draw") || card.includes("reverse") || card.includes("skip")) points += 20;
        else points += 10;
      });
    }
  });
  scores[winner].points += points;
  fs.writeFileSync("scores.json", JSON.stringify(scores, null, 2));
}

function startGame() {
  game.deck = generateDeck();
  game.discardPile = [game.deck.pop()];
  game.players.forEach(p => {
    game.hands[p.id] = [];
    for (let i = 0; i < 7; i++) game.hands[p.id].push(game.deck.pop());
  });
  game.turnIndex = 0;
  game.turn = game.players[0].id;
  game.started = true;
  sendToAll("sound", "start");
  sendToAll("chat", { from: "SUE", message: `🎮 Game has begun! First card: ${game.discardPile.at(-1)}` });
  emitGameState();
  startTurnTimer();
}

let turnTimeout;
function startTurnTimer() {
  clearTimeout(turnTimeout);
  const pid = game.turn;
  sendToAll("chat", { from: "SUE", message: `🔁 ${getPlayer(pid).name}'s turn.` });
  turnTimeout = setTimeout(() => {
    game.missedTurns[pid] = (game.missedTurns[pid] || 0) + 1;
    const card = game.deck.pop();
    game.hands[pid].push(card);
    sendToAll("chat", { from: "SUE", message: `${getPlayer(pid).name} took too long and drew a card.` });
    if (game.missedTurns[pid] >= 3) {
      sendToAll("chat", { from: "SUE", message: `${getPlayer(pid).name} has been removed for inactivity.` });
      game.players = game.players.filter(p => p.id !== pid);
      delete game.hands[pid];
    }
    if (game.players.length === 1) {
      updateScores(game.players[0].id);
      sendToAll("chat", { from: "SUE", message: `${game.players[0].name} wins by default.` });
      game.started = false;
      return;
    }
    advanceTurn(1);
    emitGameState();
  }, 60000);
}

io.on("connection", socket => {
  socket.on("join", ({ name }) => {
    if (!name || game.players.concat(game.spectators).find(p => p.name === name)) {
      socket.emit("joinDenied", "Name already in use.");
      return;
    }

    if (game.started && game.players.length < 10) {
      game.players.push({ id: socket.id, name });
      game.hands[socket.id] = [];
      for (let i = 0; i < 7; i++) game.hands[socket.id].push(game.deck.pop());
      sendToAll("chat", { from: "SUE", message: `${name} joined and entered the game.` });
    } else if (!game.started && game.players.length < 10) {
      game.players.push({ id: socket.id, name });
      sendToAll("chat", { from: "SUE", message: `${name} joined.` });
      if (game.players.length >= 2 && !game.countdownStarted) {
        game.countdownStarted = true;
        let t = 30;
        const interval = setInterval(() => {
          sendToAll("chat", { from: "SUE", message: `Game starting in ${t}...` });
          if (--t <= 0) {
            clearInterval(interval);
            startGame();
            game.countdownStarted = false;
          }
        }, 1000);
      }
    } else {
      game.spectators.push({ id: socket.id, name });
      socket.emit("chat", { from: "SUE", message: `${name}, you're a spectator.` });
    }

    socket.join("default");
    emitGameState();
    sendToAll("sound", "joined");
  });

  socket.on("chat", msg => {
    const player = getPlayer(socket.id) || game.spectators.find(p => p.id === socket.id);
    if (player) sendToAll("chat", { from: player.name, message: msg });
  });

  socket.on("drawCard", () => {
    if (socket.id !== game.turn || !game.started) return;
    const card = game.deck.pop();
    game.hands[socket.id].push(card);
    sendToAll("sound", "draw");
    sendToAll("chat", { from: "SUE", message: `${getPlayer(socket.id).name} drew a card.` });
    advanceTurn();
    emitGameState();
  });

  socket.on("playCard", ({ card, chosenColor }) => {
    if (socket.id !== game.turn || !game.started) return;
    const hand = game.hands[socket.id];
    const i = hand.indexOf(card);
    if (i === -1) return;
    const lastCard = game.discardPile.at(-1);
    const colorMatch = card.split("_")[0] === lastCard.split("_")[0];
    const valueMatch = card.split("_")[1] === lastCard.split("_")[1];
    const isWild = card.startsWith("wild");

    if (!(colorMatch || valueMatch || isWild || card.includes("wild"))) return;

    hand.splice(i, 1);
    const finalCard = chosenColor ? `${chosenColor}_${card}` : card;
    game.discardPile.push(finalCard);

    if (hand.length === 1) game.unoCalled[socket.id] = false;

    if (card.includes("skip")) {
      advanceTurn(2);
      sendToAll("sound", "skip");
    } else if (card.includes("reverse")) {
      game.direction *= -1;
      if (game.players.length === 2) advanceTurn(2);
      else advanceTurn(1);
      sendToAll("sound", "reverse");
    } else if (card.includes("draw2")) {
      const next = game.players[(game.turnIndex + game.direction + game.players.length) % game.players.length];
      game.hands[next.id].push(game.deck.pop(), game.deck.pop());
      sendToAll("chat", { from: "SUE", message: `${getPlayer(next.id).name} draws 2!` });
      sendToAll("sound", "special");
      advanceTurn(2);
    } else if (card === "wild_draw4") {
      const next = game.players[(game.turnIndex + game.direction + game.players.length) % game.players.length];
      for (let i = 0; i < 4; i++) game.hands[next.id].push(game.deck.pop());
      sendToAll("chat", { from: "SUE", message: `${getPlayer(next.id).name} draws 4!` });
      sendToAll("sound", "wild");
      advanceTurn(2);
    } else if (card.startsWith("wild")) {
      if (specialCardLogic[card]) specialCardLogic[card](socket.id);
      sendToAll("sound", "special");
      advanceTurn(1);
    } else {
      sendToAll("sound", "number");
      advanceTurn(1);
    }

    if (hand.length === 0) {
      if (!game.unoCalled[socket.id]) {
        game.hands[socket.id].push(game.deck.pop(), game.deck.pop());
        sendToAll("chat", { from: "SUE", message: `${getPlayer(socket.id).name} failed to call UNO and was penalized!` });
      } else {
        updateScores(socket.id);
        sendToAll("chat", { from: "SUE", message: `${getPlayer(socket.id).name} wins the round! 🎉` });
        game.started = false;
      }
    }

    emitGameState();
  });

  socket.on("callUNO", () => {
    if (game.hands[socket.id]?.length === 1) {
      game.unoCalled[socket.id] = true;
      sendToAll("chat", { from: "SUE", message: `${getPlayer(socket.id).name} yells UNO!` });
      sendToAll("sound", "uno");
    }
  });

  socket.on("triggerSound", sound => {
    sendToAll("sound", sound);
  });

  socket.on("disconnect", () => {
    game.players = game.players.filter(p => p.id !== socket.id);
    game.spectators = game.spectators.filter(p => p.id !== socket.id);
    delete game.hands[socket.id];
    emitGameState();
  });
});

app.get("/scores", (req, res) => res.json(scores));

http.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
