// UNO server with specialty cards, stacking (draw2/+4), wild_relax interrupt, rich announcements,
// HAPPY chat emoji moderation, Look/Shopping/Rainbow flows, Admin commands, and scoring (wins + points).
const express = require("express");
const http = require("http");
const fs = require("fs");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

/* ---------- Scores (persistent JSON) ---------- */
const SCORE_PATH = "./scores.json";
let scores = {};
try {
  if (fs.existsSync(SCORE_PATH)) {
    scores = JSON.parse(fs.readFileSync(SCORE_PATH, "utf8") || "{}");
  }
} catch { /* ignore */ }
function saveScores() {
  try { fs.writeFileSync(SCORE_PATH, JSON.stringify(scores, null, 2)); } catch { /* ignore */ }
}
app.get("/scores", (_req, res) => res.json(scores));

/* ---------- Scoring config ---------- */
const SCORING_MODE = "points"; // "points" | "wins"
const POINTS_TARGET = 500;

// Card points map (classic UNO + your specials)
const CARD_POINTS = {};
(function () {
  const cols = ["red", "blue", "green", "yellow"];
  for (const col of cols) {
    for (let n = 0; n <= 9; n++) CARD_POINTS[`${col}_${n}`] = n;
    CARD_POINTS[`${col}_skip`] = 20;
    CARD_POINTS[`${col}_reverse`] = 20;
    CARD_POINTS[`${col}_draw2`] = 20;
  }
  CARD_POINTS["wild"] = 50;
  CARD_POINTS["wild_draw4"] = 50;
  CARD_POINTS["wild_relax"] = 50;
  CARD_POINTS["wild_boss"] = 50;
  CARD_POINTS["wild_packyourbags"] = 50;
  CARD_POINTS["wild_rainbow"] = 50;
  // customs (action-strength = 20; shopping is stronger → 30)
  CARD_POINTS["blue_look"] = 20;
  CARD_POINTS["yellow_shopping"] = 30;
  CARD_POINTS["green_happy"] = 20;
  CARD_POINTS["green_recycle"] = 20;
  CARD_POINTS["yellow_pinkypromise"] = 20;
  CARD_POINTS["blue_moon"] = 20;
  CARD_POINTS["red_it"] = 20;
  CARD_POINTS["red_noc"] = 20;
})();

/* Leaderboard endpoint for admin UI */
app.get("/leaderboard", (_req, res) => {
  try {
    let arr = [];
    if (Array.isArray(scores)) arr = scores;
    else if (scores && typeof scores === "object") {
      const keys = Object.keys(scores);
      if (keys.length && typeof scores[keys[0]] === "object") {
        arr = keys.map((name) => ({
          name,
          wins: Number(scores[name].wins || 0),
          points: Number(scores[name].points || 0),
        }));
      } else {
        arr = keys.map((name) => ({ name, wins: Number(scores[name] || 0), points: 0 }));
      }
    }
    arr.sort((a, b) => (b.points - a.points) || (b.wins - a.wins) || a.name.localeCompare(b.name));
    res.json(arr);
  } catch {
    res.json([]);
  }
});

/* ---------- Game constants ---------- */
const MAX_PLAYERS = 10;
const TURN_SECONDS = 60;          // per-turn timer
const COUNTDOWN_SECONDS = 30;     // pre-round countdown
const COLORS = ["red", "blue", "green", "yellow"];

/* ---------- Runtime state ---------- */
let players = [];   // {id,sid,clientId,name,spectator,misses,lastChatAt}
let game = null;    // game state object
let turnTicker = null;
let countdownTimer = null;

/* ---------- Utils ---------- */
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }
function sample(a) { return a[(Math.random() * a.length) | 0]; }
function sidToName(sid) { return players.find(p => p.sid === sid)?.name || "Player"; }
function activeOrder() { return players.filter(p => !p.spectator).map(p => p.sid); }
function nextIdx(idx, dir, order) { return (idx + dir + order.length) % order.length; }
function nextActiveSid(fromSid) {
  const order = activeOrder();
  if (order.length <= 1) return order[0] || null;
  const idx = Math.max(0, order.findIndex(sid => sid === fromSid));
  const direction = game?.dir || 1;
  return direction === -1 ? order[(idx - 1 + order.length) % order.length] : order[(idx + 1) % order.length];
}

