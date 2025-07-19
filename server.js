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
  const { id, players, hands, discardPile, currentTurn, wildColor } = lobby;
  const state = {
    players: Object.values(players).map(p => ({
      id: p.id,
      name: p.name,
      score: p.score || 0,
      handSize: (hands[p.id] || []).length
    })),
    hands,
    discardPile,
    currentTurn,
    wildColor
  };
  io.to(id).emit("state", state);
}

function sendMessage(lobbyId, from, text) {
  io.to(lobbyId).emit("message", { from, text });
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
        currentTurn: null,
        wildColor: null
      };
    }

    const lobbyObj = lobbies[lobby];
    const playerId = socket.id;

    if (Object.keys(lobbyObj.players).length >= 10) {
      socket.emit("error", "Lobby is full.");
      return;
    }

    lobbyObj.players[playerId] = { id: playerId, name, score: 0 };
    lobbyObj.hands[playerId] = lobbyObj.deck.splice(0, 7);

    if (!lobbyObj.currentTurn) {
      // Start with non-wild card
      let top;
      do {
        top = lobbyObj.deck.pop();
      } while (top.includes("wild"));
      lobbyObj.discardPile.push(top);
      lobbyObj.currentTurn = playerId;
      sendMessage(lobby, "SUE", "Game started!");
    }

    emitState(lobbyObj);
  });

  socket.on("playCard", ({ lobby, card, chosenColor, saidUNO }) => {
    const lobbyObj = lobbies[lobby];
    if (!lobbyObj) return;

    const playerId = socket.id;
    const hand = lobbyObj.hands[playerId];
    const index = hand.indexOf(card);
    if (index === -1) return;

    hand.splice(index, 1);
    lobbyObj.discardPile.push(card);

    // Handle wild card
    if (card.includes("wild")) {
      if (!chosenColor) return;
      lobbyObj.wildColor = chosenColor;
      sendMessage(lobby, "SUE", `${lobbyObj.players[playerId].name} played a Wild card!`);
    } else {
      lobbyObj.wildColor = null;
    }

    const ids = Object.keys(lobbyObj.players);
    const idx = ids.indexOf(playerId);
    lobbyObj.currentTurn = ids[(idx + 1) % ids.length];

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

app.get("/admin-state", (req, res) => {
  const data = Object.values(lobbies).map(lobby => ({
    id: lobby.id,
    players: Object.values(lobby.players).map(p => ({
      id: p.id,
      name: p.name,
      score: p.score || 0,
      handSize: (lobby.hands[p.id] || []).length
    }))
  }));
  res.json(data);
});

app.post("/admin/kick/:lobby/:id", (req, res) => {
  const { lobby, id } = req.params;
  if (lobbies[lobby]) {
    delete lobbies[lobby].players[id];
    delete lobbies[lobby].hands[id];
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

app.post("/admin/close/:lobby", (req, res) => {
  delete lobbies[req.params.lobby];
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO server running on port ${PORT}`);
});
