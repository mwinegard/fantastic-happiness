const express = require("express");
const http = require("http");
const fs = require("fs");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

const MAX_PLAYERS = 10;
const lobbies = {};
const SCORES_FILE = "./scores.json";

// Leaderboard API
app.get("/api/leaderboard", (req, res) => {
  if (fs.existsSync(SCORES_FILE)) {
    const scores = JSON.parse(fs.readFileSync(SCORES_FILE));
    const sorted = Object.entries(scores)
      .map(([name, score]) => ({ name, score }))
      .sort((a, b) => b.score - a.score);
    res.json(sorted);
  } else {
    res.json([]);
  }
});

io.on("connection", (socket) => {
  let currentLobby = "";
  let currentPlayer = "";

  socket.on("joinLobby", ({ playerName, lobbyId }) => {
    if (!lobbies[lobbyId]) {
      lobbies[lobbyId] = {
        players: [],
        deck: [],
        pile: [],
        started: false,
        turnIndex: 0,
        direction: 1,
        colorOverride: null,
        chat: [],
        timeout: null,
      };
    }

    const lobby = lobbies[lobbyId];
    if (lobby.players.find(p => p.name === playerName)) return;

    if (lobby.players.length >= MAX_PLAYERS) {
      socket.emit("chatMessage", { sender: "SUE", message: "Lobby full.", system: true });
      return;
    }

    const playerObj = {
      id: socket.id,
      name: playerName,
      hand: [],
      skips: 0,
      score: 0
    };

    lobby.players.push(playerObj);
    currentLobby = lobbyId;
    currentPlayer = playerName;
    socket.join(lobbyId);

    io.to(lobbyId).emit("joinedLobby", {});

    broadcastChat(lobbyId, `🃏 ${playerName} joined the lobby.`);

    if (lobby.players.length >= 2 && !lobby.started) {
      lobby.started = true;
      setTimeout(() => startGame(lobbyId), 30000);
      for (let i = 30; i > 0; i -= 5) {
        setTimeout(() => broadcastChat(lobbyId, `Game starts in ${i} seconds...`), (30 - i) * 1000);
      }
    }
  });

  socket.on("chatMessage", ({ lobbyId, sender, message }) => {
    io.to(lobbyId).emit("chatMessage", { sender, message, system: sender === "SUE" });
  });

  socket.on("drawCard", ({ lobbyId, playerName }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    const player = lobby.players[lobby.turnIndex];
    if (player.name !== playerName) return;

    const card = lobby.deck.pop();
    player.hand.push(card);
    advanceTurn(lobbyId);
    emitGameState(lobbyId);
  });

  socket.on("playCard", ({ lobbyId, playerName, card, selectedColor }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    const player = lobby.players[lobby.turnIndex];
    if (player.name !== playerName) return;

    const topCard = lobby.pile[lobby.pile.length - 1];
    const playable = isCardPlayable(card, topCard, lobby.colorOverride);
    if (!playable) return;

    // Play the card
    player.hand = player.hand.filter(c => c !== card);
    lobby.pile.push(card);
    lobby.colorOverride = null;

    // Handle wild
    if (card.includes("wild")) {
      lobby.colorOverride = selectedColor || "red";
    }

    // Special cards
    if (card.includes("reverse")) {
      lobby.direction *= -1;
    } else if (card.includes("skip")) {
      advanceTurn(lobbyId, true);
    } else if (card.includes("draw")) {
      const nextIndex = (lobby.turnIndex + lobby.direction + lobby.players.length) % lobby.players.length;
      const drawPlayer = lobby.players[nextIndex];
      const drawCount = card.includes("4") ? 4 : 2;
      drawPlayer.hand.push(...lobby.deck.splice(0, drawCount));
      advanceTurn(lobbyId, true);
    }

    // Win?
    if (player.hand.length === 0) {
      const score = calculateScore(lobby.players, player.name);
      updateScore(player.name, score);
      io.to(lobbyId).emit("chatMessage", {
        sender: "SUE",
        message: `🎉 ${player.name} wins the round and scores ${score} points!`,
        system: true
      });
      delete lobbies[lobbyId];
      return;
    }

    advanceTurn(lobbyId);
    emitGameState(lobbyId);
  });

  socket.on("disconnect", () => {
    const lobby = lobbies[currentLobby];
    if (!lobby) return;

    const playerIndex = lobby.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== -1) {
      const name = lobby.players[playerIndex].name;
      lobby.players.splice(playerIndex, 1);
      broadcastChat(currentLobby, `${name} has disconnected.`);
      if (lobby.players.length < 2) delete lobbies[currentLobby];
      else emitGameState(currentLobby);
    }
  });
});

// Helpers
function broadcastChat(lobbyId, message) {
  io.to(lobbyId).emit("chatMessage", { sender: "SUE", message, system: true });
}

function emitGameState(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  io.to(lobbyId).emit("gameState", {
    players: lobby.players.map(p => ({
      name: p.name,
      hand: p.hand,
      score: p.score
    })),
    pileTopCard: lobby.pile[lobby.pile.length - 1],
    drawPileCount: lobby.deck.length,
    colorOverride: lobby.colorOverride
  });
}

function startGame(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  const deck = buildDeck();
  shuffle(deck);
  lobby.deck = deck;
  lobby.pile = [deck.pop()];
  lobby.colorOverride = null;
  for (let p of lobby.players) p.hand = deck.splice(0, 7);
  emitGameState(lobbyId);
}

function advanceTurn(lobbyId, skip = false) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  const len = lobby.players.length;
  lobby.turnIndex = (lobby.turnIndex + (skip ? 2 : 1) * lobby.direction + len) % len;
}

function isCardPlayable(card, topCard, override) {
  if (!topCard) return true;
  if (card.includes("wild")) return true;
  const [cColor, cValue] = card.split("_");
  const [tColor, tValue] = topCard.split("_");

  return (
    cColor === tColor ||
    cValue === tValue ||
    (override && cColor === override)
  );
}

function buildDeck() {
  const colors = ["red", "green", "blue", "yellow"];
  const deck = [];
  for (let color of colors) {
    for (let i = 0; i <= 9; i++) deck.push(`${color}_${i}.png`);
    ["skip", "reverse", "draw"].forEach(action => {
      deck.push(`${color}_${action}.png`);
    });
  }
  deck.push("wild.png", "wild.png", "wild_draw4.png", "wild_draw4.png");
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

function calculateScore(players, winnerName) {
  let score = 0;
  for (let p of players) {
    if (p.name !== winnerName) {
      for (let card of p.hand) {
        if (card.includes("wild_draw4")) score += 50;
        else if (card.includes("wild")) score += 50;
        else if (card.includes("draw") || card.includes("reverse") || card.includes("skip")) score += 20;
        else score += parseInt(card.match(/\d/)) || 0;
      }
    }
  }
  return score;
}

function updateScore(name, score) {
  const path = SCORES_FILE;
  let data = {};
  if (fs.existsSync(path)) {
    data = JSON.parse(fs.readFileSync(path));
  }
  data[name] = (data[name] || 0) + score;
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
