const express = require("express");
const http = require("http");
const { Server } =("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const gameState = {}; // { lobbyId: { players, table, drawPile, turnOrder, currentTurn, lastWildColor, turnTimer } }

function getCardColor(card) {
  if (card.startsWith("red")) return "red";
  if (card.startsWith("yellow")) return "yellow";
  if (card.startsWith("green")) return "green";
  if (card.startsWith("blue")) return "blue";
  if (card.startsWith("wild")) return "wild";
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

function getPlayer(socket) {
  for (const lobbyId in gameState) {
    const player = gameState[lobbyId].players.find(p => p.socket === socket);
    if (player) return player;
  }
  return null;
}

function isPlayersTurn(player) {
  const state = gameState[player.lobby];
  return state.turnOrder[state.currentTurn] === player.name;
}

function scoreHand(hand) {
  let score = 0;
  for (const card of hand) {
    const val = card.split("_")[1];
    if (!val) continue;
    if (card.includes("wild")) score += 50;
    else if (["skip", "reverse", "draw"].includes(val)) score += 20;
    else score += parseInt(val) || 0;
  }
  return score;
}

function advanceTurn(lobbyId) {
  const state = gameState[lobbyId];
  clearTimeout(state.turnTimer);

  state.currentTurn = (state.currentTurn + 1) % state.turnOrder.length;

  const currentPlayerName = state.turnOrder[state.currentTurn];
  const currentPlayer = state.players.find(p => p.name === currentPlayerName);
  if (!currentPlayer) return;

  state.turnTimer = setTimeout(() => {
    currentPlayer.missed = (currentPlayer.missed || 0) + 1;

    // Auto draw
    const card = state.drawPile.pop();
    if (card) currentPlayer.hand.push(card);

    // Auto leave after 3 missed turns
    if (currentPlayer.missed >= 3) {
      leavePlayer(currentPlayer.socket);
    } else {
      advanceTurn(lobbyId);
      broadcastGameState(lobbyId);
    }
  }, 60000);

  broadcastGameState(lobbyId);
}

function broadcastGameState(lobbyId) {
  const state = gameState[lobbyId];
  if (!state) return;

  const players = state.players;

  players.forEach(p => {
    const others = players.filter(o => o.name !== p.name).map(o => ({
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

function leavePlayer(socket) {
  const player = getPlayer(socket);
  if (!player) return;
  const lobbyId = player.lobby;
  const state = gameState[lobbyId];

  const remaining = state.players.filter(p => p.name !== player.name);
  if (remaining.length === 0) {
    delete gameState[lobbyId];
    return;
  }

  // Redistribute cards
  const totalCards = [...player.hand];
  const remainder = totalCards.length % remaining.length;
  const toDraw = remainder ? remaining.length - remainder : 0;

  for (let i = 0; i < toDraw; i++) {
    const drawn = state.drawPile.pop();
    if (drawn) totalCards.push(drawn);
  }

  for (let i = 0; i < totalCards.length; i++) {
    const target = remaining[i % remaining.length];
    target.hand.push(totalCards[i]);
  }

  // Remove player
  state.players = remaining;
  state.turnOrder = state.turnOrder.filter(n => n !== player.name);

  if (state.currentTurn >= state.turnOrder.length) state.currentTurn = 0;

  // Check winner
  if (state.players.length === 1) {
    const winner = state.players[0];
    let total = 0;
    for (const p of state.players) {
      if (p.name !== winner.name) {
        total += scoreHand(p.hand);
      }
    }
    winner.score = (winner.score || 0) + total;
    winner.socket.emit("gameOver", { message: "Congratulations, you are the Champion!" });
    delete gameState[lobbyId];
    return;
  }

  broadcastGameState(lobbyId);
}

io.on("connection", socket => {
  socket.on("joinLobby", ({ lobbyId, name }) => {
    if (!gameState[lobbyId]) {
      gameState[lobbyId] = {
        players: [],
        table: [],
        drawPile: buildDeck(),
        turnOrder: [],
        currentTurn: 0,
        lastWildColor: null,
        turnTimer: null
      };
    }

    const player = {
      name,
      socket,
      hand: [],
      score: 0,
      lobby: lobbyId,
      missed: 0
    };

    const state = gameState[lobbyId];
    state.players.push(player);
    state.turnOrder.push(name);

    for (let i = 0; i < 7; i++) {
      player.hand.push(state.drawPile.pop());
    }

    if (state.table.length === 0) {
      state.table.push(state.drawPile.pop());
    }

    broadcastGameState(lobbyId);
    if (state.players.length === 1) {
      advanceTurn(lobbyId);
    }
  });

  socket.on("playCard", ({ card, chosenColor }) => {
    const player = getPlayer(socket);
    if (!player || !isPlayersTurn(player)) return;

    const state = gameState[player.lobby];
    const cardIndex = player.hand.indexOf(card);
    if (cardIndex === -1) return;

    const topCard = state.table[state.table.length - 1];
    const topColor = state.lastWildColor || getCardColor(topCard);
    const cardColor = getCardColor(card);
    const val = card.split("_")[1];

    const isValid =
      cardColor === "wild" ||
      cardColor === topColor ||
      val === topCard.split("_")[1];

    if (!isValid) return;

    player.hand.splice(cardIndex, 1);
    state.table.push(card);

    state.lastWildColor = cardColor === "wild" ? chosenColor : cardColor;
    player.missed = 0;

    if (player.hand.length === 0) {
      const score = state.players.reduce((acc, p) => {
        if (p.name !== player.name) acc += scoreHand(p.hand);
        return acc;
      }, 0);

      player.score += score;
      player.socket.emit("gameOver", { message: "Congratulations, you are the Champion!" });
      delete gameState[player.lobby];
      return;
    }

    advanceTurn(player.lobby);
  });

  socket.on("drawCard", () => {
    const player = getPlayer(socket);
    if (!player || !isPlayersTurn(player)) return;

    const state = gameState[player.lobby];
    const card = state.drawPile.pop();
    if (card) player.hand.push(card);

    player.missed = 0;
    advanceTurn(player.lobby);
  });

  socket.on("leaveGame", () => {
    leavePlayer(socket);
    socket.disconnect();
  });

  socket.on("disconnect", () => {
    leavePlayer(socket);
  });
});
