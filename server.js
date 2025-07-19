const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

let lobbies = {};
let scoresTable = {};

function shuffleDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw"];
  const deck = [];

  for (let color of colors) {
    for (let value of values) {
      if (value === "0") deck.push({ color, value }); // Only one zero per color
      else deck.push({ color, value }, { color, value }); // Two of each other
    }
  }

  // Add wilds
  for (let i = 0; i < 4; i++) {
    deck.push({ color: "wild", value: "wild" });
    deck.push({ color: "wild", value: "draw4" });
  }

  return deck.sort(() => Math.random() - 0.5);
}

function emitState(lobby) {
  const state = {
    players: lobby.players.map(p => ({
      id: p.id,
      name: p.name,
      handSize: p.hand.length,
      color: p.color,
      score: p.score,
    })),
    currentTurn: lobby.turnOrder[lobby.currentTurnIndex],
    topCard: lobby.discard[lobby.discard.length - 1],
    drawPileCount: lobby.deck.length,
    chat: lobby.chat,
    wildColor: lobby.wildColor || null
  };

  lobby.players.forEach(p => {
    io.to(p.id).emit("gameState", {
      ...state,
      hand: p.hand
    });
  });
}

function startGame(lobbyId) {
  const lobby = lobbies[lobbyId];
  lobby.deck = shuffleDeck();
  lobby.discard = [lobby.deck.pop()];
  lobby.currentTurnIndex = 0;
  lobby.wildColor = null;
  lobby.started = true;

  for (let player of lobby.players) {
    player.hand = [];
    for (let i = 0; i < 7; i++) {
      player.hand.push(lobby.deck.pop());
    }
    player.missedTurns = 0;
  }

  sendSystemMessage(lobby, "SUE", `Game started with ${lobby.players.length} players`);
  emitState(lobby);
}

function sendSystemMessage(lobby, sender, message) {
  const styledMsg = {
    sender,
    text: message,
    system: true
  };
  lobby.chat.push(styledMsg);
  io.to(lobby.id).emit("chatMessage", styledMsg);
}

function removePlayer(socketId, lobby) {
  const index = lobby.players.findIndex(p => p.id === socketId);
  if (index !== -1) {
    const leaving = lobby.players.splice(index, 1)[0];
    sendSystemMessage(lobby, "SUE", `${leaving.name} has left.`);
    if (lobby.players.length === 0) {
      delete lobbies[lobby.id];
      return;
    }

    // Redistribute cards
    const cards = leaving.hand;
    let idx = 0;
    while (cards.length > 0) {
      lobby.players[idx % lobby.players.length].hand.push(cards.pop());
      idx++;
    }

    // Recalculate turn index
    if (lobby.currentTurnIndex >= lobby.players.length) {
      lobby.currentTurnIndex = 0;
    }

    // If one player remains
    if (lobby.players.length === 1) {
      const winner = lobby.players[0];
      winner.score += 100; // Award win
      scoresTable[winner.name] = (scoresTable[winner.name] || 0) + winner.score;
      sendSystemMessage(lobby, "SUE", `🎉 Congratulations ${winner.name}, you are the Champion!`);
    }

    emitState(lobby);
  }
}

io.on("connection", socket => {
  socket.on("joinLobby", ({ name, lobby }) => {
    if (!name || !lobby || name.length > 20 || lobby.length > 20) return;
    if (!lobbies[lobby]) {
      lobbies[lobby] = {
        id: lobby,
        players: [],
        deck: [],
        discard: [],
        chat: [],
        turnOrder: [],
        currentTurnIndex: 0,
        wildColor: null,
        started: false,
        timeout: null
      };
    }

    const lobbyObj = lobbies[lobby];
    if (lobbyObj.players.length >= 10) {
      socket.emit("lobbyFull");
      return;
    }

    const colorOptions = ["red", "blue", "yellow", "green"];
    const assignedColor = colorOptions[lobbyObj.players.length % 4];
    const player = {
      id: socket.id,
      name,
      hand: [],
      color: assignedColor,
      missedTurns: 0,
      score: 0
    };

    lobbyObj.players.push(player);
    socket.join(lobby);
    socket.emit("lobbyJoined", { lobby, playerName: name });
    sendSystemMessage(lobbyObj, "SUE", `${name} joined ${lobby}`);

    if (!lobbyObj.started && lobbyObj.players.length >= 2) {
      sendSystemMessage(lobbyObj, "SUE", `Waiting 30 seconds to start game...`);
      setTimeout(() => {
        if (!lobbyObj.started && lobbyObj.players.length >= 2) {
          lobbyObj.turnOrder = [...lobbyObj.players.map(p => p.id)];
          startGame(lobby);
        }
      }, 30000);
    }

    emitState(lobbyObj);
  });

  socket.on("playCard", ({ lobby, card, chosenColor }) => {
    const game = lobbies[lobby];
    const player = game.players.find(p => p.id === socket.id);
    if (game.turnOrder[game.currentTurnIndex] !== socket.id) return;

    const top = game.discard[game.discard.length - 1];
    const isValid =
      card.color === top.color ||
      card.value === top.value ||
      card.color === "wild";

    const handIndex = player.hand.findIndex(c => c.color === card.color && c.value === card.value);
    if (!isValid || handIndex === -1) return;

    player.hand.splice(handIndex, 1);
    game.discard.push(card);
    if (card.color === "wild") game.wildColor = chosenColor;

    // Next turn
    game.currentTurnIndex = (game.currentTurnIndex + 1) % game.players.length;
    emitState(game);
  });

  socket.on("drawCard", ({ lobby }) => {
    const game = lobbies[lobby];
    const player = game.players.find(p => p.id === socket.id);
    if (game.turnOrder[game.currentTurnIndex] !== socket.id) return;

    if (game.deck.length === 0) return;
    const drawn = game.deck.pop();
    player.hand.push(drawn);

    game.currentTurnIndex = (game.currentTurnIndex + 1) % game.players.length;
    emitState(game);
  });

  socket.on("chat", ({ lobby, text }) => {
    const game = lobbies[lobby];
    const player = game.players.find(p => p.id === socket.id);
    const message = {
      sender: player?.name || "???",
      text,
      system: false
    };
    game.chat.push(message);
    io.to(lobby).emit("chatMessage", message);
  });

  socket.on("disconnect", () => {
    for (const lobbyId in lobbies) {
      const lobby = lobbies[lobbyId];
      if (lobby.players.find(p => p.id === socket.id)) {
        removePlayer(socket.id, lobby);
        break;
      }
    }
  });

  // Admin logic
  socket.on("adminRequestLobbies", () => {
    socket.emit("adminLobbies", lobbies);
  });

  socket.on("adminKickPlayer", ({ lobbyId, playerId }) => {
    const lobby = lobbies[lobbyId];
    if (lobby) {
      removePlayer(playerId, lobby);
      emitState(lobby);
    }
  });

  socket.on("adminCloseLobby", (lobbyId) => {
    delete lobbies[lobbyId];
  });

  socket.on("adminRequestScores", () => {
    socket.emit("adminTopScores", scoresTable);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