/* ---------- Deck / Cards ---------- */
function deckNew() {
  const d = [];
  for (const color of COLORS) {
    // numbers
    d.push({ color, type: "number", value: 0, img: `${color}_0.png` });
    for (let v = 1; v <= 9; v++) {
      d.push({ color, type: "number", value: v, img: `${color}_${v}.png` });
      d.push({ color, type: "number", value: v, img: `${color}_${v}.png` });
    }
    // actions x2
    for (let i = 0; i < 2; i++) {
      d.push({ color, type: "reverse", img: `${color}_reverse.png` });
      d.push({ color, type: "skip", img: `${color}_skip.png` });
      d.push({ color, type: "draw2", img: `${color}_draw2.png` });
    }
  }
  // specialties (1 each unless otherwise defined)
  d.push({ color: "blue", type: "blue_look", img: "blue_look.png" });
  d.push({ color: "yellow", type: "yellow_shopping", img: "yellow_shopping.png" });
  d.push({ color: "green", type: "green_happy", img: "green_happy.png" });
  d.push({ color: "green", type: "green_recycle", img: "green_recycle.png" });
  d.push({ color: "yellow", type: "yellow_pinkypromise", img: "yellow_pinkypromise.png" });
  d.push({ color: "blue", type: "blue_moon", img: "blue_moon.png" });
  d.push({ color: "red", type: "red_it", img: "red_it.png" });
  d.push({ color: "red", type: "red_noc", img: "red_noc.png" });
  // wilds
  for (let i = 0; i < 4; i++) {
    d.push({ color: "wild", type: "wild", img: "wild.png" });
    d.push({ color: "wild", type: "wild_draw4", img: "wild_draw4.png" });
  }
  d.push({ color: "wild", type: "wild_boss", img: "wild_boss.png" });
  d.push({ color: "wild", type: "wild_packyourbags", img: "wild_packyourbags.png" });
  d.push({ color: "wild", type: "wild_rainbow", img: "wild_rainbow.png" });
  d.push({ color: "wild", type: "wild_relax", img: "wild_relax.png" });
  return shuffle(d);
}
function cardImageName(card) {
  if (!card) return "back.png";
  if (card.color === "wild") return `${card.type}.png`;
  if (card.type === "number") return `${card.color}_${card.value}.png`;
  if (card.type === "draw2") return `${card.color}_draw2.png`;
  if (card.type === "skip") return `${card.color}_skip.png`;
  if (card.type === "reverse") return `${card.color}_reverse.png`;
  return `${card.type}.png`;
}

/* ---------- Game skeleton ---------- */
function emptyGame() {
  return {
    started: false,
    deck: [],
    discard: [],
    color: null,
    value: null, // number value or action keyword
    dir: 1,
    hands: {}, // sid -> cards[]
    countdownEndsAt: null,
    turnEndsAt: null,
    pendingPenalty: null, // { total, type: "draw2"|"wild_draw4", targetSid, lastFromSid }
    relaxLock: false,
    roundFlags: { happy: false },
    _happyFlagged: new Set(),
    unoArmedSid: null,
    unoSatisfied: false,
    current: null
  };
}

/* ---------- Draw helpers ---------- */
function restockDeckIfNeeded(nNeeded = 1) {
  if (!game) return;
  const need = Math.max(nNeeded, 0);
  if ((game.deck?.length || 0) <= 10 || (game.deck?.length || 0) < need) {
    if ((game.discard?.length || 0) > 1) {
      const top = game.discard.pop();
      const rest = game.discard.splice(0);
      shuffle(rest);
      // put reshuffled discards at bottom; keep draw order varied
      if (!game.deck) game.deck = [];
      game.deck = rest.concat(game.deck);
      game.discard = [top];
    }
  }
}
function drawOne(sid) {
  if (!game) return null;
  restockDeckIfNeeded(1);
  const c = game.deck.pop();
  if (!c) return null;
  (game.hands[sid] = game.hands[sid] || []).push(c);
  return c;
}
function dealTo(sid, count = 1) { for (let i = 0; i < count; i++) drawOne(sid); }

