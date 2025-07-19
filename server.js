const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const lobbies = {};

const COLORS = ["red", "green", "blue", "yellow"];
const VALUES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw"];
const SPECIALS = ["wild", "wild_draw4"];
const CARD_LIMITS = { skip: 2, reverse: 2, draw: 2 }; // Max twice each per color

function generateDeck() {
  const deck = [];

  COLORS.forEach(color => {
    deck.push(`${color}_0.png`);
    for (let val of VALUES) {
      if (val !== "0") {
        deck.push(`${color}_${val}.png`);
        deck.push(`${color}_${val}.png`);
      }
    }
  });

  SPECIALS.forEach(type => {
    for (let i = 0; i < 4; i++) deck.push(`${type}.png`);
  });

  return shuffle(deck);
}

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

function dealCards(deck, count) {
  const hand = [];
  for (let i = 0; i < count; i++) hand.push(deck.pop());
  return hand;
}

function getOtherPlayers(lobby, excludeId) {
  return lobby.players
    .filter(p => p.id !== excludeId)
    .map(p => ({
      name: p.name,
      count: p.hand.length,
      score: p.score || 0
    }));
}

function updateGameState(lobby) {
  lobby.players.forEach(player => {
    const isTurn = lobby.turnOrder[0] === player.id;
    const socket = io.sockets.sockets.get(player.id);
    if (socket) {
      socket.emit("gameState", {
        hand: player.hand,
        table: lobby.discardPile,
        others: getOtherPlayers(lobby, player.id),
        isMyTurn: isTurn,
        currentPlayer: lobby.playerMap[lobby.turnOrder[0]],
        lastWildColor: lobby.lastWildColor
      });
    }
  });
}

function playCardIsValid(card, topCard, wildColor) {
  if (card.startsWith("wild")) return true;
  const [cardColor, cardValue] = card.replace(".png", "").split("_");
  const [topColor, topValue] = topCard.replace(".png", "").split("_");
  return (
    cardColor === topColor ||
    cardValue === topValue ||
    cardColor === wildColor
  );
}

io.on("connection", socket => {
  socket.on("joinLobby", ({ name, lobbyId }) => {
    if (!lobbies[lobbyId]) {
      lobbies[lobbyId] = {
        players: [],
        deck: generateDeck(),
        discardPile: [],
        turnOrder: [],
        playerMap: {},
        lastWildColor: null
      };
    }

    const lobby = lobbies[lobbyId];
    const newPlayer = {
      id: socket.id,
      name,
      hand: dealCards(lobby.deck, 7),
      score: 0,
      misses: 0
    };

    lobby.players.push(newPlayer);
    lobby.turnOrder.push(socket.id);
    lobby.playerMap[socket.id] = name;

    if (lobby.discardPile.length === 0) {
      let top;
      do {
        top = lobby.deck.pop();
      } while (top.startsWith("wild"));
      lobby.discardPile.push(top);
    }

    updateGameState(lobby);
  });

  socket.on("playCard", ({ card, chosenColor }) => {
    for (let lobbyId in lobbies) {
      const lobby = lobbies[lobbyId];
      if (!lobby.playerMap[socket.id]) continue;

      const player = lobby.players.find(p => p.id === socket.id);
      const topCard = lobby.discardPile[lobby.discardPile.length - 1];

      if (!player || lobby.turnOrder[0] !== socket.id) return;

      if (!playCardIsValid(card, topCard, lobby.lastWildColor)) return;

      const cardIdx = player.hand.indexOf(card);
      if (cardIdx === -1) return;

      player.hand.splice(cardIdx, 1);
      lobby.discardPile.push(card);
      lobby.lastWildColor = card.startsWith("wild") ? chosenColor : null;

      if (player.hand.length === 0) {
        io.to(socket.id).emit("gameOver", { message: "🎉 Congratulations, you are the Champion!" });
        delete lobbies[lobbyId];
        return;
      }

      const currentIdx = lobby.turnOrder.indexOf(socket.id);
      lobby.turnOrder.push(lobby.turnOrder.splice(currentIdx, 1)[0]); // move to end

      updateGameState(lobby);
      break;
    }
  });

  socket.on("drawCard", () => {
    for (let lobbyId in lobbies) {
      const lobby = lobbies[lobbyId];
      if (!lobby.playerMap[socket.id]) continue;

      const player = lobby.players.find(p => p.id === socket.id);
      if (!player || lobby.turnOrder[0] !== socket.id) return;

      player.hand.push(lobby.deck.pop());
      player.misses = (player.misses || 0) + 1;

      if (player.misses >= 3) {
        // remove and redistribute
        const remaining = lobby.players.filter(p => p.id !== socket.id);
        const handToSplit = player.hand;
        let i = 0;
        while (handToSplit.length) {
          remaining[i % remaining.length].hand.push(handToSplit.pop());
          i++;
        }
        lobby.players = remaining;
        lobby.turnOrder = lobby.turnOrder.filter(id => id !== socket.id);
        delete lobby.playerMap[socket.id];

        if (lobby.players.length === 1) {
          io.to(lobby.players[0].id).emit("gameOver", { message: "🎉 Congratulations, you are the Champion!" });
          delete lobbies[lobbyId];
          return;
        }
      } else {
        const idx = lobby.turnOrder.indexOf(socket.id);
        lobby.turnOrder.push(lobby.turnOrder.splice(idx, 1)[0]);
      }

      updateGameState(lobby);
      break;
    }
  });

  socket.on("leaveGame", () => {
    for (let lobbyId in lobbies) {
      const lobby = lobbies[lobbyId];
      if (!lobby.playerMap[socket.id]) continue;

      const player = lobby.players.find(p => p.id === socket.id);
      const hand = player.hand;
      const remaining = lobby.players.filter(p => p.id !== socket.id);

      let i = 0;
      while (hand.length) {
        remaining[i % remaining.length].hand.push(hand.pop());
        i++;
      }

      lobby.players = remaining;
      lobby.turnOrder = lobby.turnOrder.filter(id => id !== socket.id);
      delete lobby.playerMap[socket.id];

      if (lobby.players.length === 1) {
        io.to(lobby.players[0].id).emit("gameOver", { message: "🎉 Congratulations, you are the Champion!" });
        delete lobbies[lobbyId];
        return;
      }

      updateGameState(lobby);
    }
  });

  socket.on("disconnect", () => {
    socket.emit("leaveGame");
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log("UNO server running on port 3000");
});
