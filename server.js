
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const lobbies = {};
const cardFiles = [
  "red_0.png", "red_1.png", "blue_0.png", "blue_1.png",
  "green_0.png", "yellow_0.png", "wild.png", "wild_draw4.png"
];

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function drawCard(deck, tablePile) {
  if (deck.length === 0) {
    const top = tablePile.pop();
    deck = [...tablePile];
    shuffle(deck);
    tablePile.length = 0;
    tablePile.push(top);
  }
  return deck.pop();
}

function getGameState(lobby) {
  return {
    tablePile: lobby.tablePile,
    players: lobby.playerOrder.map(id => ({
      id,
      name: lobby.players[id].name,
      handCount: lobby.players[id].hand.length
    })),
    currentPlayer: lobby.playerOrder[lobby.currentPlayerIndex]
  };
}

function startGameIfReady(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby || lobby.playerOrder.length < 2) return;

  lobby.deck = [...cardFiles];
  shuffle(lobby.deck);
  lobby.tablePile = [drawCard(lobby.deck, lobby.tablePile)];
  lobby.currentPlayerIndex = 0;

  for (const id of lobby.playerOrder) {
    lobby.players[id].hand = [];
    for (let i = 0; i < 7; i++) {
      lobby.players[id].hand.push(drawCard(lobby.deck, lobby.tablePile));
    }
    io.to(id).emit('yourHand', lobby.players[id].hand);
  }

  io.to(lobbyId).emit('updateGame', getGameState(lobby));
}

io.on('connection', socket => {
  socket.on('joinLobby', ({ lobbyId, name }) => {
    if (!/^[a-zA-Z0-9 _]{1,20}$/.test(name)) {
      socket.emit('errorMessage', 'Invalid name');
      return;
    }

    if (!lobbies[lobbyId]) {
      lobbies[lobbyId] = {
        players: {},
        playerOrder: [],
        deck: [],
        tablePile: [],
        currentPlayerIndex: 0,
        chat: [],
        lastActivity: Date.now()
      };
    }

    const lobby = lobbies[lobbyId];
    lobby.players[socket.id] = { name, hand: [] };
    lobby.playerOrder.push(socket.id);
    lobby.lastActivity = Date.now();

    socket.join(lobbyId);
    socket.lobbyId = lobbyId;

    startGameIfReady(lobbyId);
  });

  socket.on('playCard', ({ card, chosenColor }) => {
    const lobby = lobbies[socket.lobbyId];
    if (!lobby || socket.id !== lobby.playerOrder[lobby.currentPlayerIndex]) return;

    const player = lobby.players[socket.id];
    const index = player.hand.indexOf(card);
    if (index === -1) return;

    player.hand.splice(index, 1);
    const playedCard = card.startsWith('wild') && chosenColor ? `${chosenColor}_wild.png` : card;
    lobby.tablePile.push(playedCard);
    lobby.currentPlayerIndex = (lobby.currentPlayerIndex + 1) % lobby.playerOrder.length;
    io.to(socket.lobbyId).emit('updateGame', getGameState(lobby));
    io.to(socket.id).emit('yourHand', player.hand);
  });

  socket.on('drawCard', () => {
    const lobby = lobbies[socket.lobbyId];
    if (!lobby) return;

    const card = drawCard(lobby.deck, lobby.tablePile);
    lobby.players[socket.id].hand.push(card);
    io.to(socket.id).emit('yourHand', lobby.players[socket.id].hand);
  });

  socket.on('chatMessage', msg => {
    const lobby = lobbies[socket.lobbyId];
    if (!lobby) return;

    lobby.chat.push({ id: socket.id, msg });
    io.to(socket.lobbyId).emit('chatUpdate', { id: socket.id, msg });
  });

  socket.on('disconnect', () => {
    const lobby = lobbies[socket.lobbyId];
    if (!lobby) return;

    delete lobby.players[socket.id];
    lobby.playerOrder = lobby.playerOrder.filter(id => id !== socket.id);
  });
});

app.use(express.static(path.join(__dirname, 'public')));
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
