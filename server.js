const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const START_DELAY = 30;

let lobbies = {};
const scoresFile = path.join(__dirname, "scores.json");

function getCardList() {
  const colors = ["red", "blue", "green", "yellow"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw"];
  const wilds = ["wild", "wild_draw4"];
  let deck = [];

  for (let color of colors) {
    for (let val of values) {
      deck.push(`${color}_${val}`);
      deck.push(`${color}_${val}`); // Two of each
    }
  }

  for (let w of wilds) deck.push(w, w, w, w);

  return deck;
}

function shuffleDeck(deck) {
  return deck.sort(() => Math.random() - 0.5);
}

function emitToLobby(lobbyId, event, payload) {
  io.to(lobbyId).emit(event, payload);
}

function emitState(lobby) {
  emitToLobby(lobby.id, "gameState", {
    players: lobby.players.map(p => ({
      name: p.name,
      handCount: p.hand.length,
      color: p.color,
      score: p.score || 0,
      hand: p.name === lobby.currentPlayer ? p.hand : undefined
    })),
    pileTopCard: lobby.pile[lobby.pile.length - 1],
    currentTurn: lobby.currentPlayer
  });
}

function addToScores(name, score) {
  let data = {};
  if (fs.existsSync(scoresFile)) {
    data = JSON.parse(fs.readFileSync(scoresFile));
  }
  if (!data[name]) data[name] = 0;
  data[name] += score;
  fs.writeFileSync(scoresFile, JSON.stringify(data, null, 2));
}

function startGame(lobby) {
  lobby.started = true;
  lobby.deck = shuffleDeck(getCardList());
  lobby.pile = [];
  lobby.currentPlayer = lobby.players[0].name;

  lobby.players.forEach(player => {
    player.hand = lobby.deck.splice(0, 7);
    player.score = 0;
  });

  lobby.pile.push(lobby.deck.pop());
  emitState(lobby);
}

io.on("connection", (socket) => {
  socket.on("joinLobby", ({ name, lobbyId }) => {
    if (!name || !lobbyId) return;

    if (!lobbies[lobbyId]) {
      lobbies[lobbyId] = { id: lobbyId, players: [], deck: [], pile: [], started: false };
    }

    const lobby = lobbies[lobbyId];
    if (lobby.players.length >= MAX_PLAYERS) {
      socket.emit("errorMessage", "Lobby is full. Choose another.");
      return;
    }

    const existing = lobby.players.find(p => p.name === name);
    if (existing) {
      socket.emit("errorMessage", "Name already taken.");
      return;
    }

    const player = {
      name,
      socket,
      hand: [],
      color: ["red", "blue", "yellow", "green"][Math.floor(Math.random() * 4)],
      score: 0
    };

    socket.join(lobbyId);
    socket.data.name = name;
    socket.data.lobbyId = lobbyId;

    lobby.players.push(player);
    emitToLobby(lobbyId, "chatMessage", { from: "SUE", text: `${name} has joined the lobby.` });

    if (!lobby.started && lobby.players.length >= 2) {
      let counter = START_DELAY;
      const countdown = setInterval(() => {
        if (!lobbies[lobbyId] || lobbies[lobbyId].started) {
          clearInterval(countdown);
          return;
        }
        if (counter <= 0) {
          startGame(lobby);
          clearInterval(countdown);
          emitToLobby(lobbyId, "chatMessage", { from: "SUE", text: "Game started!" });
        } else if (counter % 5 === 0) {
          emitToLobby(lobbyId, "chatMessage", { from: "SUE", text: `Game starts in ${counter} seconds...` });
        }
        counter--;
      }, 1000);
    }

    socket.emit("lobbyJoined", { color: player.color });
  });

  socket.on("chatMessage", ({ lobbyId, name, text }) => {
    emitToLobby(lobbyId, "chatMessage", { from: name, text });
  });

  socket.on("drawCard", ({ lobbyId, name }) => {
    const lobby = lobbies[lobbyId];
    const player = lobby.players.find(p => p.name === name);
    if (!lobby || !player || lobby.currentPlayer !== name) return;

    const card = lobby.deck.pop();
    player.hand.push(card);
    emitToLobby(lobbyId, "chatMessage", { from: "SUE", text: `${name} drew a card.` });
    advanceTurn(lobby);
  });

  socket.on("playCard", ({ lobbyId, name, card }) => {
    const lobby = lobbies[lobbyId];
    const player = lobby.players.find(p => p.name === name);
    if (!lobby || !player || lobby.currentPlayer !== name) return;

    const topCard = lobby.pile[lobby.pile.length - 1];
    if (!isPlayable(card, topCard)) return;

    const idx = player.hand.indexOf(card);
    if (idx >= 0) {
      player.hand.splice(idx, 1);
      lobby.pile.push(card);
      emitToLobby(lobbyId, "chatMessage", { from: "SUE", text: `${name} played ${card}` });

      if (player.hand.length === 0) {
        emitToLobby(lobbyId, "chatMessage", { from: "SUE", text: `${name} has won the game!` });
        const score = calculateScore(lobby.players);
        addToScores(name, score);
        delete lobbies[lobbyId];
        return;
      }

      advanceTurn(lobby);
    }
  });

  socket.on("disconnect", () => {
    const lobbyId = socket.data.lobbyId;
    const name = socket.data.name;
    if (!lobbyId || !lobbies[lobbyId]) return;

    const lobby = lobbies[lobbyId];
    lobby.players = lobby.players.filter(p => p.name !== name);
    emitToLobby(lobbyId, "chatMessage", { from: "SUE", text: `${name} has disconnected.` });

    if (lobby.players.length < 1) {
      delete lobbies[lobbyId];
    } else {
      emitState(lobby);
    }
  });
});

function advanceTurn(lobby) {
  const names = lobby.players.map(p => p.name);
  const idx = names.indexOf(lobby.currentPlayer);
  const nextIdx = (idx + 1) % names.length;
  lobby.currentPlayer = names[nextIdx];
  emitState(lobby);
}

function isPlayable(card, topCard) {
  if (card.startsWith("wild")) return true;
  const [colorA, typeA] = card.split("_");
  const [colorB, typeB] = topCard.split("_");
  return colorA === colorB || typeA === typeB;
}

function calculateScore(players) {
  let total = 0;
  for (let p of players) {
    for (let c of p.hand) {
      if (c.includes("wild_draw4")) total += 50;
      else if (c.includes("wild")) total += 50;
      else if (c.includes("draw") || c.includes("reverse") || c.includes("skip")) total += 20;
      else total += parseInt(c.split("_")[1]) || 0;
    }
  }
  return total;
}

app.use(express.static(path.join(__dirname, "public")));

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