/* ---------- Announce ---------- */
let chatBuffer = []; // last 200 messages
function announce(text) {
  const msg = { id: "m_" + Math.random().toString(36).slice(2), when: Date.now(), text };
  chatBuffer.push(msg); if (chatBuffer.length > 200) chatBuffer.shift();
  io.emit("announce", text);
}
function faceString(card) {
  const color = card.color;
  const t = card.type;
  if (t === "number") return `${color} ${card.value}`;
  if (t === "draw2") return `${color} draw two`;
  if (t === "skip") return `${color} skip`;
  if (t === "reverse") return `${color} reverse`;
  if (t === "wild") return `wild`;
  if (t === "wild_draw4") return `wild draw four`;
  if (t === "wild_relax") return `wild relax`;
  if (t === "wild_boss") return `wild boss`;
  if (t === "wild_packyourbags") return `wild pack your bags`;
  if (t === "wild_rainbow") return `wild rainbow`;
  if (t === "blue_look") return `blue look`;
  if (t === "yellow_shopping") return `yellow shopping`;
  if (t === "green_happy") return `green happy`;
  if (t === "green_recycle") return `green recycle`;
  if (t === "yellow_pinkypromise") return `yellow pinky promise`;
  if (t === "blue_moon") return `blue moon`;
  if (t === "red_it") return `red it`;
  if (t === "red_noc") return `red noc`;
  return `${color} ${t}`;
}

/* ---------- State emit ---------- */
function stateSnapshot() {
  const top = game?.discard?.[game.discard.length - 1] || null;
  return {
    started: !!(game?.started),
    countdownEndsAt: game?.countdownEndsAt || null,
    turnEndsAt: game?.turnEndsAt || null,
    color: game?.color || null,
    value: game?.value || null,
    current: game?.current || null,
    direction: game?.dir || 1,
    top: top ? { color: top.color, type: top.type, value: top.value || null, img: cardImageName(top) } : null,
    penalty: game?.pendingPenalty ? { total: game.pendingPenalty.total, type: game.pendingPenalty.type, target: game.pendingPenalty.targetSid } : null,
    roundFlags: game?.roundFlags || { happy: false },
    players: players.map(p => ({ sid: p.sid, name: p.name, spectator: p.spectator, misses: p.misses || 0 }))
  };
}
function emitState() { io.emit("state", stateSnapshot()); }

/* ---------- Winner/Scoring ---------- */
function winnerIfAny() {
  if (!game) return null;
  const actives = new Set(activeOrder());
  for (const sid of actives) {
    if ((game.hands[sid] || []).length === 0) return sid;
  }
  return null;
}
function upsertScore(name, deltaWins, deltaPoints) {
  if (!scores || typeof scores !== "object") scores = {};
  if (!scores[name] || typeof scores[name] !== "object") scores[name] = { wins: 0, points: 0 };
  scores[name].wins = Number(scores[name].wins || 0) + (deltaWins || 0);
  scores[name].points = Number(scores[name].points || 0) + (deltaPoints || 0);
}
function sumHandPointsExcept(winnerSid) {
  let pot = 0;
  const hands = (game && game.hands) || {};
  for (const sid of Object.keys(hands)) {
    if (sid === String(winnerSid)) continue;
    for (const card of hands[sid] || []) {
      const key = card.color === "wild"
        ? card.type
        : (card.type === "number" ? `${card.color}_${card.value}` : `${card.color}_${card.type}`);
      pot += (CARD_POINTS[key] || 0);
    }
  }
  return pot;
}
function scoreRound(winnerSid) {
  const winner = players.find(p => p.sid === winnerSid);
  if (!winner) return;
  const winnerName = winner.name || "Player";
  const pot = sumHandPointsExcept(winnerSid);
  upsertScore(winnerName, 1, pot);
  saveScores();

  if (SCORING_MODE === "points" && (scores[winnerName]?.points || 0) >= POINTS_TARGET) {
    io.emit("announce", `🎉 MATCH WIN: ${winnerName} reached ${scores[winnerName].points} pts!`);
    // (Optional: reset match points here)
    saveScores();
  }
  io.emit("announce", `🏁 Round Winner: ${winnerName} (+${pot} pts).`);
}
function settleWinIf(anySid) {
  scoreRound(anySid);

  // prep next round countdown
  game = emptyGame();
  game.started = false;
  let endsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
  game.countdownEndsAt = endsAt;
  announce(`⏳ Next round in ${COUNTDOWN_SECONDS}s… promoting spectators if space is available.`);

  // Promote spectators up to MAX_PLAYERS
  const actives = players.filter(p => !p.spectator);
  const specs = players.filter(p => p.spectator);
  const available = Math.max(0, MAX_PLAYERS - actives.length);
  for (let i = 0; i < Math.min(available, specs.length); i++) {
    specs[i].spectator = false;
    announce(`🎟️ ${specs[i].name} moved to players for next round.`);
  }
  emitState();

  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    const enough = players.filter(p => !p.spectator).length >= 2;
    if (Date.now() >= endsAt) {
      if (enough) { clearInterval(countdownTimer); countdownTimer = null; initGame(); }
      else {
        announce("⛔ Not enough players yet. Waiting…");
        endsAt = Date.now() + 10000;
        game.countdownEndsAt = endsAt;
        emitState();
      }
    }
  }, 300);
}

