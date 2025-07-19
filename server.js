const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

const lobbies = {};
const SCORES_FILE = "./scores.json";
let scores = {};

// Load saved scores
if (fs.existsSync(SCORES_FILE)) {
  scores = JSON.parse(fs.readFileSync(SCORES_FILE, "utf-8"));
}

function createDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw2"];
  const wilds = ["wild", "wild_draw4"];
  const deck = [];

  colors.forEach(color => {
    values.forEach(value => {
      const card = `${color}_${value}`;
      deck.push(card);
      if (value !== "0") deck.push(card);
    });
  });

  wilds.forEach(w => { for (let i = 0; i < 4; i++) deck.push(w); });
  return shuffle(deck);
}

function shuffle(deck) {
  return deck.sort(() => Math.random() - 0.5);
}

function emitState(lobby) {
  const { id, players, hands, discardPile, currentTurn, direction, chosenColor } = lobby;
  io.to(id).emit("state", {
    players: Object.values(players).map(p => ({
      id: p.id, name: p.name,
      handSize: lobby.hands[p.id].length,
      score: scores[p.name] || 0
    })),
    hands,
    discardPile,
    currentTurn,
    direction,
    chosenColor
  });
}

function nextPlayer(lobby, skip = 0) {
  const ids = lobby.turnOrder;
  const index = ids.indexOf(lobby.currentTurn);
  const offset = (lobby.direction === 1) ? 1 + skip : -1 - skip;
  const nextIdx = (index + offset + ids.length) % ids.length;
  lobby.currentTurn = ids[nextIdx];
}

function calculatePoints(hand) {
  return hand.reduce((sum, card) => {
    if (!card) return sum;
    if (/^\w+_\d$/.test(card)) return sum + parseInt(card.split("_")[1]);
    if (card.includes("draw2") || card.includes("reverse") || card.includes("skip")) return sum + 20;
    if (card.includes("wild")) return sum + 50;
    return sum;
  }, 0);
}

function resetLobby(lobby) {
  lobby.deck = shuffle(createDeck());
  lobby.discardPile = [lobby.deck.pop()];
  lobby.chosenColor = null;
  lobby.hands = {};
  lobby.turnOrder.forEach(id => {
    lobby.hands[id] = lobby.deck.splice(0, 7);
  });
}

function endRound(lobby, winnerId) {
  const winner = lobby.players[winnerId];
  const others = lobby.turnOrder.filter(id => id !== winnerId);
  const earned = others.reduce((total, id) => total + calculatePoints(lobby.hands[id]), 0);
  scores[winner.name] = (scores[winner.name] || 0) + earned;
  fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2));

  io.to(lobby.id).emit("message", { from: "SUE", text: `🎉 ${winner.name} wins the round and earns ${earned} points!` });
  resetLobby(lobby);
}

function autoKick(socket, lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby || !lobby.players[socket.id]) return;

  const player = lobby.players[socket.id];
  delete lobby.players[socket.id];
  delete lobby.hands[socket.id];
  lobby.turnOrder = lobby.turnOrder.filter(id => id !== socket.id);

  if (Object.keys(lobby.players).length < 2) {
    delete lobbies[lobbyId];
  }

  io.to(lobbyId).emit("message", { from: "SUE", text: `${player.name} was removed due to inactivity.` });
  emitState(lobby);
}

function setTurnTimer(socket, lobby) {
  clearTimeout(lobby.timeout);
  lobby.timeout = setTimeout(() => {
    if (!lobby) return;
    io.to(lobby.id).emit("message", { from: "SUE", text: `⏰ ${lobby.players[socket.id]?.name || 'Someone'} took too long.` });
    lobby.hands[socket.id].push(lobby.deck.pop());
    lobby.missedTurns[socket.id] = (lobby.missedTurns[socket.id] || 0) + 1;

    if (lobby.missedTurns[socket.id] >= 3) {
      autoKick(socket, lobby.id);
    } else {
      nextPlayer(lobby);
      emitState(lobby);
      setTurnTimer(socket, lobby);
    }
  }, 60000);
}

