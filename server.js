const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const lobbies = {};

io.on("connection", (socket) => {
  socket.on("joinLobby", ({ name, lobbyId }) => {
    if (!lobbies[lobbyId]) {
      lobbies[lobbyId] = { players: [], table: [], turn: 0 };
    }

    const player = {
      id: socket.id,
      name,
      hand: [],
      score: 0,
      missedTurns: 0
    };

    const lobby = lobbies[lobbyId];
    lobby.players.push(player);

    // Deal cards
    if (player.hand.length === 0) {
      const deck = generateDeck();
      shuffle(deck);
      player.hand = deck.splice(0, 7);
      if (lobby.table.length === 0) lobby.table.push(deck.pop());
      lobby.deck = deck;
    }

    socket.join(lobbyId);
    socket.lobbyId = lobbyId;
    socket.playerName = name;

    updateLobby(lobbyId);
  });

  socket.on("playCard", ({ card, chosenColor }) => {
    const lobby = lobbies[socket.lobbyId];
    const player = lobby.players.find((p) => p.id === socket.id);
    if (!player || !player.hand.includes(card)) return;

    lobby.table.push(card);
    player.hand = player.hand.filter((c) => c !== card);

    if (card.startsWith("wild") && chosenColor) {
      lobby.lastWildColor = chosenColor;
    } else {
      lobby.lastWildColor = null;
    }

    lobby.turn = (lobby.turn + 1) % lobby.players.length;
    updateLobby(socket.lobbyId);
  });

  socket.on("drawCard", () => {
    const lobby = lobbies[socket.lobbyId];
    const player = lobby.players.find((p) => p.id === socket.id);
    if (lobby.deck.length > 0) {
      const card = lobby.deck.pop();
      player.hand.push(card);
    }
    lobby.turn = (lobby.turn + 1) % lobby.players.length;
    updateLobby(socket.lobbyId);
  });

  socket.on("leaveGame", () => {
    const lobbyId = socket.lobbyId;
    const lobby = lobbies[lobbyId];
    if (lobby) {
      lobby.players = lobby.players.filter((p) => p.id !== socket.id);
      if (lobby.players.length === 0) {
        delete lobbies[lobbyId];
      } else {
        updateLobby(lobbyId);
      }
    }
  });

  socket.on("chat", (msg) => {
    io.to(socket.lobbyId).emit("chat", { name: socket.playerName, message: msg });
  });

  socket.on("disconnect", () => {
    const lobbyId = socket.lobbyId;
    if (lobbies[lobbyId]) {
      lobbies[lobbyId].players = lobbies[lobbyId].players.filter(p => p.id !== socket.id);
      if (lobbies[lobbyId].players.length === 0) delete lobbies[lobbyId];
      else updateLobby(lobbyId);
    }
  });
});

function updateLobby(lobbyId) {
  const lobby = lobbies[lobbyId];
  lobby.players.forEach((player, index) => {
    io.to(player.id).emit("gameState", {
      hand: player.hand,
      table: lobby.table,
      isMyTurn: index === lobby.turn,
      lastWildColor: lobby.lastWildColor,
      currentPlayer: lobby.players[lobby.turn].name,
      others: lobby.players
        .filter((p) => p.id !== player.id)
        .map((p) => ({ name: p.name, count: p.hand.length, score: p.score }))
    });
  });
}

function generateDeck() {
  const colors = ["red", "green", "blue", "yellow"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw"];
  const deck = [];

  for (const color of colors) {
    for (const value of values) {
      const card = `${color}_${value}.png`;
      deck.push(card, card);
    }
  }

  deck.push("wild.png", "wild.png", "wild_draw4.png", "wild_draw4.png");
  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
