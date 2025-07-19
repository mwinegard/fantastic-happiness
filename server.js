const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const SCORES_FILE = './scores.json';
function loadScores() {
  if (fs.existsSync(SCORES_FILE)) {
    return JSON.parse(fs.readFileSync(SCORES_FILE));
  }
  return {};
}
function saveScores(scores) {
  fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2));
}

function createDeck() {
  const colors = ['red','green','blue','yellow'];
  const values = ['0','1','2','3','4','5','6','7','8','9','skip','reverse','draw2'];
  const deck = [];
  colors.forEach(color => {
    values.forEach(value => {
      deck.push({ color, value });
      if (value !== '0') deck.push({ color, value });
    });
  });
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'black', value: 'wild' });
    deck.push({ color: 'black', value: 'draw4' });
  }
  return deck.sort(() => Math.random() - 0.5);
}

function isValidMove(card, top) {
  return (
    card.color === top.color ||
    card.value === top.value ||
    card.color === 'black' ||
    (top.color === 'black' && top.chosenColor && card.color === top.chosenColor)
  );
}

function getLobbySummaries() {
  return Object.entries(lobbies).map(([id, lobby]) => ({
    id,
    players: lobby.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      handSize: p.hand.length
    }))
  }));
}

const lobbies = {};
const turnTimers = {};
const unoCalls = {};

io.on('connection', socket => {
  console.log(`🔌 ${socket.id} connected`);
  
  socket.on('joinLobby', ({ lobbyId, playerName }) => {
    socket.join(lobbyId);
    if (!lobbies[lobbyId]) {
      lobbies[lobbyId] = {
        players: [], deck: [], pile: [],
        currentPlayer: 0, started: false
      };
    }
    const player = {
      id: socket.id,
      name: playerName,
      hand: [],
      missedTurns: 0,
      score: 0
    };
    lobbies[lobbyId].players.push(player);
    io.to(lobbyId).emit('updateLobby', lobbies[lobbyId]);

    if (!lobbies[lobbyId].started && lobbies[lobbyId].players.length >= 2) {
      startGame(lobbyId);
    }
    socket.emit('joinedLobby', { playerId: socket.id });
  });

  socket.on('sendChat', ({ lobbyId, message }) => {
    io.to(lobbyId).emit('chatMessage', { sender: socket.id, message });
  });

  socket.on('playCard', ({ lobbyId, playerId, card, chosenColor }) => {
    const lobby = lobbies[lobbyId];
    const player = lobby.players.find(p => p.id === playerId);
    const top = lobby.pile[lobby.pile.length - 1];
    const isTurn = playerId === lobby.players[lobby.currentPlayer].id;
    if (!isTurn || !isValidMove(card, top)) return;

    player.hand = player.hand.filter(c => !(c.color === card.color && c.value === card.value));
    if (card.color === 'black') card.chosenColor = chosenColor;
    lobby.pile.push(card);
    applyCardEffect(card, lobby);

    if (player.hand.length === 1) {
      const called = unoCalls[lobbyId]?.has(playerId);
      if (!called) {
        player.hand.push(...lobby.deck.splice(0, 2));
        io.to(lobbyId).emit('chatMessage', {
          sender: 'SUE',
          message: `${player.name} forgot to call UNO! +2 penalty 🃏`
        });
      }
      unoCalls[lobbyId]?.delete(playerId);
    }

    checkWin(lobbyId, player);
    updateGameState(lobbyId);
  });

  socket.on('callUno', ({ lobbyId, playerId }) => {
    if (!unoCalls[lobbyId]) unoCalls[lobbyId] = new Set();
    unoCalls[lobbyId].add(playerId);
    io.to(lobbyId).emit('chatMessage', {
      sender: 'SUE',
      message: `🚨 ${playerId} called UNO!`
    });
  });

  socket.on('getLobbies', () => {
    socket.emit('lobbyList', getLobbySummaries());
  });

  socket.on('kickPlayer', ({ lobbyId, playerId }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;
    lobby.players = lobby.players.filter(p => p.id !== playerId);
    io.to(lobbyId).emit('chatMessage', {
      sender: 'SUE',
      message: `Player ${playerId} was kicked by admin 🚫`
    });
    updateGameState(lobbyId);
  });

  socket.on('closeLobby', lobbyId => {
    delete lobbies[lobbyId];
    io.to(lobbyId).emit('chatMessage', {
      sender: 'SUE',
      message: `This lobby was closed by admin ❌`
    });
    io.to(lobbyId).emit('forceLeave');
  });

  socket.on('disconnect', () => {
    for (const lid in lobbies) {
      const lobby = lobbies[lid];
      lobby.players = lobby.players.filter(p => p.id !== socket.id);
      clearTimeout(turnTimers[lid]);
      io.to(lid).emit('updateLobby', lobby);
    }
  });
});