/* ---------- Countdown / Init ---------- */
function startCountdown() {
  if (game?.started || countdownTimer) return;
  if (players.filter(p => !p.spectator).length < 2) return;
  const endsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
  game = emptyGame();
  game.countdownEndsAt = endsAt;
  announce(`⏳ Game starts in ${COUNTDOWN_SECONDS}s…`);
  emitState();
  countdownTimer = setInterval(() => {
    const enough = players.filter(p => !p.spectator).length >= 2;
    if (!enough) { clearInterval(countdownTimer); countdownTimer = null; announce("❌ Countdown canceled—need at least 2 players."); emitState(); return; }
    if (Date.now() >= endsAt) { clearInterval(countdownTimer); countdownTimer = null; initGame(); }
  }, 300);
}
function initGame() {
  const order = activeOrder();
  const deck = deckNew();
  const hands = {};
  for (const sid of order) hands[sid] = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
  // Flip a legal first card (number)
  let first = deck.pop();
  while (first.type !== "number") { deck.unshift(first); shuffle(deck); first = deck.pop(); }

  game = emptyGame();
  game.started = true;
  game.deck = deck;
  game.discard = [first];
  game.color = first.color;
  game.value = first.value;
  game.dir = 1;
  game.hands = hands;
  game.current = order[0];
  game.turnEndsAt = Date.now() + TURN_SECONDS * 1000;

  clearInterval(turnTicker);
  turnTicker = setInterval(onTurnTick, 250);
  announce("🎉 Game started!");
  emitState();
}
function endGameIfNeeded() {
  const order = activeOrder();
  if (order.length <= 1 && game) {
    announce("❗ Game ended: not enough players.");
    game = null;
    emitState();
  }
}

/* ---------- UNO window penalty ---------- */
function maybeApplyUnoPenalty(leavingSid) {
  if (!game) return;
  if (game.unoArmedSid === leavingSid && !game.unoSatisfied) {
    restockDeckIfNeeded(2);
    drawOne(leavingSid); drawOne(leavingSid);
    announce(`🔔 UNO penalty: ${sidToName(leavingSid)} didn’t call — drew 2.`);
  }
  game.unoArmedSid = null; game.unoSatisfied = false;
}

/* ---------- Turn advance / ticker ---------- */
function advanceTurn(skips = 1) {
  if (!game?.started) return;
  const order = activeOrder();
  if (order.length <= 1) return;
  const leavingSid = game.current;
  let idx = order.findIndex(sid => sid === game.current);
  if (idx < 0) idx = 0;
  for (let s = 0; s < skips; s++) idx = nextIdx(idx, game.dir, order);
  if (leavingSid) maybeApplyUnoPenalty(leavingSid);
  game.current = order[idx];
  game.turnEndsAt = Date.now() + TURN_SECONDS * 1000;
}
function onTurnTick() {
  if (game?.started) {
    const w = winnerIfAny();
    if (w) { settleWinIf(w); return; }
  }
  if (!game?.started || !game.current) return;
  if (Date.now() < game.turnEndsAt) return;

  const curSid = game.current;
  const p = players.find(x => x.sid === curSid);
  if (p && !p.spectator) {
    // If penalty pending and target timed out: settle penalty
    if (game.pendingPenalty && game.pendingPenalty.targetSid === curSid) {
      const total = game.pendingPenalty.total;
      restockDeckIfNeeded(total);
      for (let i = 0; i < total; i++) drawOne(curSid);
      announce(`${p.name} drew ${total} (stack ended).`);
      game.pendingPenalty = null;
      game.relaxLock = false;
      p.misses = (p.misses || 0) + 1;
      if (p.misses >= 3) { announce(`🛑 ${p.name} removed after 3 missed turns.`); cleanupLeaver(p.id); emitState(); return; }
      advanceTurn(1);
      emitState();
      return;
    }

    // Normal timeout: draw 1 and pass
    drawOne(curSid);
    announce(`🃏 ${p.name} drew 1 card.`);
    const won = winnerIfAny();
    if (won) { settleWinIf(won); return; }
    p.misses = (p.misses || 0) + 1;
    if (p.misses >= 3) { announce(`🛑 ${p.name} removed after 3 missed turns.`); cleanupLeaver(p.id); emitState(); return; }
    advanceTurn(1);
    emitState();
  }
}

