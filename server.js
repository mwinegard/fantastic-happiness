const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// ====== GAME STATE MANAGEMENT ======
const gameState = {}; // { lobbyId: { players, table, drawPile, turnOrder, currentTurn, lastWildColor } }

// Utility
function getCardColor(cardName) {
  if (cardName.startsWith("red")) return "red";
  if (cardName.startsWith("yellow")) return "yellow";
  if (cardName.startsWith("green")) return "green";
  if (cardName.startsWith("blue")) return "blue";
  if (cardName.startsWith("wild")) return "wild";
  return null;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function buildDeck() {
  const colors = ["red", "yellow", "green", "blue"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw"];
  let deck = [];

  for (const color of colors) {
    for (const value of values) {
      deck.push(`${color}_${value}.png`);
      if (value !== "0") deck.push(`${color}_${value}.png`);
    }
  }

  deck.push("wild.png", "wild.png", "wild_draw4.png", "wild_draw4.png");

  return shuffle(deck);
}

function advanceTurn(lobbyId) {
  const state = gameState[lobbyId];
  state.currentTurn = (state.currentTurn + 1) % state.turnOrder.length;
}

function getPlayer(socket) {
  for (const lobby of Object.values(gameState)) {
    const player = lobby.players.find(p => p.socket === socket);
    if (player) return player;
  }
  return null;
}

function isPlayersTurn(player) {
  const lobby = gameState[player.lobby];
  return player.name === lobby.turnOrder[lobby.currentTurn];
}

function broadcastGameState(lobbyId) {
  const state = gameState[lobbyId];
  const players = state.players;

  players.forEach(p => {
    const others = players.filter(o => o !== p).map(o => ({
      name: o.name,
      count: o.hand.length,
      score: o.score || 0
    }));

    p.socket.emit("gameState", {
      hand: p.hand,
      table: state.table,
      others,
      currentPlayer: state.turnOrder[state.currentTurn],
      isMyTurn: p.name === state.turnOrder[state.currentTurn],
      scores: Object.fromEntries(players.map(pl => [pl.name, pl.score || 0])),
      lastWildColor: state.lastWildColor || null
    });
  });
}

// ====== SOCKET.IO EVENTS ======

io.on("connection", socket => {
  console.log("Client connected.");

  socket.on("joinLobby", ({ lobbyId, name }) => {
    if (!gameState[lobbyId]) {
      gameState[lobbyId] = {
        players: [],
        table: [],
        drawPile: buildDeck(),
        turnOrder: [],
        currentTurn: 0,
        lastWildColor: null
      };
    }

    const player = {
      name,
      socket,
      hand: [],
      lobby: lobbyId,
      score: 0
    };

    gameState[lobbyId].players.push(player);
    gameState[lobbyId].turnOrder.push(name);

    // Deal 7 cards
    for (let i = 0; i < 7; i++) {
      const card = gameState[lobbyId].drawPile.pop();
      if (card) player.hand.push(card);
    }

    // If first player, add one card to table
    if (gameState[lobbyId].table.length === 0) {
      gameState[lobbyId].table.push(gameState[lobbyId].drawPile.pop());
    }

    broadcastGameState(lobbyId);
  });

  socket.on("playCard", ({ card, chosenColor }) => {
    const player = getPlayer(socket);
    if (!player || !isPlayersTurn(player)) return;

    const state = gameState[player.lobby];
    const handIndex = player.hand.indexOf(card);
    if (handIndex === -1) return;

    const topCard = state.table[state.table.length - 1];
    const topColor = state.lastWildColor || getCardColor(topCard);
    const cardColor = getCardColor(card);

    // Validate move
    const isValid =
      cardColor === "wild" ||
      cardColor === topColor ||
      card.split("_")[1] === topCard.split("_")[1];

    if (!isValid) return;

    // Remove card from hand
    player.hand.splice(handIndex, 1);
    state.table.push(card);

    // Handle wilds
    if (cardColor === "wild") {
      if (!["red", "yellow", "green", "blue"].includes(chosenColor)) return;
      state.lastWildColor = chosenColor;
    } else {
      state.lastWildColor = cardColor;
    }

    advanceTurn(player.lobby);
    broadcastGameState(player.lobby);
  });

  socket.on("drawCard", () => {
    const player = getPlayer(socket);
    if (!player || !isPlayersTurn(player)) return;

    const state = gameState[player.lobby];
    const card = state.drawPile.pop();
    if (card) player.hand.push(card);

    advanceTurn(player.lobby);
    broadcastGameState(player.lobby);
  });

  socket.on("leaveGame", () => {
    const player = getPlayer(socket);
    if (!player) return;

    const lobbyId = player.lobby;
    const state = gameState[lobbyId];

    // Redistribute cards
    const remainingPlayers = state.players.filter(p => p !== player);
    if (remainingPlayers.length > 0) {
      let i = 0;
      for (const card of player.hand) {
        remainingPlayers[i % remainingPlayers.length].hand.push(card);
        i++;
      }
    }

    // Remove player
    state.players = state.players.filter(p => p !== player);
    state.turnOrder = state.turnOrder.filter(n => n !== player.name);

    if (state.currentTurn >= state.turnOrder.length) {
      state.currentTurn = 0;
    }

    socket.disconnect();

    if (state.players.length === 0) {
      delete gameState[lobbyId];
    } else {
      broadcastGameState(lobbyId);
    }
  });

  socket.on("disconnect", () => {
    const player = getPlayer(socket);
    if (player) {
      console.log(`${player.name} disconnected`);
      socket.emit("leaveGame");
    }
  });
});
