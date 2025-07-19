const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const scoresFile = path.join(__dirname, "scores.json");
const lobbies = {};

// Load or initialize scores
let scores = {};
if (fs.existsSync(scoresFile)) {
  scores = JSON.parse(fs.readFileSync(scoresFile, "utf8"));
}

function saveScores() {
  fs.writeFileSync(scoresFile, JSON.stringify(scores, null, 2));
}

function createDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw"];
  const wilds = ["wild", "wild_draw4"];
  const deck = [];

  for (let color of colors) {
    for (let val of values) {
      deck.push(`${color}_${val}`);
      deck.push(`${color}_${val}`);
    }
  }

  for (let w of wilds) {
    for (let i = 0; i < 4; i++) deck.push(w);
  }

  return deck;
}

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

function emitState(lobby) {
  const { id, players, hands, discardPile, currentTurn, wildColor } = lobby;
  const state = {
    players: Object.values(players).map(p => ({
      id: p.id,
      name: p.name,
      score: scores[p.name]?.score || 0,
      handSize: hands[p.id]?.length || 0
    })),
    hands,
    discardPile,
    currentTurn,
    wildColor
  };
  io.to(id).emit("state", state);
}

function validPlay(card, topCard, wildColor) {
  if (!card || !topCard) return false;

  const [cardColor, cardVal] = card.includes("wild") ? [null, card] : card.split("_");
  const [topColor, topVal] = topCard.includes("wild") ? [null, topCard] : topCard.split("_");

  if (card.includes("wild")) return true;
  if (wildColor) return cardColor === wildColor;
  return cardColor === topColor || cardVal === topVal;
}

function calculateCardPoints(card) {
  if (!card) return 0;
  const parts = card.split("_");
  if (parts[0] === "wild") return 50;
  if (parts[1] === "skip" || parts[1] === "reverse" || parts[1] === "draw") return 20;
  if (!isNaN(parts[1])) return parseInt(parts[1], 10);
  return 0;
}

