const express = require("express");
const fs = require("fs");
const httpServer = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const app = express();
const http = httpServer.createServer(app);
const io = new Server(http, { cors: { origin: "*" } });

app.use(express.static("public"));

/** -----------------------
 * Persistent Scores (ephemeral on Render unless a disk is attached)
 * ---------------------- */
const SCORES_PATH = "./scores.json";
let scores = {};
try {
  if (fs.existsSync(SCORES_PATH)) {
    scores = JSON.parse(fs.readFileSync(SCORES_PATH, "utf8") || "{}");
  }
} catch {
  scores = {};
}
function saveScores() {
  try {
    fs.writeFileSync(SCORES_PATH, JSON.stringify(scores, null, 2));
  } catch (e) {
    console.error("Failed writing scores:", e);
  }
}
app.get("/scores", (_req, res) => {
  res.json(scores);
});

/** -----------------------
 * Game State
 * ---------------------- */
let players = []; // {id, name, spectator, misses, joinedAt}
let game = null;  // null or {started, deck, discardPile, turnIndex, direction, color, value, current, hands, countdownEndsAt, turnEndsAt}
let countdownTimer = null;
let turnInterval = null;

const MAX_PLAYERS = 10;
const TURN_SECONDS = 60;
const COUNTDOWN_SECONDS = 30;
const MISSES_TO_KICK = 3;

// Default names: Number + Animal
const ANIMALS = ["Aardvark","Badger","Cougar","Dolphin","Eagle","Fox","Giraffe","Hedgehog","Iguana","Jaguar","Koala","Lemur","Manatee","Narwhal","Otter","Panda","Quokka","Raccoon","Sloth","Turtle","Urchin","Vulture","Walrus","Yak","Zebra"];
const NUM_WORDS = ["One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten"];

