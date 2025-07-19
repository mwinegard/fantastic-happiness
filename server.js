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
// Deck generation
function createDeck() {
  const colors = ['red', 'green', 'blue', 'yellow'];
  const values = ['0', '1','2','3','4','5','6','7','8','9', 'skip', 'reverse', 'draw2'];
  const deck = [];

  colors.forEach(color => {
    values.forEach(value => {
      deck.push({ color, value });
      if (value !== '0') deck.push({ color, value }); // double 1-9 & actions
    });
  });

  // Wilds
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'black', value: 'wild' });
    deck.push({ color: 'black', value: 'draw4' });
  }

  return shuffle(deck);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

const lobbies = {}; // update this object shape

io.on('connection', (socket) => {
  console.log(`🔌 ${socket.id} connected`);

  socket.on('joinLobby', ({ lobbyId, playerName }) => {
    socket.join(lobbyId);

    if (!lobbies[lobbyId]) {
      lobbies[lobbyId] = {
        players: [],
        deck: [],
        pile: [],
        currentPlayer: 0,
        started: false
      };
    }

    const player = {
      id: socket.id,
      name: playerName,
      hand: [],
      missedTurns: 0
    };

    lobbies[lobbyId].players.push(player);
    io.to(lobbyId).emit('updateLobby', lobbies[lobbyId]);

    // Start game if enough players
    if (!lobbies[lobbyId].started && lobbies[lobbyId].players.length >= 2) {
      startGame(lobbyId);
    }

    socket.emit('joinedLobby', { playerId: socket.id });
  });

  socket.on('playCard', ({ lobbyId, playerId, card }) => {
    const lobby = lobbies[lobbyId];
    const player = lobby.players.find(p => p.id === playerId);
    const top = lobby.pile[lobby.pile.length - 1];

    const isValid = card.color === top.color || card.value === top.value || card.color === 'black';
    if (isValid && player.id === lobby.players[lobby.currentPlayer].id) {
      // Remove card from player
      player.hand = player.hand.filter(c => !(c.color === card.color && c.value === card.value));
      lobby.pile.push(card);
      lobby.currentPlayer = (lobby.currentPlayer + 1) % lobby.players.length;

      io.to(lobbyId).emit('gameState', {
        pile: lobby.pile,
        players: lobby.players.map(p => ({ id: p.id, name: p.name, handSize: p.hand.length })),
        currentPlayer: lobby.players[lobby.currentPlayer].id
      });

      checkWin(lobbyId, player);
    }
  });

  socket.on('disconnect', () => {
    for (const lobbyId in lobbies) {
      lobbies[lobbyId].players = lobbies[lobbyId].players.filter(p => p.id !== socket.id);
      io.to(lobbyId).emit('updateLobby', lobbies[lobbyId]);
    }
  });
});

function startGame(lobbyId) {
  const lobby = lobbies[lobbyId];
  lobby.deck = createDeck();

  // Deal hands
  lobby.players.forEach(p => {
    p.hand = lobby.deck.splice(0, 7);
  });

  lobby.pile = [lobby.deck.pop()];
  lobby.started = true;

  io.to(lobbyId).emit('gameState', {
    pile: lobby.pile,
    players: lobby.players.map(p => ({ id: p.id, name: p.name, handSize: p.hand.length })),
    currentPlayer: lobby.players[lobby.currentPlayer].id
  });
}

function checkWin(lobbyId, player) {
  if (player.hand.length === 0) {
    io.to(lobbyId).emit('gameOver', { winner: player.name });
  }
}