function applyCardEffect(card, lobby) {
  const n = lobby.players.length;
  const cp = lobby.currentPlayer;
  let next = (cp + 1) % n;

  switch (card.value) {
    case 'skip': lobby.currentPlayer = (cp + 2) % n; break;
    case 'reverse':
      lobby.players.reverse();
      lobby.currentPlayer = 1 % n;
      break;
    case 'draw2':
      lobby.players[next].hand.push(...lobby.deck.splice(0,2));
      lobby.currentPlayer = (next + 1) % n;
      break;
    case 'draw4':
      lobby.players[next].hand.push(...lobby.deck.splice(0,4));
      lobby.currentPlayer = (next + 1) % n;
      break;
    default:
      lobby.currentPlayer = next;
  }
}

function startGame(lobbyId) {
  const lobby = lobbies[lobbyId];
  lobby.deck = createDeck();
  lobby.started = true;
  lobby.players.forEach(p => {
    p.hand = lobby.deck.splice(0,7);
    p.missedTurns = 0;
  });
  
  let first = lobby.deck.pop();
  while (first.color === 'black') {
    lobby.deck.unshift(first);
    first = lobby.deck.pop();
  }
  lobby.pile = [first];
  updateGameState(lobbyId);
}

function updateGameState(lobbyId) {
  const lobby = lobbies[lobbyId];
  const currentId = lobby.players[lobby.currentPlayer]?.id;
  clearTimeout(turnTimers[lobbyId]);
  turnTimers[lobbyId] = setTimeout(() => {
    autoDraw(lobbyId, currentId);
  }, 60000);

  io.to(lobbyId).emit('gameState', {
    pile: lobby.pile,
    players: lobby.players.map(p => ({
      id: p.id,
      name: p.name,
      handSize: p.hand.length,
      score: p.score
    })),
    currentPlayer: currentId
  });
  if (unoCalls[lobbyId]) unoCalls[lobbyId].clear();
}

function autoDraw(lobbyId, playerId) {
  const lobby = lobbies[lobbyId];
  const player = lobby.players.find(p => p.id === playerId);
  if (!player) return;
  player.hand.push(lobby.deck.pop());
  player.missedTurns++;
  if (player.missedTurns >= 3) {
    lobby.players = lobby.players.filter(p => p.id !== playerId);
    io.to(lobbyId).emit('chatMessage', {
      sender: 'SUE',
      message: `${player.name} was kicked after 3 missed turns 💨`
    });
  } else {
    io.to(lobbyId).emit('chatMessage', {
      sender: 'SUE',
      message: `${player.name} auto-drew a card 🕒`
    });
  }
  lobby.currentPlayer = lobby.currentPlayer % lobby.players.length;
  updateGameState(lobbyId);
}

function checkWin(lobbyId, winnerPlayer) {
  if (winnerPlayer.hand.length > 0) return;

  const lobby = lobbies[lobbyId];
  let roundPoints = 0;

  lobby.players.forEach(p => {
    if (p.id !== winnerPlayer.id) {
      p.hand.forEach(c => {
        if (!isNaN(c.value)) roundPoints += parseInt(c.value);
        else if (['skip','reverse','draw2'].includes(c.value)) roundPoints += 20;
        else roundPoints += 50;
      });
    }
  });

  winnerPlayer.score += roundPoints;
  const allScores = loadScores();
  allScores[winnerPlayer.name] = (allScores[winnerPlayer.name] || 0) + roundPoints;
  saveScores(allScores);

  io.to(lobbyId).emit('gameOver', {
    winner: winnerPlayer.name,
    roundPoints,
    totalScore: winnerPlayer.score
  });

  setTimeout(() => startGame(lobbyId), 5000);
}

app.get('/leaderboard', (req, res) => {
  const scores = loadScores();
  const sorted = Object.entries(scores)
    .sort(([,a],[,b]) => b - a)
    .slice(0,10)
    .map(([name, score]) => ({ name, score }));
  res.json(sorted);
});

server.listen(3000, () => console.log('✅ Server on http://localhost:3000'));
