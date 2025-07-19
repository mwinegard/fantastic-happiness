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

// 🔐 Protect admin.html
app.use("/admin.html", basicAuth({
  users: { 'admin': 'changeThisPassword' }, // <- change this
  challenge: true,
  unauthorizedResponse: () => "Unauthorized"
}));

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  socket.on("joinLobby", ({ lobbyId, playerName }) => {
    if (!lobbies[lobbyId]) {
      lobbies[lobbyId] = { players: [], scores: {}, turnIndex: 0 };
    }

    const player = {
      id: socket.id,
      name: playerName,
      score: 0,
      hand: [],
      missedTurns: 0
    };

    lobbies[lobbyId].players.push(player);
    socket.join(lobbyId);
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

  // Admin endpoints
  socket.on("adminRequestLobbies", () => {
    const summary = {};
    for (const [id, lobby] of Object.entries(lobbies)) {
      summary[id] = {
        players: lobby.players.map((p) => ({
          id: p.id,
          name: p.name,
          score: p.score
        }))
      };
    }
    socket.emit("adminLobbies", summary);
  });

  socket.on("adminCloseLobby", (lobbyId) => {
    if (lobbies[lobbyId]) {
      lobbies[lobbyId].players.forEach((p) => {
        io.to(p.id).emit("gameState", { message: "Lobby closed by admin." });
        io.sockets.sockets.get(p.id)?.disconnect(true);
      });
      delete lobbies[lobbyId];
    }
  });

  socket.on("adminKickPlayer", ({ lobbyId, playerId }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;
    const player = lobby.players.find((p) => p.id === playerId);
    if (player) {
      io.to(playerId).emit("gameState", { message: "You were removed by admin." });
      io.sockets.sockets.get(playerId)?.disconnect(true);
      lobby.players = lobby.players.filter((p) => p.id !== playerId);
      if (lobby.players.length === 0) delete lobbies[lobbyId];
      else updateLobby(lobbyId);
    }
  });
});

function updateLobby(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (lobby) {
    io.to(lobbyId).emit("gameState", {
      players: lobby.players.map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        handCount: p.hand?.length || 0
      }))
    });
  }
}

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
