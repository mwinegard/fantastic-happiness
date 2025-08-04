const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const fs = require("fs");

const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

let lobbies = {};
let scores = {};

// Load scores
try {
  scores = JSON.parse(fs.readFileSync("scores.json", "utf8"));
} catch {
  scores = {};
}

// Special card effects
const specialCardLogic = {
  wild_boss: (game, currentPlayerId) => {
    const bossIndex = game.players.findIndex(p => p.id === currentPlayerId);
    if (bossIndex === -1) return;
    game.players.forEach(p => {
      if (p.id !== currentPlayerId && game.hands[p.id]?.length) {
        const card = game.hands[p.id].pop();
        game.hands[currentPlayerId].push(card);
      }
    });
    io.to(currentPlayerId).emit("chat", {
      from: "SUE",
      message: "🎁 THE BOSS: You receive a card from each player!"
    });
  },
  green_recycle: (game) => {
    const allCards = [];
    Object.keys(game.hands).forEach(pid => {
      allCards.push(...game.hands[pid]);
      game.hands[pid] = [];
    });
    shuffle(allCards);
    const playerIds = Object.keys(game.hands);
    allCards.forEach((card, i) => {
      const pid = playerIds[i % playerIds.length];
      game.hands[pid].push(card);
    });
    io.to(game.lobby).emit("chat", {
      from: "SUE",
      message: "♻️ RECYCLING: Hands shuffled and redistributed!"
    });
  }
};

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function generateDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  const deck = [];

  colors.forEach(color => {
    for (let i = 0; i <= 9; i++) {
      deck.push(`${color}_${i}`);
      if (i !== 0) deck.push(`${color}_${i}`);
    }
    ["skip", "reverse", "draw2"].forEach(action => {
      deck.push(`${color}_${action}`, `${color}_${action}`);
    });
  });

  for (let i = 0; i < 4; i++) {
    deck.push("wild", "wild_draw4");
  }

  deck.push("wild_boss", "green_recycle"); // Add more custom cards here
  shuffle(deck);
  return deck;
}

function getNextPlayer(game, skip = 1) {
  game.turnIndex = (game.turnIndex + skip) % game.players.length;
  game.turn = game.players[game.turnIndex].id;
}

function emitState(lobby) {
  const game = lobbies[lobby];
  if (!game) return;
  io.to(lobby).emit("state", {
    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      handSize: game.hands[p.id]?.length || 0,
      score: p.score || 0
    })),
    discardTop: game.discardPile[game.discardPile.length - 1],
    turn: game.turn
  });
}

function updateScores(winnerId, game) {
  if (!scores[winnerId]) scores[winnerId] = { wins: 0, points: 0 };
  scores[winnerId].wins++;

  let points = 0;
  Object.entries(game.hands).forEach(([pid, hand]) => {
    if (pid !== winnerId) {
      hand.forEach(card => {
        if (card.includes("wild")) points += 50;
        else if (card.includes("draw") || card.includes("reverse") || card.includes("skip")) points += 20;
        else points += 10;
      });
    }
  });

  scores[winnerId].points += points;
  fs.writeFileSync("scores.json", JSON.stringify(scores, null, 2));
}

function startGameIfReady(game, lobby) {
  if (!game.started && game.players.length >= 2) {
    console.log(`✅ Starting game in lobby '${lobby}' with ${game.players.length} players`);
    game.started = true;
    game.deck = generateDeck();
    game.hands = {};
    game.players.forEach(p => {
      game.hands[p.id] = [];
      for (let i = 0; i < 7; i++) {
        game.hands[p.id].push(game.deck.pop());
      }
    });
    game.turnIndex = 0;
    game.turn = game.players[0].id;
    game.discardPile = [game.deck.pop()];
    emitState(lobby);
    io.to(lobby).emit("chat", { from: "SUE", message: "🃏 Game started!" });
  } else {
    console.log(`Waiting for more players in lobby '${lobby}' (${game.players.length}/2)`);
  }
}

// ───────────────────────────────────────────────────────────────

