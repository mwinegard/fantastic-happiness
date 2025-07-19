const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const LOBBIES = {};
const COLORS = ["red", "yellow", "green", "blue"];
const VALUES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
const ACTIONS = ["skip", "reverse", "draw"];
const WILDS = ["wild.png", "wild_draw4.png"];

function buildDeck() {
  let deck = [];
  for (let color of COLORS) {
    deck.push(`${color}_0.png`);
    for (let value of VALUES.slice(1)) {
      deck.push(`${color}_${value}.png`);
      deck.push(`${color}_${value}.png`);
    }
    for (let action of ACTIONS) {
      deck.push(`${color}_${action}.png`);
      deck.push(`${color}_${action}.png`);
    }
  }
  for (let i = 0; i < 2; i++) deck.push(...WILDS);
  return shuffle(deck);
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function draw(deck, n = 1) {
  return deck.splice(-n, n);
}

function nextPlayerIdx(lobby, skip = 0) {
  const count = lobby.playerOrder.length;
  const inc = lobby.direction * (1 + skip);
  return ((lobby.currentPlayerIdx + inc) % count + count) % count;
}

function findLobby(socketId) {
  return Object.keys(LOBBIES).find(lobbyId => LOBBIES[lobbyId].players[socketId]);
}

function calculateScore(cards) {
  return cards.reduce((score, card) => {
    if (!card) return score;
    if (card.startsWith("wild")) return score + 50;
    const parts = card.split("_");
    const val = parts[1].replace(".png", "");
    if (!isNaN(val)) return score + parseInt(val);
    if (["skip", "reverse", "draw"].includes(val)) return score + 20;
    return score;
  }, 0);
}

function redistributeCards(removedCards, hands, playerOrder) {
  const receivers = playerOrder;
  let idx = 0;
  for (let card of removedCards) {
    const target = receivers[idx % receivers.length];
    hands[target].push(card);
    idx++;
  }
}

function reshuffleIfNeeded(lobby) {
  if (lobby.deck.length < 4) {
    const top = lobby.discard.pop();
    lobby.deck = shuffle(lobby.discard);
    lobby.discard = [top];
  }
}

function updateAll(lobbyId) {
  const lobby = LOBBIES[lobbyId];
  if (!lobby) return;

  for (const id of lobby.playerOrder) {
    const others = lobby.playerOrder.filter(pid => pid !== id).map(pid => ({
      name: lobby.players[pid],
      count: lobby.hands[pid].length,
      score: lobby.scores[pid] || 0
    }));
    io.to(id).emit("gameState", {
      hand: lobby.hands[id],
      table: lobby.discard,
      others,
      currentPlayer: lobby.players[lobby.playerOrder[lobby.currentPlayerIdx]],
      isMyTurn: lobby.playerOrder[lobby.currentPlayerIdx] === id,
      scores: lobby.scores
    });
  }
}

function startGame(lobbyId) {
  const lobby = LOBBIES[lobbyId];
  lobby.deck = buildDeck();
  lobby.hands = {};
  lobby.discard = [];

  for (const id of lobby.playerOrder) {
    lobby.hands[id] = draw(lobby.deck, 7);
    if (!lobby.scores[id]) lobby.scores[id] = 0;
  }

  let first;
  do {
    first = draw(lobby.deck, 1)[0];
  } while (first.startsWith("wild"));
  lobby.discard = [first];
  lobby.direction = 1;
  lobby.currentPlayerIdx = 0;
  lobby.drawStack = 0;
  updateAll(lobbyId);
}

app.use(express.static(path.join(__dirname, 'public')));

io.on("connection", (socket) => {
  socket.on("joinLobby", ({ lobbyId, name }) => {
    if (!/^[a-zA-Z0-9 _]{1,20}$/.test(name)) return;
    if (!LOBBIES[lobbyId]) {
      LOBBIES[lobbyId] = {
        players: {},
        playerOrder: [],
        hands: {},
        deck: [],
        discard: [],
        currentPlayerIdx: 0,
        direction: 1,
        drawStack: 0,
        scores: {}
      };
    }

    const lobby = LOBBIES[lobbyId];
    if (!lobby.players[socket.id]) {
      lobby.players[socket.id] = name;
      lobby.playerOrder.push(socket.id);
    }

    socket.join(lobbyId);
    if (lobby.playerOrder.length >= 2) {
      startGame(lobbyId);
    } else {
      updateAll(lobbyId);
    }
  });

  socket.on("playCard", ({ card, chosenColor }) => {
    const lobbyId = findLobby(socket.id);
    const lobby = LOBBIES[lobbyId];
    if (!lobby || lobby.playerOrder[lobby.currentPlayerIdx] !== socket.id) return;

    const hand = lobby.hands[socket.id];
    const idx = hand.indexOf(card);
    if (idx === -1) return;

    const top = lobby.discard[lobby.discard.length - 1];
    const topVal = top.replace(".png", "").split("_")[1];
    const playVal = card.replace(".png", "").split("_")[1];

    const valid = card.startsWith("wild") || card.split("_")[0] === top.split("_")[0] || playVal === topVal;
    if (!valid) return;

    hand.splice(idx, 1);
    lobby.discard.push(card);

    let skip = 0;
    let draw = 0;

    if (playVal === "skip") skip = 1;
    if (playVal === "reverse") {
      lobby.direction *= -1;
      if (lobby.playerOrder.length === 2) skip = 1;
    }
    if (playVal === "draw") {
      draw = 2;
      skip = 1;
    }
    if (card === "wild_draw4.png") {
      draw = 4;
      skip = 1;
    }

    if (draw > 0) {
      const next = lobby.playerOrder[nextPlayerIdx(lobby)];
      lobby.hands[next].push(...drawCards(lobby, draw));
    }

    if (hand.length === 0) {
      const winner = socket.id;
      for (const pid in lobby.hands) {
        if (pid !== winner) {
          const score = calculateScore(lobby.hands[pid]);
          lobby.scores[winner] += score;
        }
      }
      startGame(lobbyId);
      return;
    }

    lobby.currentPlayerIdx = nextPlayerIdx(lobby, skip);
    reshuffleIfNeeded(lobby);
    updateAll(lobbyId);
  });

  socket.on("drawCard", () => {
    const lobbyId = findLobby(socket.id);
    const lobby = LOBBIES[lobbyId];
    if (!lobby || lobby.playerOrder[lobby.currentPlayerIdx] !== socket.id) return;
    lobby.hands[socket.id].push(...drawCards(lobby, 1));
    lobby.currentPlayerIdx = nextPlayerIdx(lobby);
    reshuffleIfNeeded(lobby);
    updateAll(lobbyId);
  });

  socket.on("leaveGame", () => {
    const lobbyId = findLobby(socket.id);
    const lobby = LOBBIES[lobbyId];
    if (!lobby) return;
    const idx = lobby.playerOrder.indexOf(socket.id);
    if (idx !== -1) {
      const removedHand = lobby.hands[socket.id] || [];
      delete lobby.players[socket.id];
      delete lobby.hands[socket.id];
      lobby.playerOrder.splice(idx, 1);
      redistributeCards(removedHand, lobby.hands, lobby.playerOrder);
      if (lobby.playerOrder.length < 2) {
        delete LOBBIES[lobbyId];
        return;
      }
      lobby.currentPlayerIdx %= lobby.playerOrder.length;
      updateAll(lobbyId);
    }
  });

  socket.on("disconnect", () => {
    const lobbyId = findLobby(socket.id);
    const lobby = LOBBIES[lobbyId];
    if (!lobby) return;
    const idx = lobby.playerOrder.indexOf(socket.id);
    if (idx !== -1) {
      const removedHand = lobby.hands[socket.id] || [];
      delete lobby.players[socket.id];
      delete lobby.hands[socket.id];
      lobby.playerOrder.splice(idx, 1);
      redistributeCards(removedHand, lobby.hands, lobby.playerOrder);
      if (lobby.playerOrder.length < 2) {
        delete LOBBIES[lobbyId];
        return;
      }
      lobby.currentPlayerIdx %= lobby.playerOrder.length;
      updateAll(lobbyId);
    }
  });
});

function drawCards(lobby, count) {
  reshuffleIfNeeded(lobby);
  return draw(lobby.deck, count);
}

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