/* ---------- Cleanup on leave/disconnect ---------- */
function cleanupLeaver(socketId) {
  const idx = players.findIndex(p => p.id === socketId);
  if (idx < 0) return;
  const leaver = players[idx];
  const sid = leaver.sid;
  const hand = (game && game.hands && game.hands[sid]) ? game.hands[sid] : [];
  if (hand && hand.length && game && game.deck) {
    // put their cards back to bottom of deck
    for (const c of hand) game.deck.unshift(c);
    delete game.hands[sid];
  }
  players.splice(idx, 1);
  announce(`👋 ${leaver.name} left the table.`);

  // re-target penalties if leaver was target
  if (game && game.pendingPenalty && game.pendingPenalty.targetSid === sid) {
    const total = game.pendingPenalty.total;
    const newTarget = nextActiveSid(game.pendingPenalty.lastFromSid);
    if (newTarget && newTarget !== sid) {
      game.pendingPenalty.targetSid = newTarget;
      announce(`⚠️ Penalty re-targeted → ${sidToName(newTarget)} (+${total}).`);
    } else {
      game.pendingPenalty = null; game.relaxLock = false;
    }
  }
  if (game && game.current === sid) {
    advanceTurn(1);
  }
  endGameIfNeeded();
  emitState();
}

/* ---------- Legality ---------- */
function isWild(type) { return String(type || "").startsWith("wild"); }
function cardMatchesTop(card, color, value) {
  if (isWild(card.type)) return true;
  if (card.type === "number") return (card.color === color || card.value === value);
  return (card.color === color || card.type === value);
}

/* ---------- Penalty (stacking) ---------- */
function beginPenalty(fromSid, type) {
  const add = (type === "draw2") ? 2 : 4;
  const fromName = sidToName(fromSid);

  if (!game.pendingPenalty) {
    const nextSid = nextActiveSid(fromSid);
    const nextName = sidToName(nextSid);
    game.pendingPenalty = { total: add, type: (type === "draw2" ? "draw2" : "wild_draw4"), targetSid: nextSid, lastFromSid: fromSid };
    // it's now the target's turn
    game.current = nextSid;
    game.turnEndsAt = Date.now() + TURN_SECONDS * 1000;
    announce(`⚠️ ${fromName} started a stack (+${add}). ${nextName} can stack or draw.`);
    return;
  }
  // already stacking — add and retarget
  const add2 = (type === "draw2") ? 2 : 4;
  game.pendingPenalty.total += add2;
  game.pendingPenalty.lastFromSid = fromSid;
  const newTarget = nextActiveSid(fromSid);
  game.pendingPenalty.targetSid = newTarget;
  const newName = sidToName(newTarget);
  announce(`➕ Stack continues (+${add2}, total ${game.pendingPenalty.total}). Now targeting ${newName}.`);
}

