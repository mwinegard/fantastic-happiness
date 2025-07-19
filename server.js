const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Game data
const lobbies = {};

function generateDeck() {
  const colors = ['red', 'blue', 'green', 'yellow'];
  const deck = [];

  colors.forEach(color => {
    for (let i = 0; i <= 9; i++) deck.push(`${color}_${i}.png`);
    ['skip', 'reverse', 'draw'].forEach(type => {
      deck.push(`${color}_${type}.png`);
      deck.push(`${color}_${type}.png`);
    });
  });

  deck.push('wild.png', 'wild.png', 'wild_draw4.png', 'wild_draw4.png');
  return shuffle(deck);
}

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

function deal(deck, count) {
  const hand = [];
  for (let i = 0; i < count; i++) hand.push(deck.pop());
  return hand;
}

io.on('connection', socket => {
  socket.on('joinLobby', ({ name, lobbyId }) => {
    socket.join(lobbyId);
    socket.data.name = name;
    socket.data.lobbyId = lobbyId;

    if (!lobbies[lobbyId]) {
      lobbies[lobbyId] = {
        players: [],
        deck: [],
        table: [],
        turnIndex: 0,
        direction: 1,
        lastWildColor: null,
        skipNext: false,
        scores: {},
        inactivity: Date.now(),
      };
    }

    const game = lobbies[lobbyId];

    game.players.push({
      id: socket.id,
      name,
      hand: [],
      skips: 0
    });

    game.scores[name] = 0;

    if (game.deck.length === 0) {
      game.deck = generateDeck();
      game.players.forEach(player => {
        player.hand = deal(game.deck, 7);
      });
      game.table = [game.deck.pop()];
    }

    sendGameState(lobbyId);
  });

  socket.on('playCard', ({ card, chosenColor }) => {
    const lobbyId = socket.data.lobbyId;
    const name = socket.data.name;
    const game = lobbies[lobbyId];
    if (!game) return;

    const player = game.players.find(p => p.id === socket.id);
    if (!player || game.players[game.turnIndex].id !== socket.id) return;

    const lastCard = game.table[game.table.length - 1];
    const validColor = lastCard.split('_')[0];
    const validType = lastCard.split('_')[1];

    if (!card.includes('wild')) {
      const playedColor = card.split('_')[0];
      const playedType = card.split('_')[1];
      if (
        playedColor !== validColor &&
        playedType !== validType &&
        (!game.lastWildColor || playedColor !== game.lastWildColor)
      ) return;
    }

    player.hand = player.hand.filter(c => c !== card);
    game.table.push(card);
    game.lastWildColor = card.includes('wild') ? chosenColor : null;

    // Action effects
    if (card.includes('skip')) {
      game.skipNext = true;
    } else if (card.includes('reverse')) {
      game.direction *= -1;
    } else if (card.includes('draw')) {
      const next = getNextPlayer(game);
      const target = game.players[next];
      target.hand.push(...deal(game.deck, card.includes('4') ? 4 : 2));
    }

    if (player.hand.length === 0) {
      // Winner
      let points = 0;
      game.players.forEach(p => {
        if (p.name !== name) {
          points += p.hand.length;
        }
      });
      game.scores[name] += points;

      io.to(lobbyId).emit('gameOver', {
        message: `🎉 Congratulations ${name}, you are the Champion! You won this round with ${points} points.`,
      });

      delete lobbies[lobbyId];
      return;
    }

    // Advance turn
    game.turnIndex = getNextPlayer(game);
    sendGameState(lobbyId);
  });

  socket.on('drawCard', () => {
    const lobbyId = socket.data.lobbyId;
    const game = lobbies[lobbyId];
    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;

    if (game.players[game.turnIndex].id !== socket.id) return;

    player.hand.push(...deal(game.deck, 1));
    player.skips = (player.skips || 0) + 1;

    if (player.skips >= 3) {
      leavePlayer(socket, true);
    } else {
      game.turnIndex = getNextPlayer(game);
      sendGameState(lobbyId);
    }
  });

  socket.on('leaveGame', () => {
    leavePlayer(socket, false);
  });

  socket.on('disconnect', () => {
    leavePlayer(socket, true);
  });
});

function getNextPlayer(game) {
  const total = game.players.length;
  let next = (game.turnIndex + game.direction + total) % total;
  if (game.skipNext) {
    next = (next + game.direction + total) % total;
    game.skipNext = false;
  }
  return next;
}

function sendGameState(lobbyId) {
  const game = lobbies[lobbyId];
  if (!game) return;

  const currentPlayer = game.players[game.turnIndex];
  game.players.forEach(player => {
    const hand = player.hand;
    const others = game.players
      .filter(p => p.id !== player.id)
      .map(p => ({
        name: p.name,
        count: p.hand.length,
        score: game.scores[p.name] || 0
      }));

    io.to(player.id).emit('gameState', {
      hand,
      table: game.table,
      others,
      isMyTurn: currentPlayer.id === player.id,
      currentPlayer: currentPlayer.name,
      lastWildColor: game.lastWildColor
    });
  });
}

function leavePlayer(socket, silent) {
  const lobbyId = socket.data.lobbyId;
  const game = lobbies[lobbyId];
  if (!game) return;

  const playerIndex = game.players.findIndex(p => p.id === socket.id);
  if (playerIndex === -1) return;

  const leaving = game.players.splice(playerIndex, 1)[0];
  if (!leaving) return;

  const hand = leaving.hand;
  if (game.players.length === 1) {
    const winner = game.players[0];
    game.scores[winner.name] += hand.length;

    io.to(lobbyId).emit('gameOver', {
      message: `🎉 ${winner.name} wins by default and collects all points!`
    });

    delete lobbies[lobbyId];
    return;
  }

  // Redistribute cards
  const share = Math.floor(hand.length / game.players.length);
  const extras = hand.length % game.players.length;

  game.players.forEach((p, i) => {
    const count = share + (i < extras ? 1 : 0);
    p.hand.push(...hand.splice(0, count));
  });

  if (game.turnIndex >= playerIndex) {
    game.turnIndex = getNextPlayer(game);
  }

  sendGameState(lobbyId);
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
