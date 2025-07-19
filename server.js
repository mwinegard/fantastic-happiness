const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "public")));

let lobbies = {};
let topScores = {};

const COLORS = ["red", "blue", "green", "yellow"];
const WILDS = ["wild", "wild_draw4"];
const SPECIALS = ["skip", "reverse", "draw"];

function getCardName(card) {
  return `${card.color}_${card.value}.png`;
}

function createDeck() {
  const deck = [];
  COLORS.forEach(color => {
    for (let i = 0; i <= 9; i++) deck.push({ color, value: i });
    SPECIALS.forEach(val => deck.push({ color, value: val }, { color, value: val }));
  });
  WILDS.forEach(value => {
    for (let i = 0; i < 4; i++) deck.push({ color: "wild", value });
  });
  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function dealCards(deck, count) {
  const hand = [];
  for (let i = 0; i < count; i++) hand.push(deck.pop());
  return hand;
}

function emitState(lobby) {
  io.to(lobby.id).emit("gameState", {
    players: lobby.players.map(p => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      hand: p.id === lobby.turn ? p.hand : undefined,
      score: p.score || 0
    })),
    discardPile: lobby.discardPile,
    currentColor: lobby.currentColor,
    currentPlayer: lobby.players[lobby.turn]?.id,
    drawPileCount: lobby.deck.length
  });
}

function sendSystemMessage(lobbyId, message) {
  io.to(lobbyId).emit("chat message", {
    name: "SUE",
    color: "darkblue",
    text: message,
    isSystem: true
  });
}

function startGame(lobby) {
  lobby.deck = createDeck();
  shuffle(lobby.deck);
  lobby.players.forEach(p => {
    p.hand = dealCards(lobby.deck, 7);
    p.score = 0;
  });

  const firstCard = lobby.deck.pop();
  lobby.discardPile = [firstCard];
  lobby.currentColor = firstCard.color;
  lobby.turn = 0;

  sendSystemMessage(lobby.id, "Game has started!");
  emitState(lobby);
}

function removePlayer(playerId, lobby) {
  const index = lobby.players.findIndex(p => p.id === playerId);
  if (index !== -1) {
    const leavingPlayer = lobby.players.splice(index, 1)[0];
    const cards = leavingPlayer.hand || [];
    while (cards.length > 0) {
      lobby.deck.push(cards.pop());
    }
    shuffle(lobby.deck);
    sendSystemMessage(lobby.id, `${leavingPlayer.name} has left the game.`);
  }
}

io.on("connection", (socket) => {
  socket.on("joinLobby", ({ name, lobbyId, color }) => {
    if (!lobbies[lobbyId]) {
      lobbies[lobbyId] = {
        id: lobbyId,
        players: [],
        deck: [],
        discardPile: [],
        turn: 0
      };
    }

    const lobby = lobbies[lobbyId];
    if (lobby.players.length >= 10) {
      socket.emit("lobbyFull");
      return;
    }

    const player = {
      id: socket.id,
      name,
      hand: [],
      score: 0,
      color
    };

    lobby.players.push(player);
    socket.join(lobbyId);
    socket.lobbyId = lobbyId;

    sendSystemMessage(lobbyId, `${name} joined the game.`);

    if (lobby.players.length >= 2) {
      sendSystemMessage(lobbyId, "Enough players. Game starting in 5 seconds...");
      setTimeout(() => startGame(lobby), 5000);
    } else {
      sendSystemMessage(lobbyId, "Waiting for more players...");
    }
  });

  socket.on("chat message", ({ lobbyId, name, text, color }) => {
    if (!lobbies[lobbyId]) return;
    io.to(lobbyId).emit("chat message", { name, text, color });
  });

  socket.on("playCard", ({ card }) => {
    const lobby = lobbies[socket.lobbyId];
    if (!lobby) return;

    const player = lobby.players.find(p => p.id === socket.id);
    if (!player) return;

    const index = player.hand.findIndex(c => c.color === card.color && c.value === card.value);
    if (index !== -1) {
      lobby.discardPile.push(card);
      lobby.currentColor = card.color;
      player.hand.splice(index, 1);
      lobby.turn = (lobby.turn + 1) % lobby.players.length;

      emitState(lobby);
    }
  });

  socket.on("drawCard", () => {
    const lobby = lobbies[socket.lobbyId];
    const player = lobby?.players.find(p => p.id === socket.id);
    if (player && lobby.deck.length) {
      const drawn = lobby.deck.pop();
      player.hand.push(drawn);
      emitState(lobby);
    }
  });

  socket.on("disconnect", () => {
    const lobby = lobbies[socket.lobbyId];
    if (lobby) {
      removePlayer(socket.id, lobby);
      emitState(lobby);
      if (lobby.players.length === 0) {
        delete lobbies[socket.lobbyId];
      }
    }
  });

  // Admin
  socket.on("adminRequestLobbies", () => {
    socket.emit("adminLobbies", lobbies);
  });

  socket.on("adminKickPlayer", ({ lobbyId, playerId }) => {
    const lobby = lobbies[lobbyId];
    if (lobby) {
      removePlayer(playerId, lobby);
      emitState(lobby);
    }
  });

  socket.on("adminCloseLobby", (lobbyId) => {
    delete lobbies[lobbyId];
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
