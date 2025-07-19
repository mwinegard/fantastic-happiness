const express = require("express");
const basicAuth = require("express-basic-auth");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const lobbies = {};

app.use("/admin.html", basicAuth({
  users: { 'admin': 'changeThisPassword' },
  challenge: true
}));

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  socket.on("joinLobby", ({ lobbyId, playerName }) => {
    if (!lobbyId || typeof lobbyId !== "string") return;

    let name = typeof playerName === "string" ? playerName.trim() : "";
    if (name.length === 0) name = "Player";

    if (!lobbies[lobbyId]) {
      lobbies[lobbyId] = { players: [], scores: {}, turnIndex: 0 };
    }

    const alreadyJoined = lobbies[lobbyId].players.find(p => p.id === socket.id);
    if (alreadyJoined) return;

    const player = {
      id: socket.id,
      name,
      score: 0,
      hand: [],
      missedTurns: 0
    };

    lobbies[lobbyId].players.push(player);
    socket.join(lobbyId);

    // Send back a minimal game state for now
    socket.emit("gameState", {
      players: lobbies[lobbyId].players.map(p => ({
        id: p.id,
        name: p.name,
        score: p.score,
        handCount: p.hand.length
      })),
      yourId: socket.id,
      hand: [],
      currentTurn: lobbies[lobbyId].players[0]?.id || null
    });

    updateLobby(lobbyId);
  });

  socket.on("disconnect", () => {
    for (const lobbyId in lobbies) {
      const lobby = lobbies[lobbyId];
      const index = lobby.players.findIndex((p) => p.id === socket.id);
      if (index !== -1) {
        lobby.players.splice(index, 1);
        if (lobby.players.length === 0) {
          delete lobbies[lobbyId];
        } else {
          updateLobby(lobbyId);
        }
        break;
      }
    }
  });

  function updateLobby(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (lobby) {
      io.to(lobbyId).emit("gameState", {
        players: lobby.players.map(p => ({
          id: p.id,
          name: p.name,
          score: p.score,
          handCount: p.hand.length
        })),
        currentTurn: lobby.players[lobby.turnIndex]?.id || null
      });
    }
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