function uniqueName(base) {
  let name = String(base || "").trim();
  if (!name) {
    const idx = Math.min(players.length, 9);
    name = `${NUM_WORDS[idx]} ${ANIMALS[Math.floor(Math.random()*ANIMALS.length)]}`;
  }
  const taken = new Set(players.map(p => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let n = 2;
  while (taken.has(`${name} ${n}`.toLowerCase())) n++;
  return `${name} ${n}`;
}

function announce(text) {
  io.emit("announce", text);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateDeck() {
  const colors = ["red", "yellow", "green", "blue"];
  const deck = [];
  for (const c of colors) {
    deck.push({color:c, type:"number", value:0});
    for (let v=1; v<=9; v++) {
      deck.push({color:c, type:"number", value:v});
      deck.push({color:c, type:"number", value:v});
    }
    for (let i=0;i<2;i++) {
      deck.push({color:c, type:"skip"});
      deck.push({color:c, type:"reverse"});
      deck.push({color:c, type:"draw2"});
    }
  }
  for (let i=0;i<4;i++) {
    deck.push({color:"wild", type:"wild"});
    deck.push({color:"wild", type:"wild_draw4"});
  }
  return shuffle(deck);
}

function cardMatchesTop(card, color, value) {
  if (card.type === "wild" || card.type === "wild_draw4") return true;
  if (card.type === "number") return card.color === color || card.value === value;
  // for action cards we store last type in `value`
  return card.color === color || card.type === value;
}

function dealCards(deck, n) {
  const out = [];
  for (let i=0;i<n;i++) out.push(deck.pop());
  return out;
}

function initGame() {
  const active = players.filter(p => !p.spectator);
  const deck = generateDeck();
  const hands = {};
  for (const p of active) {
    hands[p.id] = dealCards(deck, 7);
  }
  // Ensure first top is a number card
  let first = deck.pop();
  while (first.type !== "number") {
    deck.unshift(first);
    shuffle(deck);
    first = deck.pop();
  }
  game = {
    started: true,
    deck,
    discardPile: [first],
    turnIndex: 0,
    direction: 1,
    color: first.color,
    value: first.value, // numeric
    hands,
    current: active[0]?.id || null,
    countdownEndsAt: null,
    turnEndsAt: Date.now() + TURN_SECONDS*1000,
  };
  for (const p of players) p.misses = 0;
  clearInterval(turnInterval);
  turnInterval = setInterval(tickTurnTimer, 250);
  announce("🎉 Game started!");
  io.emit("playSound", "start");
  emitState();
}

function startCountdown() {
  if (game?.started || countdownTimer) return;
  const activeCount = players.filter(p=>!p.spectator).length;
  if (activeCount < 2) return;
  const endsAt = Date.now() + COUNTDOWN_SECONDS*1000;
  game = { started: false, countdownEndsAt: endsAt };
  announce("⏳ Game starts in 30 seconds…");
  countdownTimer = setInterval(() => {
    const stillEnough = players.filter(p=>!p.spectator).length >= 2;
    if (!stillEnough) {
      clearInterval(countdownTimer); countdownTimer = null; game = null;
      announce("❌ Countdown canceled—need at least 2 players.");
      emitState();
      return;
    }
    if (Date.now() >= endsAt) {
      clearInterval(countdownTimer); countdownTimer = null;
      initGame();
    } else {
      emitState();
    }
  }, 500);
}

function endGameIfNeeded() {
  const active = players.filter(p=>!p.spectator);
  if (active.length <= 1 && game) {
    game = null;
    announce("❗ Game ended. Not enough players.");
    emitState();
  }
}

function drawOne(id) {
  if (!game) return null;
  if (game.deck.length === 0) {
    const top = game.discardPile.pop();
    game.deck = shuffle(game.discardPile);
    game.discardPile = [top];
  }
  const c = game.deck.pop();
  const hand = game.hands[id];
  if (hand) hand.push(c);
  return c;
}

function advanceTurn(skipCount=1) {
  if (!game) return;
  const order = players.filter(p=>!p.spectator).map(p=>p.id);
  if (order.length === 0) { endGameIfNeeded(); return; }
  let idx = game.turnIndex;
  for (let i=0;i<skipCount;i++) {
    idx = (idx + game.direction + order.length) % order.length;
  }
  game.turnIndex = idx;
  game.current = order[idx];
  game.turnEndsAt = Date.now() + TURN_SECONDS*1000;
}

function emitState() {
  const state = {
    started: !!game?.started,
    countdownEndsAt: game?.countdownEndsAt || null,
    turnEndsAt: game?.turnEndsAt || null,
    current: game?.current || null,
    direction: game?.direction || 1,
    color: game?.color || null,
    top: game?.discardPile?.[game.discardPile.length-1] || null,
    players: players.map(p => ({
      id: p.id,
      name: p.name,
      spectator: !!p.spectator,
      handCount: game?.hands?.[p.id]?.length ?? 0
    }))
  };
  io.emit("state", state);
}

function winnerIfAny() {
  if (!game) return null;
  for (const id of Object.keys(game.hands)) {
    if (game.hands[id].length === 0) return id;
  }
  return null;
}

function addScore(winnerId) {
  const p = players.find(p=>p.id===winnerId);
  if (!p) return;
  scores[p.name] = (scores[p.name] || 0) + 1;
  saveScores();
}

function tickTurnTimer() {
  if (!game?.started) return;
  if (!game.current) return;
  if (Date.now() >= game.turnEndsAt) {
    const p = players.find(x=>x.id===game.current);
    if (p && !p.spectator) {
      p.misses = (p.misses||0)+1;
      drawOne(p.id);
      announce(`⏰ ${p.name} ran out of time and drew a card.`);
      io.to(p.id).emit("playSound", "draw");
      if (p.misses >= MISSES_TO_KICK) {
        announce(`🚪 ${p.name} removed after ${MISSES_TO_KICK} missed turns.`);
        for (const card of game.hands[p.id] || []) game.deck.push(card);
        delete game.hands[p.id];
        const idx = players.findIndex(pp=>pp.id===p.id);
        if (idx>=0) players.splice(idx,1);
        const order = players.filter(pp=>!pp.spectator).map(pp=>pp.id);
        if (order.length === 0) { endGameIfNeeded(); return; }
        game.turnIndex = order.indexOf(game.current);
      }
    }
    advanceTurn(1);
    emitState();
  }
}

/** -----------------------
 * Socket Handlers
 * ---------------------- */
io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  // Join
  socket.on("join", (rawName) => {
    const name = uniqueName(String(rawName||""));
    let player = players.find(p=>p.id===socket.id);
    if (!player) {
      const spectator = players.filter(p=>!p.spectator).length >= MAX_PLAYERS || !!(game?.started);
      player = { id: socket.id, name, spectator, misses: 0, joinedAt: Date.now() };
      players.push(player);
    } else if (rawName && rawName.trim()) {
      player.name = name;
    }

    // Immediate ACK so UI can advance from join screen
    socket.emit("me", { id: socket.id, name: player.name, spectator: player.spectator });

    announce(`👤 ${player.name} ${player.spectator ? "joined as spectator." : "joined the game."}`);
    io.emit("playSound", "joined");

    // If game is running and there's room, promote a spectator who just joined
    if (game?.started) {
      const actives = players.filter(p=>!p.spectator);
      if (player.spectator && actives.length < MAX_PLAYERS) {
        player.spectator = false;
        game.hands[player.id] = dealCards(game.deck, 7);
        announce(`➕ ${player.name} joined the round (late).`);
      }
    }

    // Start countdown if we have enough active players
    if (!game?.started && players.filter(p=>!p.spectator).length >= 2) startCountdown();

    emitState();
  });

  // Chat
  socket.on("chat", (msg) => {
    const me = players.find(p=>p.id===socket.id);
    if (!me) return;
    io.emit("chat", { from: me.name, msg: String(msg).slice(0, 400) });
  });

  // Draw a card (only on your turn)
  socket.on("drawCard", () => {
    if (!game?.started) return;
    if (game.current !== socket.id) return;
    drawOne(socket.id);
    io.to(socket.id).emit("playSound", "draw");
    announce(`🃏 ${players.find(p=>p.id===socket.id)?.name} drew a card.`);
    advanceTurn(1);
    emitState();
  });

  // Play a card
  socket.on("playCard", ({ index }) => {
    if (!game?.started) return;
    if (game.current !== socket.id) return;

    const hand = game.hands[socket.id] || [];
    if (typeof index !== "number" || index < 0 || index >= hand.length) return;
    const card = hand[index];

    if (!cardMatchesTop(card, game.color, game.value)) return;

    // Remove from hand, place on discard
    hand.splice(index,1);

    if (card.type === "wild" || card.type === "wild_draw4") {
      io.to(socket.id).emit("chooseColor");
      game.discardPile.push(card);
      game.value = card.type; // remember type until color is chosen
      game.color = "wild";

      socket.once("colorChosen", ({ color }) => {
        const valid = ["red","yellow","green","blue"];
        const chosen = valid.includes(color) ? color : valid[Math.floor(Math.random()*4)];
        game.color = chosen;

        if (card.type === "wild") {
          io.emit("playSound", "wild");
          announce(`🌈 ${players.find(p=>p.id===socket.id)?.name} chose ${chosen.toUpperCase()}.`);
          advanceTurn(1);
        } else {
          io.emit("playSound", "wild");
          announce(`🌪️ ${players.find(p=>p.id===socket.id)?.name} played WILD +4 and chose ${chosen.toUpperCase()}.`);
          const order = players.filter(p=>!p.spectator).map(p=>p.id);
          const nextIdx = (game.turnIndex + game.direction + order.length) % order.length;
          const nextId = order[nextIdx];
          for (let i=0;i<4;i++) drawOne(nextId);
          advanceTurn(1);
        }

        maybeUnoPenalty(socket.id);

        const w = winnerIfAny();
        if (w) {
          const winnerName = players.find(p=>p.id===w)?.name || "Player";
          announce(`🏆 ${winnerName} wins the round!`);
          addScore(w);
          io.emit("playSound", "win");
          game = null;
          emitState();
          return;
        }
        emitState();
      });
      return;
    }

    // Normal / action card
    game.discardPile.push(card);
    game.color = card.color;
    game.value = card.type === "number" ? card.value : card.type;

    if (card.type === "number") {
      io.emit("playSound", "number");
      advanceTurn(1);
    } else if (card.type === "skip") {
      io.emit("playSound", "skip");
      announce(`⛔ ${players.find(p=>p.id===socket.id)?.name} skipped the next player.`);
      advanceTurn(2);
    } else if (card.type === "reverse") {
      io.emit("playSound", "reverse");
      game.direction *= -1;
      announce(`🔁 Turn order reversed.`);
      if (players.filter(p=>!p.spectator).length === 2) {
        advanceTurn(2); // reverse acts like skip in 2-player game
      } else {
        advanceTurn(1);
      }
    } else if (card.type === "draw2") {
      io.emit("playSound", "skip");
      const order = players.filter(p=>!p.spectator).map(p=>p.id);
      const nextIdx = (game.turnIndex + game.direction + order.length) % order.length;
      const nextId = order[nextIdx];
      drawOne(nextId); drawOne(nextId);
      announce(`➕2 Next player drew two cards.`);
      advanceTurn(2);
    }

    maybeUnoPenalty(socket.id);

    const w = winnerIfAny();
    if (w) {
      const winnerName = players.find(p=>p.id===w)?.name || "Player";
      announce(`🏆 ${winnerName} wins the round!`);
      addScore(w);
      io.emit("playSound", "win");
      game = null;
      emitState();
      return;
    }
    emitState();
  });

  // UNO call (sets a temp flag for this turn)
  socket.on("callUno", () => {
    const hand = game?.hands?.[socket.id];
    if (!game?.started || !hand) return;
    socket.unoCalled = true;
    io.emit("playSound", "uno");
    announce(`📣 ${players.find(p=>p.id===socket.id)?.name} called UNO!`);
  });

  // Admin: broadcast a sound to all clients
  socket.on("adminPlaySound", (name) => {
    io.emit("playSound", String(name));
  });

  // Hand snapshot — MUST be inside connection scope
  socket.on("getMyHand", () => {
    const hand = game?.hands?.[socket.id] || [];
    socket.emit("handSnapshot", hand);
    socket.emit("myHand", hand); // legacy listener support
  });

  socket.on("disconnect", () => {
    const idx = players.findIndex(p=>p.id===socket.id);
    if (idx >= 0) {
      const gone = players[idx];
      players.splice(idx,1);
      announce(`👋 ${gone.name} left.`);
    }
    endGameIfNeeded();
    emitState();
  });
});

function maybeUnoPenalty(id) {
  if (!game) return;
  const hand = game.hands[id];
  if (!hand) return;
  if (hand.length === 1) {
    const s = io.sockets.sockets.get(id);
    if (!s?.unoCalled) {
      drawOne(id); drawOne(id);
      announce(`⚠️ UNO penalty applied (+2).`);
    }
  }
  // clear UNO flags end-of-action
  for (const [, sock] of io.sockets.sockets) sock.unoCalled = false;
}

http.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
