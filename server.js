const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const path = require("path");

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

let lobbies = {};
let topScores = {};

function getDeck() {
  const colors = ["red", "green", "blue", "yellow"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw"];
  const wilds = ["wild", "wild_draw4"];

  const deck = [];

  for (const color of colors) {
    for (const value of values) {
      const count = value === "0" ? 1 : 2;
      for (let i = 0; i < count; i++) {
        deck.push(`${color}_${value}.png`);
      }
    }
  }

  wilds.forEach(w => {
    for (let i = 0; i < 2; i++) deck.push(`${w}.png`);
  });

  return shuffle(deck);
}

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

function dealCards(deck, count = 7) {
  return Array.from({ length: count }, () => deck.pop());
}

function emitState(lobby) {
  lobby.players.forEach(p => {
    io.to(p.id).emit("gameState", {
      players: lobby.players.map(q => ({
        id: q.id,
        name: q.name,
        handCount: q.hand.length,
        score: q.score || 0
      })),
      currentTurn: lobby.currentTurn,
      topCard: lobby.discard[lobby.discard.length - 1],
      lastWildColor: lobby.lastWildColor,
      yourHand: p.hand
    });
  });
}

function systemMessage(lobby, message) {
  io.to(lobby.id).emit("chatMessage", { from: "SUE", text: message, color: "navy" });
}

function startTurn(lobby) {
  const current = lobby.players[lobby.turnIndex];
  clearTimeout(lobby.timeout);
  lobby.timeout = setTimeout(() => {
    current.missed = (current.missed || 0) + 1;
    if (current.missed >= 3) {
      removePlayer(current.id, lobby);
      if (lobby.players.length === 1) {
        const winner = lobby.players[0];
        topScores[winner.name] = (topScores[winner.name] || 0) + winner.score;
        systemMessage(lobby, `🎉 Congratulations ${winner.name}, you are the Champion!`);
        return delete lobbies[lobby.id];
      }
    } else {
      current.hand.push(lobby.deck.pop());
    }
    nextTurn(lobby);
  }, 60000);
}

function nextTurn(lobby) {
  lobby.turnIndex = (lobby.turnIndex + 1) % lobby.players.length;
  lobby.currentTurn = lobby.players[lobby.turnIndex].id;
  emitState(lobby);
  startTurn(lobby);
}

function removePlayer(id, lobby) {
  const leaver = lobby.players.find(p => p.id === id);
  if (!leaver) return;

  const index = lobby.players.findIndex(p => p.id === id);
  lobby.players.splice(index, 1);

  if (leaver.hand.length) {
    const split = Math.floor(leaver.hand.length / lobby.players.length);
    lobby.players.forEach(p => {
      p.hand.push(...leaver.hand.splice(0, split));
    });
    while (leaver.hand.length) {
      lobby.players[0].hand.push(leaver.hand.pop());
    }
  }

  if (lobby.players.length === 0) {
    delete lobbies[lobby.id];
  }
}

function startGame(lobby) {
  const deck = getDeck();
  const discard = [deck.pop()];
  lobby.deck = deck;
  lobby.discard = discard;
  lobby.turnIndex = 0;
  lobby.currentTurn = lobby.players[0].id;
  lobby.lastWildColor = null;
  lobby.players.forEach(p => {
    p.hand = dealCards(deck);
    p.score = 0;
    p.missed = 0;
  });

  systemMessage(lobby, "🎮 Game is starting!");
  systemMessage(lobby, "🎯 Turn order: " + lobby.players.map(p => p.name).join(", "));
  emitState(lobby);
  startTurn(lobby);
}

io.on("connection", socket => {
  socket.on("joinLobby", ({ playerName, lobbyId }) => {
    let lobby = lobbies[lobbyId] || { id: lobbyId, players: [], chat: [], created: Date.now() };
    if (lobby.players.length >= 10) {
      return socket.emit("chatMessage", { from: "SUE", text: "❌ Lobby is full!", color: "navy" });
    }

    const player = {
      id: socket.id,
      name: playerName,
      hand: [],
      score: 0,
      color: ["red", "blue", "green", "yellow"][Math.floor(Math.random() * 4)]
    };

    socket.join(lobbyId);
    lobby.players.push(player);
    lobbies[lobbyId] = lobby;

    if (lobby.players.length >= 2 && !lobby.starting) {
      lobby.starting = true;
      let countdown = 30;
      const interval = setInterval(() => {
        systemMessage(lobby, `🕒 Game starting in ${countdown}s`);
        countdown -= 5;
        if (countdown <= 0) {
          clearInterval(interval);
          startGame(lobby);
        }
      }, 5000);
    } else {
      systemMessage(lobby, `Waiting for more players...`);
    }
  });

  socket.on("playCard", ({ card, wildColor }) => {
    const lobby = Object.values(lobbies).find(l => l.currentTurn === socket.id);
    if (!lobby) return;

    const player = lobby.players.find(p => p.id === socket.id);
    const index = player.hand.indexOf(card);
    if (index === -1) return;

    const top = lobby.discard[lobby.discard.length - 1];
    const topColor = top.split("_")[0];
    const topValue = top.split("_")[1].split(".")[0];
    const [cardColor, cardValue] = card.split("_");

    if (
      card.startsWith("wild") ||
      cardColor === topColor ||
      cardValue === topValue ||
      (lobby.lastWildColor && cardColor === lobby.lastWildColor)
    ) {
      player.hand.splice(index, 1);
      lobby.discard.push(card);
      lobby.lastWildColor = card.startsWith("wild") ? wildColor : null;

      if (player.hand.length === 0) {
        player.score += lobby.players.reduce((sum, p) =>
          sum + p.hand.length * 10, 0);
        topScores[player.name] = (topScores[player.name] || 0) + player.score;
        systemMessage(lobby, `🏆 ${player.name} won the round!`);
        startGame(lobby);
        return;
      }

      nextTurn(lobby);
    }
  });

  socket.on("drawCard", () => {
    const lobby = Object.values(lobbies).find(l => l.currentTurn === socket.id);
    if (!lobby) return;
    const player = lobby.players.find(p => p.id === socket.id);
    player.hand.push(lobby.deck.pop());
    nextTurn(lobby);
  });

  socket.on("chatMessage", msg => {
    const lobby = Object.values(lobbies).find(l => l.players.find(p => p.id === socket.id));
    if (!lobby) return;
    const player = lobby.players.find(p => p.id === socket.id);
    io.to(lobby.id).emit("chatMessage", { from: player.name, text: msg, color: player.color });
  });

  socket.on("turnTimeout", () => {
    const lobby = Object.values(lobbies).find(l => l.currentTurn === socket.id);
    if (!lobby) return;
    nextTurn(lobby);
  });

  socket.on("leaveGame", () => {
    const lobby = Object.values(lobbies).find(l => l.players.find(p => p.id === socket.id));
    if (!lobby) return;
    removePlayer(socket.id, lobby);
    emitState(lobby);
  });

  // Admin tools
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
    socket.emit("adminTopScores", topScores);
  });
});

server.listen(PORT, () => {
  console.log(`UNO server running on http://localhost:${PORT}`);
});
