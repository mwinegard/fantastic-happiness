const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const lobbies = {};
const socketToLobby = {};

function createLobby(id) {
  return {
    id,
    players: [],
    started: false,
    drawPile: [],
    discardPile: [],
    turnIndex: 0,
  };
}

function createPlayer(id, name) {
  return {
    id,
    name,
    hand: [],
    color: getRandomColor(),
    missedTurns: 0,
    score: 0
  };
}

function getRandomColor() {
  const colors = ["🔴", "🟢", "🔵", "🟡"];
  return colors[Math.floor(Math.random() * colors.length)];
}

function emitState(lobby) {
  io.to(lobby.id).emit("state", getLobbyState(lobby));
}

function getLobbyState(lobby) {
  return {
    players: lobby.players.map((p) => ({
      id: p.id,
      name: p.name,
      hand: p.hand.length,
      color: p.color,
      score: p.score
    })),
    drawPileCount: lobby.drawPile.length,
    topCard: lobby.discardPile[lobby.discardPile.length - 1] || null,
    currentTurnId: lobby.players[lobby.turnIndex]?.id
  };
}

io.on("connection", (socket) => {
  socket.on("join", ({ lobbyId, playerName }) => {
    if (!lobbies[lobbyId]) lobbies[lobbyId] = createLobby(lobbyId);

    const lobby = lobbies[lobbyId];

    if (lobby.players.length >= 10) {
      socket.emit("chat", { sender: "SUE", message: "Lobby is full. Please join another." });
      return;
    }

    const player = createPlayer(socket.id, playerName);
    lobby.players.push(player);
    socket.join(lobbyId);
    socketToLobby[socket.id] = lobbyId;

    io.to(lobbyId).emit("chat", { sender: "SUE", message: `${player.name} joined the lobby.` });
    emitState(lobby);
  });

  socket.on("disconnect", () => {
    const lobbyId = socketToLobby[socket.id];
    const lobby = lobbies[lobbyId];
    if (lobby) {
      lobby.players = lobby.players.filter((p) => p.id !== socket.id);
      io.to(lobbyId).emit("chat", { sender: "SUE", message: "A player disconnected." });

      if (lobby.players.length === 0) {
        delete lobbies[lobbyId];
      } else {
        emitState(lobby);
      }
    }
    delete socketToLobby[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
