const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const LOBBIES = {};
const COLORS = ["red", "yellow", "green", "blue"];
const VALUES = ["0","1","2","3","4","5","6","7","8","9","skip","reverse","draw2"];
const SPECIALS = ["wild","wild_draw4"];

function buildDeck() {
  let deck = [];
  for (let color of COLORS) {
    for (let value of VALUES) {
      // 2 of each (except 0, only one)
      let count = value === "0" ? 1 : 2;
      for (let i=0; i<count; ++i)
        deck.push(`${color}_${value}.png`);
    }
  }
  // Wild cards
  for (let i=0; i<4; ++i) {
    deck.push("wild.png", "wild_draw4.png");
  }
  return deck;
}
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}
function draw(deck, n=1) {
  return deck.splice(-n, n);
}
function nextPlayerIdx(lobby, skip=0) {
  let l = lobby;
  let idx = l.currentPlayerIdx;
  let count = l.playerOrder.length;
  let inc = l.direction * (1 + skip);
  return ((idx + inc) % count + count) % count;
}
function validPlay(top, candidate, requiredColor=null) {
  if (!candidate) return false;
  if (candidate.startsWith("wild")) return true;
  let [candColor, candVal] = candidate.split("_");
  if (requiredColor && candColor !== requiredColor) return false;
  let [topColor, topVal] = top.split("_");
  return candColor === topColor || candVal === topVal;
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

io.on("connection", socket => {
  // For joining lobby
  socket.on("joinLobby", ({ lobbyId, name }) => {
    if (!/^[a-zA-Z0-9 _]{1,20}$/.test(name)) return;
    if (!LOBBIES[lobbyId]) {
      LOBBIES[lobbyId] = {
        players: {},
        playerOrder: [],
        deck: [],
        discard: [],
        hands: {},
        currentPlayerIdx: 0,
        direction: 1,
        requiredColor: null,
        drawStack: 0,
        chat: [],
        started: false
      };
    }
    const lobby = LOBBIES[lobbyId];
    if (!lobby.players[socket.id]) {
      lobby.players[socket.id] = name;
      lobby.playerOrder.push(socket.id);
      lobby.hands[socket.id] = [];
      socket.join(lobbyId);
    }
    // Start game when at least 2 players
    if (!lobby.started && lobby.playerOrder.length >= 2) {
      startGame(lobbyId);
    }
    updateAll(lobbyId);
  });

  socket.on("playCard", ({ card, chosenColor }) => {
    const lobbyId = findLobby(socket.id);
    if (!lobbyId) return;
    const l = LOBBIES[lobbyId];
    if (!l || l.playerOrder[l.currentPlayerIdx] !== socket.id) return;

    let hand = l.hands[socket.id];
    let idx = hand.indexOf(card);
    if (idx === -1) return;
    let top = l.discard[l.discard.length - 1];
    // Check validity
    if (!validPlay(top, card, l.requiredColor)) return;

    // Remove from hand, add to pile
    hand.splice(idx, 1);
    l.discard.push(card);

    // Reset requiredColor unless wild just played
    l.requiredColor = null;

    // Apply card effects
    let [color, val] = card.replace(".png","").split("_");
    let skip = 0;
    let drawN = 0;
    if (val === "skip") skip = 1;
    if (val === "reverse") {
      l.direction *= -1;
      if (l.playerOrder.length === 2) skip = 1; // acts as skip in 2P
    }
    if (val === "draw2") {
      l.drawStack += 2;
      skip = 1;
    }
    if (card === "wild.png") {
      if (!chosenColor || !COLORS.includes(chosenColor)) return;
      l.requiredColor = chosenColor;
    }
    if (card === "wild_draw4.png") {
      if (!chosenColor || !COLORS.includes(chosenColor)) return;
      l.requiredColor = chosenColor;
      l.drawStack += 4;
      skip = 1;
    }

    // Win condition
    if (hand.length === 0) {
      io.to(lobbyId).emit('gameOver', { winner: l.players[socket.id] });
      delete LOBBIES[lobbyId];
      return;
    }

    // Advance turn
    l.currentPlayerIdx = nextPlayerIdx(l, skip);

    // If drawStack is active, next player must draw
    if (l.drawStack > 0) {
      let nextId = l.playerOrder[l.currentPlayerIdx];
      l.hands[nextId].push(...draw(l.deck, l.drawStack));
      l.drawStack = 0;
      l.currentPlayerIdx = nextPlayerIdx(l); // After drawing, skip their turn
    }
    updateAll(lobbyId);
  });

  socket.on("drawCard", () => {
    const lobbyId = findLobby(socket.id);
    if (!lobbyId) return;
    const l = LOBBIES[lobbyId];
    if (!l || l.playerOrder[l.currentPlayerIdx] !== socket.id) return;
    l.hands[socket.id].push(...draw(l.deck, 1));
    l.currentPlayerIdx = nextPlayerIdx(l);
    updateAll(lobbyId);
  });

  socket.on("chatMessage", msg => {
    const lobbyId = findLobby(socket.id);
    if (!lobbyId) return;
    const l = LOBBIES[lobbyId];
    l.chat.push({ sender: l.players[socket.id], msg });
    io.to(lobbyId).emit("chatUpdate", { sender: l.players[socket.id], msg });
  });

  socket.on("disconnect", () => {
    for (const lobbyId in LOBBIES) {
      const l = LOBBIES[lobbyId];
      if (l.players[socket.id]) {
        delete l.players[socket.id];
        l.playerOrder = l.playerOrder.filter(id => id !== socket.id);
        delete l.hands[socket.id];
        if (l.playerOrder.length < 2) {
          io.to(lobbyId).emit('gameOver', { winner: "Not enough players" });
          delete LOBBIES[lobbyId];
        } else {
          updateAll(lobbyId);
        }
      }
    }
  });
});

function startGame(lobbyId) {
  const l = LOBBIES[lobbyId];
  l.deck = buildDeck();
  shuffle(l.deck);
  for (const id of l.playerOrder) {
    l.hands[id] = draw(l.deck, 7);
  }
  l.discard = [draw(l.deck, 1)[0]];
  l.currentPlayerIdx = 0;
  l.direction = 1;
  l.requiredColor = null;
  l.drawStack = 0;
  l.started = true;
}
function updateAll(lobbyId) {
  const l = LOBBIES[lobbyId];
  if (!l) return;
  // Send each player their hand, table, and info about others
  for (const id of l.playerOrder) {
    let others = l.playerOrder.filter(pid => pid !== id).map(pid => ({
      name: l.players[pid],
      count: l.hands[pid].length
    }));
    io.to(id).emit("gameState", {
      hand: l.hands[id],
      table: l.discard,
      others,
      currentPlayer: l.players[l.playerOrder[l.currentPlayerIdx]],
      isMyTurn: l.playerOrder[l.currentPlayerIdx] === id,
      chat: l.chat
    });
  }
}
function findLobby(socketId) {
  for (const id in LOBBIES)
    if (LOBBIES[id].players[socketId])
      return id;
  return null;
}

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