/* ---------- Socket.IO ---------- */
io.on("connection", (socket) => {
  socket.on("disconnect", () => cleanupLeaver(socket.id));

  function emitPlayers() {
    socket.emit("players", players.map(p => ({ id: p.id, sid: p.sid, name: p.name, spectator: p.spectator })));
  }

  /* Join / seating (mid-game join as player if seats < 10) */
  socket.on("join", ({ name, clientId }) => {
    let me = players.find(p => p.id === socket.id);
    if (!me) {
      const bad = /[^a-zA-Z0-9 _\-\.\!\?]/g;
      name = (String(name || "").replace(bad, "").trim()) || `Player ${(players.length + 1)}`;
      let spectator = players.filter(p => !p.spectator).length >= MAX_PLAYERS;
      if (game?.started && !spectator) spectator = false; // allow mid-game seat if room

      me = { id: socket.id, sid: socket.id, clientId: clientId || ("c_" + Math.random().toString(36).slice(2)), name, spectator, misses: 0, lastChatAt: 0 };
      players.push(me);
      announce(`👤 ${me.name} ${me.spectator ? "joined as spectator." : "joined the game."}`);

      if (game?.started && !me.spectator) {
        if (!game.hands) game.hands = {};
        if (!game.deck) game.deck = [];
        restockDeckIfNeeded(7);
        game.hands[me.sid] = [];
        for (let i = 0; i < 7; i++) drawOne(me.sid);
        emitState();
      }
    }
    socket.emit("me", { id: me.sid, name: me.name, spectator: me.spectator, clientId: me.clientId });
    emitPlayers();
    emitState();
    if (!game?.started) startCountdown();
  });

  /* Admin broadcast (optional) */
  socket.on("admin:chat", ({ msg }) => {
    io.emit("announce", `🛠️ Admin: ${String(msg || "").slice(0, 200)}`);
  });

  /* Chat */
  socket.on("chat", ({ text, id }) => {
    const me = players.find(p => p.id === socket.id);
    if (!me) return;
    const messageId = id || ("m_" + Math.random().toString(36).slice(2));
    const t = String(text || "").slice(0, 200);
    chatBuffer.push({ id: messageId, fromSid: me.sid, fromName: me.name, text: t, when: Date.now() });
    if (chatBuffer.length > 200) chatBuffer.shift();
    io.emit("chat", { id: messageId, fromSid: me.sid, fromName: me.name, text: t });
  });

  /* HAPPY moderation (flag to force draw 1) */
  socket.on("flagHappy", ({ messageId }) => {
    if (!game?.roundFlags?.happy) return;
    if (!game._happyFlagged) game._happyFlagged = new Set();
    if (game._happyFlagged.has(messageId)) return;
    const found = chatBuffer.find(m => m.id === messageId);
    if (!found) return;
    game._happyFlagged.add(messageId);
    const actor = players.find(p => p.sid === found.fromSid);
    if (!actor || actor.spectator) return;
    drawOne(found.fromSid);
    io.emit("happyFlagApplied", { messageId });
    announce(`😊 Happy: ${found.fromName} draws 1 (message flagged).`);
    emitState();
  });

  /* UNO shout */
  socket.on("callUno", () => {
    const me = players.find(p => p.id === socket.id);
    if (!me || !game?.started) return;
    if (game.unoArmedSid === me.sid && (game.hands[me.sid] || []).length === 1) {
      game.unoSatisfied = true;
      announce(`📣 ${me.name} called UNO in time!`);
    } else {
      announce(`📣 ${me.name} called UNO!`);
    }
  });

  /* Draw (normal or settle penalty) */
  socket.on("drawCard", () => {
    const me = players.find(p => p.id === socket.id);
    if (!me || !game?.started) return;

    // Settle a pending stack if you're the target and it's your turn
    if (game.pendingPenalty && game.pendingPenalty.targetSid === me.sid && game.current === me.sid) {
      const total = game.pendingPenalty.total;
      restockDeckIfNeeded(total);
      for (let i = 0; i < total; i++) drawOne(me.sid);
      announce(`${me.name} drew ${total} (stack ended).`);
      game.pendingPenalty = null; game.relaxLock = false;

      const won = winnerIfAny();
      if (won) { settleWinIf(won); return; }

      // Count a miss on forced draw settle
      me.misses = (me.misses || 0) + 1;
      if (me.misses >= 3) { announce(`🛑 ${me.name} removed after 3 missed turns.`); cleanupLeaver(me.id); emitState(); return; }

      advanceTurn(1);
      emitState();
      return;
    }

    // Normal draw if it's your turn
    if (game.current !== me.sid) return;
    drawOne(me.sid);
    announce(`🃏 ${me.name} drew 1 card.`);
    const won = winnerIfAny();
    if (won) { settleWinIf(won); return; }
    advanceTurn(1);
    emitState();
  });

  /* WILD RELAX (out-of-turn) */
  socket.on("playRelax", ({ index, color }) => {
    if (!game?.started || !game.pendingPenalty) return;
    const me = players.find(p => p.id === socket.id);
    if (!me) return;
    const hand = game.hands[me.sid] || [];
    const card = hand[index];
    if (!card || card.type !== "wild_relax") return;

    const apply = (chosenColor) => {
      hand.splice(index, 1);
      game.discard.push(card);
      game.color = chosenColor; game.value = "wild_relax";
      announce(`🎨 Color → ${String(chosenColor).toUpperCase()}.`);
      game.relaxLock = true; // prevents immediate restacking this tick
      announce(`🧘 Relax! ${me.name} canceled the stack.`);
      game.pendingPenalty = null;
      emitState();
    };

    const go = (c) => apply(COLORS.includes(c) ? c : sample(COLORS));
    if (!COLORS.includes(color)) {
      io.to(me.id).emit("chooseColor");
      socket.once("colorChosen", ({ color: c }) => go(c));
    } else go(color);
  });

  /* Wild color helper (prompt path) */
  socket.on("chooseWild", ({ color }) => {
    const me = players.find(p => p.id === socket.id);
    if (!me || !game?.started) return;
    const apply = (chosen) => { game.color = chosen; emitState(); };

    if (!COLORS.includes(color)) {
      io.to(me.id).emit("chooseColor");
      socket.once("colorChosen", ({ color: c }) => apply(c));
      return;
    }
    apply(color);
  });

  /* Play a card */
  socket.on("playCard", ({ index }) => {
    const me = players.find(p => p.id === socket.id);
    if (!me || !game?.started) return;
    const hand = game.hands[me.sid] || [];
    if (typeof index !== "number" || index < 0 || index >= hand.length) return;
    const card = hand[index];

    // If you are the penalty target, you may only stack same-type or draw
    if (game.pendingPenalty && game.pendingPenalty.targetSid === me.sid) {
      const pType = game.pendingPenalty.type; // "draw2" | "wild_draw4"
      if (card.type !== pType) return;
    }
    if (game.current !== me.sid) return;
    if (!card || !cardMatchesTop(card, game.color, game.value)) return;

    // Play it
    hand.splice(index, 1);
    game.discard.push(card);
    announce(`${sidToName(me.sid)}: played a ${faceString(card)}.`);

    // UNO window arm
    if ((game.hands[me.sid] || []).length === 1) {
      game.unoArmedSid = me.sid; game.unoSatisfied = false;
      announce(`⚠️ ${sidToName(me.sid)} has 1 card — say UNO!`);
    } else if (game.unoArmedSid === me.sid) {
      game.unoArmedSid = null; game.unoSatisfied = false;
    }

    // Winner check (actor emptied hand)
    const w = winnerIfAny();
    if (w) { settleWinIf(w); return; }

    // Wilds (prompt for color; announce chosen color)
    const resetPromptTimer = () => { game.turnEndsAt = Date.now() + TURN_SECONDS * 1000; emitState(); };

    if (isWild(card.type)) {
      if (card.type === "wild") {
        io.to(me.id).emit("chooseColor"); resetPromptTimer();
        socket.once("colorChosen", ({ color }) => {
          const chosen = COLORS.includes(color) ? color : sample(COLORS);
          game.color = chosen; game.value = "wild";
          announce(`🎨 Color → ${String(chosen).toUpperCase()}.`);
          const w2 = winnerIfAny(); if (w2) { settleWinIf(w2); return; }
          advanceTurn(1); emitState();
        });
        return;
      }

      if (card.type === "wild_draw4") {
        io.to(me.id).emit("chooseColor"); resetPromptTimer();
        socket.once("colorChosen", ({ color }) => {
          const chosen = COLORS.includes(color) ? color : sample(COLORS);
          game.color = chosen; game.value = "wild_draw4";
          announce(`🎨 Color → ${String(chosen).toUpperCase()}.`);
          beginPenalty(me.sid, "wild_draw4");
          emitState();
        });
        return;
      }

      if (card.type === "wild_boss") {
        io.to(me.id).emit("chooseColor"); resetPromptTimer();
        socket.once("colorChosen", ({ color }) => {
          const chosen = COLORS.includes(color) ? color : sample(COLORS);
          game.color = chosen; game.value = "wild_boss";
          announce(`👑 Boss: ${me.name} takes another turn.`);
          announce(`🎨 Color → ${String(chosen).toUpperCase()}.`);
          // same player goes again
          emitState();
        });
        return;
      }

      if (card.type === "wild_packyourbags") {
        io.to(me.id).emit("chooseColor"); resetPromptTimer();
        socket.once("colorChosen", ({ color }) => {
          const chosen = COLORS.includes(color) ? color : sample(COLORS);
          game.color = chosen; game.value = "wild_packyourbags";
          announce(`🧳 Pack Your Bags: everyone draws 1.`);
          announce(`🎨 Color → ${String(chosen).toUpperCase()}.`);
          const order = activeOrder();
          for (const sid of order) drawOne(sid);
          const w2 = winnerIfAny(); if (w2) { settleWinIf(w2); return; }
          advanceTurn(1); emitState();
        });
        return;
      }

      if (card.type === "wild_rainbow") {
        // Must possess at least one of each color in hand (server checks)
        const handArr = (game.hands[me.sid] || []).map((c, i) => ({ ...c, _i: i }));
        const colorsSet = new Set(handArr.map(c => c.color).filter(c => COLORS.includes(c)));
        if (colorsSet.size < 4) {
          announce(`🌈 ${me.name} attempted Rainbow but lacks all four colors — turn forfeited.`);
          advanceTurn(1); emitState(); return;
        }

        io.to(me.id).emit("rainbowPick", {
          hand: handArr.map(c => ({ i: c._i, color: c.color, type: c.type, value: c.value || null }))
        });
        resetPromptTimer();

        const t = setTimeout(resolveAuto, 20000);

        function picksAreValid(picks) {
          if (!Array.isArray(picks) || picks.length !== 4) return false;
          const chosenColors = picks.map(i => handArr[i]?.color);
          return COLORS.every(col => chosenColors.includes(col));
        }
        function resolveAuto() {
          const needed = new Set(COLORS);
          const picks = [];
          for (let i = 0; i < handArr.length; i++) {
            const c = handArr[i];
            if (needed.has(c.color)) { picks.push(i); needed.delete(c.color); }
            if (picks.length === 4) break;
          }
          applyPicks(picks);
        }
        function applyPicks(picks) {
          const unique = Array.from(new Set(picks.map(Number))).filter(n => Number.isInteger(n) && n >= 0 && n < handArr.length);
          const chosen = unique.map(i => handArr[i]).slice(0, 4);
          const set = new Set(chosen.map(c => c.color));
          if (chosen.length !== 4 || !COLORS.every(col => set.has(col))) {
            announce(`🌈 Invalid Rainbow picks — auto-resolving.`);
            resolveAuto(); return;
          }
          // For narrative, move chosen 4 to discard top (remove from hand)
          for (const c of chosen) {
            const idx2 = (game.hands[me.sid] || []).findIndex(x => x === c);
            if (idx2 >= 0) (game.hands[me.sid] || []).splice(idx2, 1);
            game.discard.push(c);
          }
          const chosenColor = sample(COLORS);   // ✅ fixed name: avoid duplicate const
          game.color = chosenColor;             // set free color after rainbow resolve
          announce(`🎨 Color → ${String(chosenColor).toUpperCase()}.`);
          announce(`🌈 Rainbow: ${me.name} balanced the hues.`);
          const w2 = winnerIfAny(); if (w2) { settleWinIf(w2); return; }
          advanceTurn(1); emitState();
        }

        socket.once("rainbowChosen", ({ picks }) => {
          clearTimeout(t);
          if (!picksAreValid(picks)) return resolveAuto();
          applyPicks(picks);
        });
        return;
      }

      if (card.type === "wild_relax") {
        // In-turn RELAX play is ignored (RELAX is for out-of-turn).
        announce(`🧘 ${me.name} tried to play Relax in-turn (ignored).`);
        emitState();
        return;
      }
    }

    // ----- Actions / numbers -----
    if (card.type === "reverse") {
      game.dir *= -1;
      announce(`🔄 Play direction reversed.`);
      if (activeOrder().length === 2) {
        announce(`⏭️ Reverse acts as Skip with 2 players.`);
        advanceTurn(1); emitState(); return;
      }
      // same player's turn continues in new direction
      emitState(); return;
    }
    if (card.type === "skip") {
      announce(`⏭️ Skipped next player.`);
      advanceTurn(2); emitState(); return;
    }
    if (card.type === "draw2") {
      beginPenalty(me.sid, "draw2"); emitState(); return;
    }

    // (Custom specialties would be handled here if you have specific effects on server)
    // Default number/action resolution:
    game.color = card.color;
    game.value = (card.type === "number") ? card.value : card.type;
    advanceTurn(1);
    emitState();
  });

  /* Simple helpers for dev/admin */
  socket.on("drawOne", ({ sid }) => { const me = players.find(p => p.id === socket.id); if (!me) return; drawOne(sid || me.sid); emitState(); });
  socket.on("giveCard", ({ sid, card }) => { const me = players.find(p => p.id === socket.id); if (!me || !card) return; (game.hands[sid || me.sid] = game.hands[sid || me.sid] || []).push(card); emitState(); });
  socket.on("setColor", ({ color }) => { if (!COLORS.includes(color)) return; if (!game) return; game.color = color; emitState(); });
  socket.on("forceRelax", () => { if (!game?.pendingPenalty) return; game.pendingPenalty = null; game.relaxLock = true; announce(`🧘 Admin forced Relax.`); emitState(); });
});

/* ---------- Start server ---------- */
server.listen(PORT, () => {
  console.log("UNO server listening on", PORT);
});