io.on("connection", socket => {
  socket.on("join", ({ name, lobby }) => {
    console.log(`🔌 ${name} joined lobby: ${lobby}`);

    if (!lobbies[lobby]) {
      lobbies[lobby] = {
        players: [],
        hands: {},
        discardPile: [],
        deck: [],
        started: false,
        lobby,
        turnIndex: 0,
        turn: null
      };
    }

    const game = lobbies[lobby];

    if (game.started) {
      socket.emit("joinDenied", "Game already in progress.");
      console.log(`❌ ${name} was denied join (game in progress)`);
      return;
    }

    socket.join(lobby);
    game.players.push({ id: socket.id, name });

    io.to(lobby).emit("chat", { from: "SUE", message: `${name} joined.` });

    startGameIfReady(game, lobby);
  });

  socket.on("playCard", ({ card, chosenColor }) => {
    for (const [lobbyId, game] of Object.entries(lobbies)) {
      if (!game.started || socket.id !== game.turn) continue;

      const hand = game.hands[socket.id];
      const index = hand.indexOf(card);
      if (index === -1) return;

      hand.splice(index, 1);
      const baseCard = card.includes("wild") && chosenColor ? `${chosenColor}_${card}` : card;
      game.discardPile.push(baseCard);

      // Handle card effects
      if (card.includes("skip")) getNextPlayer(game, 2);
      else if (card.includes("reverse")) {
        game.players.reverse();
        game.turnIndex = game.players.findIndex(p => p.id === socket.id);
        getNextPlayer(game, game.players.length === 2 ? 2 : 1);
      } else if (card.includes("draw2")) {
        const next = game.players[(game.turnIndex + 1) % game.players.length];
        game.hands[next.id].push(game.deck.pop(), game.deck.pop());
        getNextPlayer(game, 2);
      } else if (card === "wild_draw4") {
        const next = game.players[(game.turnIndex + 1) % game.players.length];
        for (let i = 0; i < 4; i++) game.hands[next.id].push(game.deck.pop());
        getNextPlayer(game, 2);
      } else if (specialCardLogic[card]) {
        specialCardLogic[card](game, socket.id);
        getNextPlayer(game, 1);
      } else {
        getNextPlayer(game, 1);
      }

      if (hand.length === 0) {
        updateScores(socket.id, game);
        io.to(lobbyId).emit("chat", { from: "SUE", message: `${game.players.find(p => p.id === socket.id).name} wins the round!` });
        game.started = false;
        return;
      }

      emitState(lobbyId);
    }
  });

  socket.on("drawCard", () => {
    for (const [lobbyId, game] of Object.entries(lobbies)) {
      if (!game.started || socket.id !== game.turn) continue;

      if (game.deck.length === 0) {
        game.deck = [...game.discardPile.splice(0, game.discardPile.length - 1)];
        shuffle(game.deck);
      }

      const card = game.deck.pop();
      game.hands[socket.id].push(card);
      emitState(lobbyId);
    }
  });

  socket.on("disconnect", () => {
    for (const [lobbyId, game] of Object.entries(lobbies)) {
      const index = game.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        const name = game.players[index].name;
        console.log(`⚠️ ${name} disconnected from lobby ${lobbyId}`);
        game.players.splice(index, 1);
        delete game.hands[socket.id];

        // Auto-win if only one player remains
        if (game.players.length === 1 && game.started) {
          const winner = game.players[0].id;
          updateScores(winner, game);
          io.to(lobbyId).emit("chat", { from: "SUE", message: `${game.players[0].name} wins by default (last player remaining).` });
          game.started = false;
        }

        // Reset game if not enough players remain
        if (game.players.length < 2) {
          console.log(`⛔ Resetting lobby '${lobbyId}' due to low player count.`);
          game.started = false;
          game.deck = [];
          game.discardPile = [];
          game.hands = {};
          game.turn = null;
        }

        // Adjust turn index
        if (index < game.turnIndex) game.turnIndex--;
        if (game.players.length > 0) {
          game.turnIndex %= game.players.length;
          game.turn = game.players[game.turnIndex].id;
        }

        io.to(lobbyId).emit("chat", { from: "SUE", message: `${name} left.` });
        emitState(lobbyId);
      }
    }
  });
});

app.get("/scores", (req, res) => {
  res.json(scores);
});

http.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