io.on("connection", (socket) => {
  socket.on("join", ({ name, lobby }) => {
    if (!name || !lobby) return;
    socket.join(lobby);

    if (!lobbies[lobby]) {
      lobbies[lobby] = {
        id: lobby,
        players: {},
        hands: {},
        turnOrder: [],
        deck: shuffle(createDeck()),
        discardPile: [],
        direction: 1,
        currentTurn: null,
        chosenColor: null,
        missedTurns: {}
      };
    }

    const room = lobbies[lobby];
    room.players[socket.id] = { id: socket.id, name };
    room.turnOrder.push(socket.id);
    room.hands[socket.id] = room.deck.splice(0, 7);

    if (!room.currentTurn) {
      room.discardPile.push(room.deck.pop());
      room.currentTurn = socket.id;
    }

    emitState(room);
    io.to(lobby).emit("message", { from: "SUE", text: `${name} joined the lobby.` });
    setTurnTimer(socket, room);
  });

  socket.on("playCard", ({ lobby, card, chosenColor, saidUNO }) => {
    const room = lobbies[lobby];
    if (!room) return;
    const hand = room.hands[socket.id];
    const top = room.discardPile[room.discardPile.length - 1];
    const [topColor, topVal] = top.split("_");
    const [cColor, cVal] = card.split("_");

    if (socket.id !== room.currentTurn) return;

    const playable = (
      cColor === topColor || cVal === topVal ||
      cColor === "wild" || room.chosenColor === cColor
    );

    if (!playable) return;

    const index = hand.indexOf(card);
    if (index !== -1) hand.splice(index, 1);
    room.discardPile.push(card);
    room.chosenColor = (cColor === "wild") ? chosenColor : null;

    // Apply special effects
    if (cVal === "reverse") room.direction *= -1;
    if (cVal === "skip") nextPlayer(room, 1);
    if (cVal === "draw2") {
      nextPlayer(room);
      room.hands[room.currentTurn].push(room.deck.pop(), room.deck.pop());
    }
    if (cVal === "draw4") {
      nextPlayer(room);
      room.hands[room.currentTurn].push(room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop());
    }

    if (hand.length === 1 && !saidUNO) {
      hand.push(room.deck.pop(), room.deck.pop());
      io.to(lobby).emit("message", { from: "SUE", text: `${room.players[socket.id].name} forgot to call UNO! Drew 2 cards.` });
    }

    if (hand.length === 0) {
      endRound(room, socket.id);
    } else {
      nextPlayer(room);
      emitState(room);
      setTurnTimer(socket, room);
    }
  });

  socket.on("drawCard", ({ lobby }) => {
    const room = lobbies[lobby];
    if (!room || socket.id !== room.currentTurn) return;
    room.hands[socket.id].push(room.deck.pop());
    nextPlayer(room);
    emitState(room);
    setTurnTimer(socket, room);
  });

  socket.on("disconnect", () => {
    for (let id in lobbies) {
      const room = lobbies[id];
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        delete room.hands[socket.id];
        room.turnOrder = room.turnOrder.filter(pid => pid !== socket.id);
        if (room.turnOrder.length === 0) delete lobbies[id];
        else emitState(room);
      }
    }
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/admin-state", (req, res) => {
  const result = Object.values(lobbies).map(lobby => ({
    id: lobby.id,
    players: Object.values(lobby.players).map(p => ({
      id: p.id,
      name: p.name,
      handSize: lobby.hands[p.id]?.length || 0,
      score: scores[p.name] || 0
    }))
  }));
  res.json(result);
});

app.post("/admin/kick/:lobby/:id", (req, res) => {
  const { lobby, id } = req.params;
  if (lobbies[lobby] && lobbies[lobby].players[id]) {
    delete lobbies[lobby].players[id];
    delete lobbies[lobby].hands[id];
    lobbies[lobby].turnOrder = lobbies[lobby].turnOrder.filter(pid => pid !== id);
    emitState(lobbies[lobby]);
  }
  res.sendStatus(200);
});

app.post("/admin/close/:lobby", (req, res) => {
  delete lobbies[req.params.lobby];
  res.sendStatus(200);
});

server.listen(PORT, () => {
  console.log(`UNO server running on port ${PORT}`);
});
