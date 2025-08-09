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
 * Persistent Scores
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

// Animals for default names; spelled-out numbers prefix
const ANIMALS = ["Aardvark","Badger","Cougar","Dolphin","Eagle","Fox","Giraffe","Hedgehog","Iguana","Jaguar","Koala","Lemur","Manatee","Narwhal","Otter","Panda","Quokka","Raccoon","Sloth","Turtle","Urchin","Vulture","Walrus","Yak","Zebra"];
const NUM_WORDS = ["One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten"];

function uniqueName(base) {
  let name = base.trim();
  if (!name) {
    const idx = Math.min(players.length, 9);
    name = `${NUM_WORDS[idx]} ${ANIMALS[Math.floor(Math.random()*ANIMALS.length)]}`;
  }
  // prevent duplicates
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
  if (card.type === "number") {
    return card.color === color || card.value === value;
  }
  // action cards match on color or same type
  return card.color === color || card.type === value; // we temporarily store last type in 'value' for actions
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
  // flip a non-wild top card
  let first = deck.pop();
  while (first.type !== "number") {
    deck.unshift(first); // bury back
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
    value: first.type === "number" ? first.value : first.type,
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
    // reshuffle discard (keep top)
    const top = game.discardPile.pop();
    game.deck = shuffle(game.discardPile);
    game.discardPile = [top];
  }
  const c = game.deck.pop();
  game.hands[id].push(c);
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

function legalPlaysFor(id) {
  if (!game) return [];
  const hand = game.hands[id] || [];
  const out = [];
  for (let i=0;i<hand.length;i++) {
    if (cardMatchesTop(hand[i], game.color, game.value)) out.push(i);
  }
  return out;
}

function tickTurnTimer() {
  if (!game?.started) return;
  if (!game.current) return;
  if (Date.now() >= game.turnEndsAt) {
    // turn timeout
    const p = players.find(x=>x.id===game.current);
    if (p) {
      p.misses = (p.misses||0)+1;
      const c = drawOne(p.id);
      announce(`⏰ ${p.name} ran out of time and drew a card.`);
      io.to(p.id).emit("playSound", "draw");
      if (p.misses >= MISSES_TO_KICK) {
        announce(`🚪 ${p.name} removed after ${MISSES_TO_KICK} missed turns.`);
        // dump their hand back and reshuffle into deck
        for (const card of game.hands[p.id] || []) game.deck.push(card);
        delete game.hands[p.id];
        const idx = players.findIndex(pp=>pp.id===p.id);
        if (idx>=0) players.splice(idx,1);
        // adjust turnIndex if needed
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
  // Join
  socket.on("join", (rawName) => {
    const name = uniqueName(String(rawName||""));
    const existing = players.find(p=>p.id===socket.id);
    if (!existing) {
      const spectator = players.filter(p=>!p.spectator).length >= MAX_PLAYERS || !!(game?.started);
      players.push({ id: socket.id, name, spectator, misses: 0, joinedAt: Date.now() });
      socket.emit("me", { id: socket.id, name, spectator });
      announce(`👤 ${name} ${spectator ? "joined as spectator." : "joined the game."}`);
      io.emit("playSound", "joined");
    }

    // If game running and we still have < MAX_PLAYERS, allow late-joiner as active with 7 cards
    if (game?.started) {
      const actives = players.filter(p=>!p.spectator);
      const me = players.find(p=>p.id===socket.id);
      if (me && me.spectator && actives.length < MAX_PLAYERS) {
        me.spectator = false;
        game.hands[me.id] = dealCards(game.deck, 7);
        // push to end of order
        const order = players.filter(p=>!p.spectator).map(p=>p.id);
        game.turnIndex = order.indexOf(game.current);
        announce(`➕ ${me.name} joined the round (late).`);
      }
    }

    // Start countdown if applicable
    if (!game?.started && players.filter(p=>!p.spectator).length >= 2) startCountdown();
    emitState();
  });

  // Chat
  socket.on("chat", (msg) => {
    const me = players.find(p=>p.id===socket.id);
    if (!me) return;
    io.emit("chat", { from: me.name, msg: String(msg).slice(0, 400) });
  });

  // Draw
  socket.on("drawCard", () => {
    if (!game?.started) return;
    if (game.current !== socket.id) return;
    drawOne(socket.id);
    io.to(socket.id).emit("playSound", "draw");
    announce(`🃏 ${players.find(p=>p.id===socket.id)?.name} drew a card.`);
    // One draw ends your action; advance turn
    advanceTurn(1);
    emitState();
  });

  // Play card
  socket.on("playCard", ({ index }) => {
    if (!game?.started) return;
    if (game.current !== socket.id) return;

    const hand = game.hands[socket.id] || [];
    if (typeof index !== "number" || index < 0 || index >= hand.length) return;
    const card = hand[index];

    if (!cardMatchesTop(card, game.color, game.value)) return; // illegal

    // Remove from hand and place
    hand.splice(index,1);

    if (card.type === "wild" || card.type === "wild_draw4") {
      // Ask for color
      io.to(socket.id).emit("chooseColor");
      // Temporarily put card on discard but don't apply color until chosen
      game.discardPile.push(card);
      game.value = card.type; // remember
      game.color = "wild";
      // effects afterwards once color chosen
      socket.once("colorChosen", ({ color }) => {
        const valid = ["red","yellow","green","blue"];
        if (!valid.includes(color)) color = valid[Math.floor(Math.random()*4)];
        game.color = color;

        // Apply wild effects
        if (card.type === "wild") {
          io.emit("playSound", "wild");
          announce(`🌈 ${players.find(p=>p.id===socket.id)?.name} chose ${color.toUpperCase()}.`);
          advanceTurn(1);
        } else {
          // Wild Draw Four
          io.emit("playSound", "wild");
          announce(`🌪️ ${players.find(p=>p.id===socket.id)?.name} played WILD +4 and chose ${color.toUpperCase()}.`);
          const order = players.filter(p=>!p.spectator).map(p=>p.id);
          const nextIdx = (game.turnIndex + game.direction + order.length) % order.length;
          const nextId = order[nextIdx];
          for (let i=0;i<4;i++) drawOne(nextId);
          advanceTurn(1); // skip to next after drawing player
        }

        // UNO penalty check (if going to 1 card without UNO flag)
        maybeUnoPenalty(socket.id);

        // Win?
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
    } else {
      // Normal / action card with known color
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
        // With 2 players, reverse acts like skip
        if (players.filter(p=>!p.spectator).length === 2) {
          advanceTurn(2);
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

      // Win?
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
    }
  });

  // UNO
  socket.on("callUno", () => {
    const hand = game?.hands?.[socket.id];
    if (!game?.started || !hand) return;
    // Mark a short-lived UNO flag for this player for this turn
    socket.unoCalled = true;
    io.emit("playSound", "uno");
    announce(`📣 ${players.find(p=>p.id===socket.id)?.name} called UNO!`);
  });

  // Admin broadcast sound
  socket.on("adminPlaySound", (name) => {
    io.emit("playSound", String(name));
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
    // If the socket didn't call UNO, penalize +2 immediately
    const s = io.sockets.sockets.get(id);
    if (!s?.unoCalled) {
      drawOne(id); drawOne(id);
      announce(`⚠️ UNO penalty applied (+2).`);
    }
  }
  // Clear UNO flag for everyone at end of action
  for (const [sid, sock] of io.sockets.sockets) sock.unoCalled = false;
}

http.listen(PORT, () => {
  console.log("Server listening on", PORT);
});

// Send my hand snapshot (privacy: only to requester)
socket.on("getMyHand", () => {
  if (!game?.hands?.[socket.id]) {
    socket.emit("handSnapshot", []);
  } else {
    socket.emit("handSnapshot", game.hands[socket.id]);
  }
});
