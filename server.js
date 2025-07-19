const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const LOBBY_TIMEOUT_HOURS = 12;

app.use(express.static(path.join(__dirname, "public")));

let lobbies = {};
let scoresFile = path.join(__dirname, "scores.json");

function loadDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "draw", "skip", "reverse"];
  const deck = [];

  for (const color of colors) {
    for (const value of values) {
      deck.push(`${color}_${value}`);
      if (value !== "0") deck.push(`${color}_${value}`);
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push("wild");
    deck.push("wild_draw4");
  }

  return shuffle(deck);
}

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

function dealCards(deck, num = 7) {
  const cards = [];
  for (let i = 0; i < num; i++) {
    cards.push(deck.pop());
  }
  return cards;
}

function emitState(lobby) {
  io.to(lobby.id).emit("updateState", {
    players: lobby.players.map((p) => ({
      name: p.name,
      cards: new Array(p.hand.length).fill("card"),
      score: p.score,
    })),
    topCard: lobby.pile[lobby.pile.length - 1],
    currentPlayer: lobby.players[lobby.turnIndex]?.name || null,
  });
}

io.on("connection", (socket) => {
  socket.on("joinLobby", ({ name, lobby }) => {
    if (!lobbies[lobby]) {
      lobbies[lobby] = {
        id: lobby,
        players: [],
        deck: [],
        pile: [],
        turnIndex: 0,
        created: Date.now(),
      };
    }

    const game = lobbies[lobby];

    if (game.players.length >= MAX_PLAYERS) {
      socket.emit("lobbyFull");
      return;
    }

    const player = {
      id: socket.id,
      name,
      hand: [],
      score: 0,
    };

    game.players.push(player);
    socket.join(lobby);
    socket.lobbyId = lobby;
    socket.playerName = name;

    if (game.players.length >= 2 && game.deck.length === 0) {
      game.deck = loadDeck();
      for (const p of game.players) {
        p.hand = dealCards(game.deck);
      }
      game.pile.push(game.deck.pop());
    }

    io.to(lobby).emit("chat", { sender: "SUE", message: `${name} joined the game.` });
    emitState(game);
  });

  socket.on("drawCard", () => {
    const game = lobbies[socket.lobbyId];
    const player = game?.players.find((p) => p.id === socket.id);
    if (player && game.deck.length > 0) {
      player.hand.push(game.deck.pop());
      emitState(game);
    }
  });

  socket.on("playCard", ({ index }) => {
    const game = lobbies[socket.lobbyId];
    const player = game?.players[game.turnIndex];

    if (player && player.id === socket.id) {
      const card = player.hand[index];
      if (card) {
        game.pile.push(card);
        player.hand.splice(index, 1);
        game.turnIndex = (game.turnIndex + 1) % game.players.length;
        emitState(game);
      }
    }
  });

  socket.on("chat", ({ sender, message, lobby }) => {
    io.to(lobby).emit("chat", { sender, message });
  });

  socket.on("leaveLobby", () => {
    const game = lobbies[socket.lobbyId];
    if (!game) return;

    const i = game.players.findIndex((p) => p.id === socket.id);
    if (i !== -1) {
      const [leaver] = game.players.splice(i, 1);
      io.to(game.id).emit("chat", { sender: "SUE", message: `${leaver.name} has left.` });
    }

    if (game.players.length === 0) {
      delete lobbies[socket.lobbyId];
    } else {
      emitState(game);
    }
  });

  socket.on("disconnect", () => {
    socket.emit("leaveLobby");
  });
});

setInterval(() => {
  const now = Date.now();
  for (const key in lobbies) {
    if (now - lobbies[key].created > LOBBY_TIMEOUT_HOURS * 60 * 60 * 1000) {
      delete lobbies[key];
    }
  }
}, 10 * 60 * 1000); // Check every 10 minutes

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
