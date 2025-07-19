const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const lobbies = {};

io.on('connection', (socket) => {
  console.log(`🔌 ${socket.id} connected`);

  socket.on('joinLobby', ({ lobbyId, playerName }) => {
    socket.join(lobbyId);
    if (!lobbies[lobbyId]) lobbies[lobbyId] = { players: [] };

    const player = { id: socket.id, name: playerName, hand: [] };
    lobbies[lobbyId].players.push(player);

    io.to(lobbyId).emit('updateLobby', lobbies[lobbyId]);
    socket.emit('joinedLobby', { playerId: socket.id });
  });

  socket.on('sendChat', ({ lobbyId, message }) => {
    io.to(lobbyId).emit('chatMessage', { sender: socket.id, message });
  });

  socket.on('disconnect', () => {
    console.log(`❌ ${socket.id} disconnected`);
    for (const lobbyId in lobbies) {
      lobbies[lobbyId].players = lobbies[lobbyId].players.filter(p => p.id !== socket.id);
      io.to(lobbyId).emit('updateLobby', lobbies[lobbyId]);
    }
  });
});

server.listen(3000, () => {
  console.log('✅ Server running on http://localhost:3000');
});
