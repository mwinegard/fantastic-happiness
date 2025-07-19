const express = require('express');
const http = require('http');
const { Server } = require('socket.io'); // ✅ Correct import
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server); // ✅ Fixes the deployment error

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

let lobbies = {}; // { lobbyId: { players: [], deck: [], discardPile: [], ... } }

function createDeck() {
  const colors = ['red', 'yellow', 'green', 'blue'];
  const values = ['0','1','2','3','4','5','6','7','8','9','skip','reverse','draw'];
  const wilds = ['wild', 'wild_draw4'];
  let deck = [];

  for (const color of colors) {
    for (const value of values) {
      deck.push(`${color}_${value}.png`);
      if (value !== '0') deck.push(`${color}_${value}.png`); // duplicate non-zero cards
    }
  }

  for (const wild of wilds) {
    deck.push(`${wild}.png`);
    deck.push(`${wild}.png`);
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

io.on('connection', socket => {
  let playerName = '';
  let currentLobby = '';

  socket.on('joinLobby', ({ name, lobbyId }) => {
    playerName = name;
    currentLobby = lobbyId;

    if (!lobbies[lobbyId]) {
      lobbies[lobbyId] = {
        players: [],
        deck: createDeck(),
        discardPile: [],
        turnIndex: 0,
        direction: 1,
        wildColor: null,
        scores: {},
        missedTurns: {}
      };
    }

    const lobby = lobbies[lobbyId];
    lobby.players.push({ id: socket.id, name, hand: [] });
    lobby.scores[name] = 0;
    lobby.missedTurns[socket.id] = 0;

    for (let i = 0; i < 7; i++) {
      const card = lobby.deck.pop();
      lobby.players[lobby.players.length - 1].hand.push(card);
    }

    if (lobby.discardPile.length === 0) {
      let topCard = lobby.deck.pop();
      while (topCard.includes('wild')) topCard = lobby.deck.pop();
      lobby.discardPile.push(topCard);
    }

    sendGameState(lobbyId);
  });

  socket.on('playCard', ({ card, chosenColor }) => {
    const lobby = lobbies[currentLobby];
    if (!lobby) return;

    const player = lobby.players.find(p => p.id === socket.id);
    if (!player || player !== getCurrentPlayer(lobby)) return;

    const top = lobby.discardPile[lobby.discardPile.length - 1];
    const isValid = validatePlay(card, top, lobby.wildColor);

    if (!isValid) return;

    player.hand = player.hand.filter(c => c !== card);
    lobby.discardPile.push(card);
    lobby.wildColor = card.includes('wild') ? chosenColor : null;

    handleSpecialCard(card, lobby);

    if (player.hand.length === 0) {
      const score = calculateScore(lobby);
      lobby.scores[player.name] += score;
      io.to(socket.id).emit('gameOver', {
        message: `Congratulations ${player.name}, you are the Champion!`
      });
      delete lobbies[currentLobby];
      return;
    }

    advanceTurn(lobby);
    sendGameState(currentLobby);
  });

  socket.on('drawCard', () => {
    const lobby = lobbies[currentLobby];
    if (!lobby) return;

    const player = lobby.players.find(p => p.id === socket.id);
    if (!player || player !== getCurrentPlayer(lobby)) return;

    const card = lobby.deck.pop();
    player.hand.push(card);

    advanceTurn(lobby);
    sendGameState(currentLobby);
  });

  socket.on('leaveGame', () => {
    handleLeave(socket.id, currentLobby);
  });

  socket.on('disconnect', () => {
    handleLeave(socket.id, currentLobby);
  });
});

function handleLeave(socketId, lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  const index = lobby.players.findIndex(p => p.id === socketId);
  if (index === -1) return;

  const leaving = lobby.players[index];
  const leavingHand = leaving.hand.slice();
  lobby.players.splice(index, 1);

  if (lobby.players.length === 0) {
    delete lobbies[lobbyId];
    return;
  }

  // Redistribute cards
  while (leavingHand.length > 0) {
    lobby.players.forEach(player => {
      if (leavingHand.length > 0) {
        player.hand.push(leavingHand.pop());
      }
    });
  }

  if (lobby.players.length === 1) {
    const winner = lobby.players[0];
    const score = calculateScore(lobby);
    lobby.scores[winner.name] += score;
    io.to(winner.id).emit('gameOver', {
      message: `Congratulations ${winner.name}, you are the Champion!`
    });
    delete lobbies[lobbyId];
    return;
  }

  sendGameState(lobbyId);
}

function validatePlay(card, topCard, wildColor) {
  const [cardColor, cardValue] = card.replace('.png', '').split('_');
  const [topColor, topValue] = topCard.replace('.png', '').split('_');

  return (
    cardColor === topColor ||
    cardValue === topValue ||
    card.includes('wild') ||
    (wildColor && cardColor === wildColor)
  );
}

function handleSpecialCard(card, lobby) {
  const [color, value] = card.replace('.png', '').split('_');
  const nextIndex = getNextIndex(lobby);

  switch (value) {
    case 'skip':
      lobby.turnIndex = getNextIndex(lobby, 2);
      break;
    case 'reverse':
      lobby.direction *= -1;
      if (lobby.players.length === 2) {
        lobby.turnIndex = getNextIndex(lobby);
      }
      break;
    case 'draw':
      const target = lobby.players[nextIndex];
      target.hand.push(lobby.deck.pop());
      target.hand.push(lobby.deck.pop());
      lobby.turnIndex = getNextIndex(lobby, 2);
      break;
    case 'draw4':
      const target4 = lobby.players[nextIndex];
      for (let i = 0; i < 4; i++) target4.hand.push(lobby.deck.pop());
      lobby.turnIndex = getNextIndex(lobby, 2);
      break;
    default:
      // normal card
      break;
  }
}

function advanceTurn(lobby) {
  lobby.turnIndex = getNextIndex(lobby);
}

function getNextIndex(lobby, step = 1) {
  const count = lobby.players.length;
  return (lobby.turnIndex + step * lobby.direction + count) % count;
}

function getCurrentPlayer(lobby) {
  return lobby.players[lobby.turnIndex];
}

function calculateScore(lobby) {
  let score = 0;
  for (const player of lobby.players) {
    for (const card of player.hand) {
      if (!card.endsWith('.png')) continue;
      const base = card.replace('.png', '');
      if (base.includes('draw4') || base.includes('wild')) {
        score += 50;
      } else if (base.includes('draw') || base.includes('skip') || base.includes('reverse')) {
        score += 20;
      } else {
        const val = parseInt(base.split('_')[1]);
        score += isNaN(val) ? 0 : val;
      }
    }
  }
  return score;
}

function sendGameState(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  const current = getCurrentPlayer(lobby);

  for (const player of lobby.players) {
    const others = lobby.players
      .filter(p => p.id !== player.id)
      .map(p => ({
        name: p.name,
        count: p.hand.length,
        score: lobby.scores[p.name] || 0
      }));

    io.to(player.id).emit("gameState", {
      hand: player.hand,
      table: lobby.discardPile,
      others,
      currentPlayer: current.name,
      isMyTurn: current.id === player.id,
      scores: lobby.scores,
      lastWildColor: lobby.wildColor
    });
  }
}

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
