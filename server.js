const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const lobbies = {};

function createDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw"];
  const wilds = ["wild", "wild_draw4"];
  const deck = [];

  for (let color of colors) {
    for (let val of values) {
      deck.push(`${color}_${val}`);
      deck.push(`${color}_${val}`);
    }
  }

  for (let w of wilds) {
    for (let i = 0; i < 4; i++) deck.push(w);
  }

  return deck;
}

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

function emitState(lobby) {
  const { id, players, hands, discardPile, currentTurn } = lobby;
  const state = {
    players: Object.values(players).map(p => ({ id: p.id, name: p.name })),
    hands: hands,
    discardPile,
    currentTurn
  };
  io.to(id).emit("state", state);
}

io.on("connection", (socket) => {
  socket.on("join", ({ name, lobby }) => {
    if (!name || !lobby) return;

    socket.join(lobby);
    if (!lobbies[lobby]) {
      lobbies[lobby] = {
        id: lobby,
        players: {},
        hands: {},
        deck: shuffle(createDeck()),
        discardPile: [],
        currentTurn: null
      };
    }

    const lobbyObj = lobbies[lobby];
    const playerId = socket.id;

    if (Object.keys(lobbyObj.players).length >= 10) {
      socket.emit("error", "Lobby is full.");
      return;
    }

    lobbyObj.players[playerId] = { id: playerId, name };
    lobbyObj.hands[playerId] = lobbyObj.deck.splice(0, 7);

    if (!lobbyObj.currentTurn) {
      lobbyObj.discardPile.push(lobbyObj.deck.pop());
      lobbyObj.currentTurn = playerId;
    }

    emitState(lobbyObj);
  });

  socket.on("playCard", ({ lobby, card }) => {
    const lobbyObj = lobbies[lobby];
    if (!lobbyObj) return;
    const playerId = socket.id;
    const hand = lobbyObj.hands[playerId];
    const cardIndex = hand.indexOf(card);
    if (cardIndex !== -1) {
      hand.splice(cardIndex, 1);
      lobbyObj.discardPile.push(card);
      // Simple turn logic (next player)
      const ids = Object.keys(lobbyObj.players);
      const idx = ids.indexOf(playerId);
      lobbyObj.currentTurn = ids[(idx + 1) % ids.length];
    }
    emitState(lobbyObj);
  });

  socket.on("drawCard", ({ lobby }) => {
    const lobbyObj = lobbies[lobby];
    const playerId = socket.id;
    if (lobbyObj && lobbyObj.deck.length > 0) {
      const card = lobbyObj.deck.pop();
      lobbyObj.hands[playerId].push(card);
      emitState(lobbyObj);
    }
  });

  socket.on("disconnect", () => {
    for (let lobbyId in lobbies) {
      const lobby = lobbies[lobbyId];
      if (lobby.players[socket.id]) {
        delete lobby.players[socket.id];
        delete lobby.hands[socket.id];
        if (Object.keys(lobby.players).length === 0) {
          delete lobbies[lobbyId];
        } else {
          emitState(lobby);
        }
        break;
      }
    }
  });
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
