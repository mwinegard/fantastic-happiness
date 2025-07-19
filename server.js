// server.js
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, "public")));

const lobbies = {};
const TURN_TIMEOUT = 60000;
const MAX_MISSES = 3;

function buildDeck() {
  const colors = ["red", "green", "blue", "yellow"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw2"];
  const wilds = ["wild", "wild4"];
  const deck = [];

  colors.forEach(color => {
    values.forEach(val => {
      deck.push(`${color}_${val}`);
      if (val !== "0") deck.push(`${color}_${val}`);
    });
  });

  wilds.forEach(w => {
    for (let i = 0; i < 4; i++) deck.push(w);
  });

  return shuffle(deck);
}

function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

function isPlayable(card, topCard, chosenColor) {
  if (card.startsWith("wild")) return true;
  const [cColor, cValue] = card.split("_");
  const [tColor, tValue] = topCard.split("_");
  return cColor === chosenColor || cColor === tColor || cValue === tValue;
}

function emitState(lobby) {
  const { id, players, hands, discardPile, currentTurn, chosenColor, scores } = lobby;
  const state = {
    players: Object.values(players).map(p => ({
      id: p.id,
      name: p.name,
      handSize: (hands[p.id] || []).length,
      misses: p.misses || 0,
      score: scores[p.id] || 0
    })),
    hands,
    discardPile,
    currentTurn,
    chosenColor,
    topCard: discardPile[discardPile.length - 1]
  };
  io.to(id).emit("state", state);
}

function startTurnTimer(lobby, playerId) {
  clearTimeout(lobby.timer);
  lobby.timer = setTimeout(() => {
    const hand = lobby.hands[playerId];
    if (!lobby.deck.length) {
      lobby.deck = shuffle(lobby.discardPile.splice(0, lobby.discardPile.length - 1));
    }
    if (lobby.deck.length) {
      hand.push(lobby.deck.pop());
    }

    lobby.players[playerId].misses = (lobby.players[playerId].misses || 0) + 1;
    if (lobby.players[playerId].misses >= MAX_MISSES) {
      const removedHand = lobby.hands[playerId];
      delete lobby.players[playerId];
      delete lobby.hands[playerId];
      const remaining = Object.keys(lobby.players);
      remaining.forEach((pid, i) => {
        lobby.hands[pid].push(...removedHand.splice(i, 1));
      });
      io.to(lobby.id).emit("message", { from: "SUE", text: `${playerId} was removed for inactivity.` });
    }

    advanceTurn(lobby);
    emitState(lobby);
  }, TURN_TIMEOUT);
}

function advanceTurn(lobby) {
  const ids = Object.keys(lobby.players);
  const idx = ids.indexOf(lobby.currentTurn);
  lobby.currentTurn = ids[(idx + 1) % ids.length];
  startTurnTimer(lobby, lobby.currentTurn);
}

io.on("connection", socket => {
  socket.on("join", ({ name, lobby }) => {
    if (!name || !lobby) return;
    socket.join(lobby);
    if (!lobbies[lobby]) {
      lobbies[lobby] = {
        id: lobby,
        players: {},
        hands: {},
        deck: shuffle(buildDeck()),
        discardPile: [],
        currentTurn: null,
        chosenColor: null,
        scores: {},
        timer: null
      };
    }

    const l = lobbies[lobby];
    if (Object.keys(l.players).length >= 10) {
      socket.emit("error", "Lobby full");
      return;
    }

    l.players[socket.id] = { id: socket.id, name, misses: 0 };
    l.hands[socket.id] = l.deck.splice(0, 7);
    if (!l.currentTurn) {
      let card;
      do { card = l.deck.pop(); l.discardPile.push(card); } while (card.startsWith("wild"));
      l.currentTurn = socket.id;
      startTurnTimer(l, socket.id);
    }

    emitState(l);
  });

  socket.on("playCard", ({ lobby, card, chosenColor }) => {
    const l = lobbies[lobby];
    const pid = socket.id;
    if (!l || l.currentTurn !== pid) return;

    const hand = l.hands[pid];
    const index = hand.indexOf(card);
    const top = l.discardPile[l.discardPile.length - 1];
    if (index === -1 || !isPlayable(card, top, l.chosenColor || top.split("_")[0])) return;

    hand.splice(index, 1);
    l.discardPile.push(card);
    l.chosenColor = card.startsWith("wild") ? chosenColor : null;

    // handle special effects
    const next = () => advanceTurn(l);
    if (card.endsWith("skip")) {
      next(); next();
    } else if (card.endsWith("reverse")) {
      Object.keys(l.players).reverse();
      next();
    } else if (card.endsWith("draw2")) {
      const ids = Object.keys(l.players);
      const nextId = ids[(ids.indexOf(pid) + 1) % ids.length];
      l.hands[nextId].push(...l.deck.splice(0, 2));
      next();
    } else if (card === "wild4") {
      const ids = Object.keys(l.players);
      const nextId = ids[(ids.indexOf(pid) + 1) % ids.length];
      l.hands[nextId].push(...l.deck.splice(0, 4));
      next();
    } else {
      next();
    }

    // win check
    if (hand.length === 0) {
      const score = Object.values(l.hands).flat().reduce((sum, c) => {
        if (c.startsWith("wild")) return sum + 50;
        if (c.includes("skip") || c.includes("reverse") || c.includes("draw")) return sum + 20;
        return sum + parseInt(c.split("_")[1]);
      }, 0);
      l.scores[pid] = (l.scores[pid] || 0) + score;
      io.to(l.id).emit("message", { from: "SUE", text: `🎉 ${l.players[pid].name} wins this round!` });
      l.deck = shuffle(buildDeck());
      Object.keys(l.players).forEach(id => {
        l.hands[id] = l.deck.splice(0, 7);
        l.players[id].misses = 0;
      });
      l.discardPile = [l.deck.pop()];
    }

    emitState(l);
  });

  socket.on("drawCard", ({ lobby }) => {
    const l = lobbies[lobby];
    const pid = socket.id;
    if (!l || l.currentTurn !== pid) return;
    if (!l.deck.length) {
      l.deck = shuffle(l.discardPile.splice(0, l.discardPile.length - 1));
    }
    if (l.deck.length) {
      l.hands[pid].push(l.deck.pop());
    }
    advanceTurn(l);
    emitState(l);
  });

  socket.on("chat", ({ lobby, text }) => {
    if (!text.trim()) return;
    io.to(lobby).emit("message", { from: socket.id, text });
  });

  socket.on("disconnect", () => {
    for (const lobbyId in lobbies) {
      const l = lobbies[lobbyId];
      if (l.players[socket.id]) {
        delete l.players[socket.id];
        delete l.hands[socket.id];
        if (Object.keys(l.players).length === 0) {
          delete lobbies[lobbyId];
        } else {
          emitState(l);
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO server running on http://localhost:${PORT}`);
});