io.on("connection", (socket) => {
  socket.on("join", ({ name, lobby }) => {
    if (!name || !lobby) return;

    socket.join(lobby);
    if (!lobbies[lobby]) {
      lobbies[lobby] = {
        id: lobby,
        players: {},
        hands: {},
        deck: shuffle(createDeck()),
        discardPile: [],
        currentTurn: null,
        wildColor: null,
        direction: 1
      };
    }

    const lobbyObj = lobbies[lobby];
    const playerId = socket.id;

    if (Object.keys(lobbyObj.players).length >= 10) {
      socket.emit("error", "Lobby is full.");
      return;
    }

    lobbyObj.players[playerId] = { id: playerId, name };
    lobbyObj.hands[playerId] = lobbyObj.deck.splice(0, 7);

    if (!lobbyObj.currentTurn) {
      let top;
      do {
        top = lobbyObj.deck.pop();
      } while (top.includes("wild"));
      lobbyObj.discardPile.push(top);
      lobbyObj.currentTurn = playerId;
    }

    emitState(lobbyObj);
  });

  socket.on("playCard", ({ lobby, card, chosenColor, saidUNO }) => {
    const lobbyObj = lobbies[lobby];
    if (!lobbyObj) return;

    const playerId = socket.id;
    if (lobbyObj.currentTurn !== playerId) return;

    const hand = lobbyObj.hands[playerId];
    const index = hand.indexOf(card);
    if (index === -1) return;

    const topCard = lobbyObj.discardPile.at(-1);
    if (!validPlay(card, topCard, lobbyObj.wildColor)) return;

    hand.splice(index, 1);
    lobbyObj.discardPile.push(card);
    lobbyObj.wildColor = card.includes("wild") ? chosenColor : null;

    // Handle action cards
    const ids = Object.keys(lobbyObj.players);
    const idx = ids.indexOf(playerId);
    let nextIdx = (idx + lobbyObj.direction + ids.length) % ids.length;

    if (card.includes("reverse") && ids.length > 2) {
      lobbyObj.direction *= -1;
      nextIdx = (idx + lobbyObj.direction + ids.length) % ids.length;
    } else if (card.includes("skip")) {
      nextIdx = (nextIdx + lobbyObj.direction + ids.length) % ids.length;
    } else if (card.includes("draw")) {
      const nextId = ids[nextIdx];
      const drawn = lobbyObj.deck.splice(0, 2);
      if (drawn.length < 2) {
        // reshuffle
        const keepTop = lobbyObj.discardPile.pop();
        lobbyObj.deck = shuffle([...lobbyObj.discardPile]);
        lobbyObj.discardPile = [keepTop];
        drawn.push(...lobbyObj.deck.splice(0, 2 - drawn.length));
      }
      lobbyObj.hands[nextId].push(...drawn);
      nextIdx = (nextIdx + lobbyObj.direction + ids.length) % ids.length;
    }

    // Check win
    if (hand.length === 0) {
      let total = 0;
      for (let [pid, h] of Object.entries(lobbyObj.hands)) {
        if (pid !== playerId) {
          total += h.map(c => calculateCardPoints(c)).reduce((a, b) => a + b, 0);
        }
      }

      scores[lobbyObj.players[playerId].name] ??= { score: 0, wins: 0 };
      scores[lobbyObj.players[playerId].name].score += total;
      scores[lobbyObj.players[playerId].name].wins += 1;
      saveScores();

      // Reset hands & game state
      for (let pid of Object.keys(lobbyObj.hands)) {
        lobbyObj.hands[pid] = lobbyObj.deck.splice(0, 7);
      }
      lobbyObj.deck = shuffle(createDeck());
      let top;
      do {
        top = lobbyObj.deck.pop();
      } while (top.includes("wild"));
      lobbyObj.discardPile = [top];
    }

    lobbyObj.currentTurn = ids[nextIdx];
    emitState(lobbyObj);
  });

  socket.on("drawCard", ({ lobby }) => {
    const lobbyObj = lobbies[lobby];
    const playerId = socket.id;
    if (!lobbyObj || lobbyObj.currentTurn !== playerId) return;

    if (lobbyObj.deck.length === 0) {
      const top = lobbyObj.discardPile.pop();
      lobbyObj.deck = shuffle([...lobbyObj.discardPile]);
      lobbyObj.discardPile = [top];
    }

    const card = lobbyObj.deck.pop();
    lobbyObj.hands[playerId].push(card);
    emitState(lobbyObj);
  });

  socket.on("disconnect", () => {
    for (let lobbyId in lobbies) {
      const lobby = lobbies[lobbyId];
      if (lobby.players[socket.id]) {
        delete lobby.players[socket.id];
        delete lobby.hands[socket.id];
        if (Object.keys(lobby.players).length === 0) {
          delete lobbies[lobbyId];
        } else {
          emitState(lobby);
        }
        break;
      }
    }
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/scores.json", (req, res) => {
  res.json(scores);
});

app.get("/admin-state", (req, res) => {
  const data = Object.values(lobbies).map(lobby => ({
    id: lobby.id,
    players: Object.values(lobby.players).map(p => ({
      id: p.id,
      name: p.name,
      score: scores[p.name]?.score || 0,
      handSize: (lobby.hands[p.id] || []).length
    }))
  }));
  res.json(data);
});

app.post("/admin/kick/:lobby/:id", (req, res) => {
  const { lobby, id } = req.params;
  if (lobbies[lobby]) {
    delete lobbies[lobby].players[id];
    delete lobbies[lobby].hands[id];
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

app.post("/admin/close/:lobby", (req, res) => {
  delete lobbies[req.params.lobby];
  res.sendStatus(200);
});

app.post("/admin/clear-scores", (req, res) => {
  scores = {};
  saveScores();
  res.status(200).json({ message: "Scores reset" });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO server running on port ${PORT}`);
});
