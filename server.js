const express = require("express");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");
const http = require("http");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const DEFAULT_LOBBY = "default";
const animalNames = ["Tiger", "Lion", "Panther", "Eagle", "Fox", "Bear", "Wolf", "Shark", "Falcon", "Owl"];
const numberWords = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

let lobbies = {
  [DEFAULT_LOBBY]: {
    createdAt: Date.now(),
    players: [],
    deck: [],
    topCard: null,
    currentPlayer: null,
    currentIndex: 0,
  }
};

function initDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  const numbers = [...Array(10).keys()];
  const actions = ["skip", "reverse", "draw"];
  const deck = [];

  for (const color of colors) {
    for (const num of numbers) deck.push(`${color}_${num}`);
    for (const act of actions) deck.push(`${color}_${act}`, `${color}_${act}`);
  }
  deck.push("wild", "wild", "wild_draw4", "wild_draw4");
  return shuffle(deck);
}

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

function emitState(lobby) {
  const state = {
    players: lobby.players.map(p => ({
      name: p.name,
      cards: p.name === lobby.currentPlayer ? p.cards : p.cards.map(() => "back"),
      score: p.score,
    })),
    currentPlayer: lobby.currentPlayer,
    topCard: lobby.topCard,
  };
  for (const p of lobby.players) {
    io.to(p.id).emit("updateState", state);
  }
}

function broadcastChat(lobby, sender, message) {
  for (const p of lobby.players) {
    io.to(p.id).emit("chat", { sender, message });
  }
}

function nextTurn(lobby) {
  lobby.currentIndex = (lobby.currentIndex + 1) % lobby.players.length;
  lobby.currentPlayer = lobby.players[lobby.currentIndex].name;
  emitState(lobby);
}

function startGame(lobby) {
  lobby.deck = initDeck();
  for (const p of lobby.players) {
    p.cards = lobby.deck.splice(0, 7);
  }
  lobby.topCard = lobby.deck.pop();
  lobby.currentIndex = 0;
  lobby.currentPlayer = lobby.players[0].name;
  broadcastChat(lobby, "SUE", "Game started!");
  emitState(lobby);
}

function removePlayer(id, lobby) {
  const index = lobby.players.findIndex(p => p.id === id);
  if (index !== -1) {
    const [removed] = lobby.players.splice(index, 1);
    broadcastChat(lobby, "SUE", `${removed.name} has left the game.`);
    emitState(lobby);
  }
}

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", socket => {
  const lobby = lobbies[DEFAULT_LOBBY];
  if (lobby.players.length >= MAX_PLAYERS) {
    socket.emit("lobbyFull");
    return;
  }

  const index = lobby.players.length;
  const randomAnimal = animalNames[Math.floor(Math.random() * animalNames.length)];
  const autoName = `${numberWords[index]}-${randomAnimal}`;

  lobby.players.push({ name: autoName, id: socket.id, cards: [], score: 0 });
  socket.join(DEFAULT_LOBBY);
  socket.emit("assignedName", autoName);

  broadcastChat(lobby, "SUE", `${autoName} has joined.`);

  if (lobby.players.length === 2) {
    broadcastChat(lobby, "SUE", "Game starting in 5 seconds...");
    setTimeout(() => startGame(lobby), 5000);
  }

  socket.on("chat", ({ sender, message }) => {
    broadcastChat(lobby, sender, message);
  });

  socket.on("drawCard", () => {
    const p = lobby.players.find(p => p.id === socket.id);
    if (p && lobby.deck.length) {
      p.cards.push(lobby.deck.pop());
      nextTurn(lobby);
    }
  });

  socket.on("playCard", ({ index }) => {
    const p = lobby.players.find(p => p.id === socket.id);
    if (!p) return;

    const card = p.cards[index];
    if (!card) return;

    const [topColor] = lobby.topCard.split("_");
    const [cardColor] = card.split("_");

    if (cardColor === topColor || card.startsWith("wild")) {
      lobby.topCard = card;
      p.cards.splice(index, 1);

      if (p.cards.length === 0) {
        broadcastChat(lobby, "SUE", `${p.name} wins the round!`);
      } else {
        nextTurn(lobby);
      }
    }
  });

  socket.on("disconnect", () => {
    removePlayer(socket.id, lobby);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
