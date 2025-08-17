// UNO server with specialty cards, stacking (draw2/+4), wild_relax interrupt, Rainbow/Look/Shopping,
// rich announcements, HAPPY moderation, Admin Hub commands, and clientId-based scores + leaderboard.
const express = require("express");
const http = require("http");
const fs = require("fs");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const POINTS_ENABLED = (process.env.POINTS_ENABLED || "true").toLowerCase() === "true"; // set false to disable point scoring
const COUNTDOWN_SECONDS = 60;
const TURN_SECONDS = 60;
const MAX_PLAYERS = 10;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

/* ------------------- Scores / Leaderboard (clientId-scoped) ------------------- */
const SCORE_PATH = "./scores.json";
/*
  scores = {
    profiles: {
      "<clientId>": { name: "Player Name", wins: 0, points: 0 }
    }
  }
*/
let scores = { profiles: {} };
try {
  if (fs.existsSync(SCORE_PATH)) {
    const raw = fs.readFileSync(SCORE_PATH, "utf8") || "{}";
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") scores = { profiles: { ...(parsed.profiles || {}) } };
  }
} catch {}

function saveScores() {
  try { fs.writeFileSync(SCORE_PATH, JSON.stringify(scores, null, 2)); } catch {}
}

function getProfileForClientId(clientId, fallbackName = "Player") {
  if (!clientId) return null;
  const p = scores.profiles[clientId] || { name: fallbackName, wins: 0, points: 0 };
  // keep display name fresh
  p.name = fallbackName || p.name || "Player";
  scores.profiles[clientId] = p;
  return p;
}

app.get("/scores", (_req, res) => res.json(scores));

app.get("/leaderboard", (_req, res) => {
  const arr = Object.entries(scores.profiles || {}).map(([id, prof]) => ({
    id,
    name: prof?.name || "Player",
    wins: Number(prof?.wins || 0),
    points: Number(prof?.points || 0),
  }));
  arr.sort((a,b) => (b.wins - a.wins) || (b.points - a.points) || a.name.localeCompare(b.name));
  res.json(arr);
});

// Optional: reset scores (no auth; only enable if you want it)
app.post("/scores/reset", express.json(), (_req, res) => {
  scores = { profiles: {} };
  saveScores();
  res.json({ ok: true });
});

/* ------------------- Game State ------------------- */
let players = []; // {id,sid,clientId,name,spectator,misses,lastChatAt}
let game = null;  // game object
let countdownTimer = null;
let turnTicker = null;

/* ------------------- Helpers ------------------- */
const COLORS = ["red","yellow","green","blue"];
function announce(t){ io.emit("announce", t); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function sample(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function activeOrder(){ return players.filter(p=>!p.spectator).map(p=>p.sid); }
function nextIdx(idx, dir, order){ return (idx + dir + order.length) % order.length; }
function sidToName(sid){ return players.find(p=>p.sid===sid)?.name || "Player"; }
function nextActiveSid(fromSid){ const order = activeOrder(); const idx = order.indexOf(fromSid); if (idx<0) return null; return order[(idx + game.dir + order.length) % order.length]; }
function previousActiveSid(fromSid){ const order = activeOrder(); const idx = order.indexOf(fromSid); if (idx<0) return null; return order[(idx - game.dir + order.length) % order.length]; }

const ANIMALS = ["Aardvark","Badger","Cougar","Dolphin","Eagle","Fox","Gopher","Heron","Ibis","Jay","Koala","Lynx","Moose","Newt","Otter","Puma","Quail","Raven","Seal","Tiger","Urchin","Viper","Wolf","Xerus","Yak","Zebra"];
const NUM = ["One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten"];
function uniqueName(base) {
  let name = String(base||"").trim();
  if (!name) name = `${NUM[Math.min(players.length,9)]} ${ANIMALS[Math.floor(Math.random()*ANIMALS.length)]}`;
  const taken = new Set(players.map(p => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let n = 2; while (taken.has(`${name} ${n}`.toLowerCase())) n++;
  return `${name} ${n}`;
}

function cardImageName(card) {
  if (card.color === "wild") return `${card.type}.png`;
  if (card.type === "number") return `${card.color}_${card.value}.png`;
  if (card.type === "draw2") return `${card.color}_draw.png`;
  return `${card.color}_${card.type}.png`;
}

/* ------------------- Deck ------------------- */
function deckNew(){
  const d=[];
  for (const c of COLORS) {
    d.push({color:c,type:"number",value:0, img:`${c}_0.png`});
    for (let v=1; v<=9; v++){
      d.push({color:c,type:"number",value:v, img:`${c}_${v}.png`});
      d.push({color:c,type:"number",value:v, img:`${c}_${v}.png`});
    }
    for (let i=0;i<2;i++){
      d.push({color:c,type:"skip",    img:`${c}_skip.png`});
      d.push({color:c,type:"reverse", img:`${c}_reverse.png`});
      d.push({color:c,type:"draw2",   img:`${c}_draw.png`});
    }
  }
  // Standard wilds
  for (let i=0;i<4;i++){
    d.push({color:"wild",type:"wild",       img:`wild.png`});
    d.push({color:"wild",type:"wild_draw4", img:`wild_draw4.png`});
  }
  // Specialty (1 each)
  d.push({color:"red",   type:"it",                img:"red_it.png"});
  d.push({color:"red",   type:"noc",               img:"red_noc.png"});
  d.push({color:"blue",  type:"moon",              img:"blue_moon.png"});
  d.push({color:"blue",  type:"look",              img:"blue_look.png"});
  d.push({color:"green", type:"happy",             img:"green_happy.png"});
  d.push({color:"green", type:"recycle",           img:"green_recycle.png"});
  d.push({color:"yellow",type:"pinky",             img:"yellow_pinkypromise.png"});
  d.push({color:"yellow",type:"shopping",          img:"yellow_shopping.png"});
  d.push({color:"wild",  type:"wild_boss",         img:"wild_boss.png"});
  d.push({color:"wild",  type:"wild_packyourbags", img:"wild_packyourbags.png"});
  d.push({color:"wild",  type:"wild_rainbow",      img:"wild_rainbow.png"});
  d.push({color:"wild",  type:"wild_relax",        img:"wild_relax.png"});
  return shuffle(d);
}

/* ------------------- Game object ------------------- */
function emptyGame() {
  return {
    started:false,
    deck:[],
    discard:[],
    color:null,
    value:null,
    dir:1,
    turnIdx:0,
    current:null,
    hands:{}, // sid -> cards[]
    countdownEndsAt:null,
    turnEndsAt:null,
    pendingPenalty:null, // { total, type: "draw2"|"wild_draw4", targetSid, lastFromSid }
    relaxLock:false,
    roundFlags:{ happy:false },
    _happyFlagged: new Set(),
  };
}

/* ------------------- Drawing / checks ------------------- */
function restockDeckIfNeeded(nNeeded=1){
  if (!game) return;
  const need = Math.max(nNeeded, 0);
  if ((game.deck?.length || 0) <= 10 || (game.deck?.length || 0) < need) {
    if ((game.discard?.length || 0) > 1) {
      const top = game.discard.pop();
      const rest = game.discard.splice(0);
      shuffle(rest);
      // add to bottom of draw pile
      if (!game.deck) game.deck = [];
      game.deck = rest.concat(game.deck);
      game.discard = [top];
    }
  }
}

function drawOne(sid){
  if (!game) return null;
  restockDeckIfNeeded(1);
  if (game.deck.length === 0) {
    if (game.discard.length > 1) {
      const top = game.discard.pop();
      game.deck = shuffle(game.discard);
      game.discard = [top];
    }
  }
  const card = game.deck.pop();
  if (!card) return null;
  if (!card.img) card.img = cardImageName(card);
  if (!game.hands[sid]) game.hands[sid] = [];
  game.hands[sid].push(card);
  return card;
}

function giveRandomCard(fromSid, toSid){
  if (!fromSid || !toSid) return null;
  const fh = game.hands[fromSid] || [];
  if (!fh.length) return null;
  const i = Math.floor(Math.random()*fh.length);
  const card = fh.splice(i,1)[0];
  if (!game.hands[toSid]) game.hands[toSid] = [];
  game.hands[toSid].push(card);
  return card;
}

function winnerIfAny(){
  if (!game) return null;
  const actives = new Set(activeOrder());
  for (const sid of actives) {
    if ((game.hands[sid] || []).length === 0) return sid;
  }
  return null;
}

function checkAndSettleWin(sid){
  if (!game) return false;
  if ((game.hands[sid]||[]).length === 0) { settleWinIf(sid); return true; }
  return false;
}

/* ------------------- Points ------------------- */
function cardPointValue(card) {
  if (!card) return 0;
  if (card.type === "number") return Number(card.value || 0);
  if (card.type === "skip" || card.type === "reverse" || card.type === "draw2") return 20;
  if (String(card.type||"").startsWith("wild")) return 50;
  // specialties (house rule)
  return 30;
}
function handPoints(cards){ return (cards||[]).reduce((s,c)=>s+cardPointValue(c),0); }

/* ------------------- Announce helpers ------------------- */
function faceString(card){
  if (!card) return "card";
  const c = card.color, t = card.type, v = card.value;
  if (t === "number") return `${c} ${v}`;
  if (t === "draw2") return `${c} draw two`;
  if (t === "skip") return `${c} skip`;
  if (t === "reverse") return `${c} reverse`;
  if (t === "wild") return `wild`;
  if (t === "wild_draw4") return `wild draw four`;
  if (t === "wild_relax") return `wild relax`;
  if (t === "wild_boss") return `wild boss`;
  if (t === "wild_rainbow") return `wild rainbow`;
  if (t === "wild_packyourbags") return `wild pack your bags`;
  // specialties colored
  return `${c} ${t}`;
}

/* ------------------- State snapshot ------------------- */
function buildState(){
  return {
    started: !!game?.started,
    countdownEndsAt: game?.countdownEndsAt || null,
    turnEndsAt: game?.turnEndsAt || null,
    current: game?.current || null,
    direction: game?.dir || 1,
    color: game?.color || null,
    top: game?.discard?.[game.discard.length-1] || null,
    penalty: game?.pendingPenalty ? { total: game.pendingPenalty.total, type: game.pendingPenalty.type, target: game.pendingPenalty.targetSid } : null,
    roundFlags: game?.roundFlags || { happy:false },
    players: players.map(p=>({ id:p.sid, name:p.name, spectator:!!p.spectator, handCount: game?.hands?.[p.sid]?.length ?? 0 })),
  };
}
function emitState(){
  io.emit("state", buildState());
  if (game?.hands) {
    for (const p of players) {
      if (p.sid && game.hands[p.sid]) io.to(p.id).emit("handSnapshot", game.hands[p.sid]);
    }
  }
}

/* ------------------- Countdown & Init ------------------- */
function startCountdown(){
  if (game?.started || countdownTimer) return;
  if (players.filter(p=>!p.spectator).length < 2) return;
  const endsAt = Date.now() + COUNTDOWN_SECONDS*1000;
  game = emptyGame();
  game.countdownEndsAt = endsAt;
  announce(`⏳ Game starts in ${COUNTDOWN_SECONDS}s…`);
  emitState();
  countdownTimer = setInterval(()=>{
    const enough = players.filter(p=>!p.spectator).length >= 2;
    if (!enough) { clearInterval(countdownTimer); countdownTimer=null; announce("❌ Countdown canceled—need at least 2 players."); emitState(); return; }
    if (Date.now() >= endsAt) { clearInterval(countdownTimer); countdownTimer=null; initGame(); }
  }, 300);
}

function initGame(){
  const order = activeOrder();
  if (order.length < 2) return;
  const deck = deckNew();
  const hands = {};
  for (const sid of order) hands[sid] = [deck.pop(),deck.pop(),deck.pop(),deck.pop(),deck.pop(),deck.pop(),deck.pop()];
  let first = deck.pop();
  // ensure a number on table
  while (first.type !== "number") { deck.unshift(first); shuffle(deck); first = deck.pop(); }
  game = emptyGame();
  game.started = true;
  game.deck = deck;
  game.discard = [first];
  game.color = first.color;
  game.value = first.value;
  game.dir = 1;
  game.hands = hands;
  game.turnIdx = 0;
  game.current = order[0] || null;
  game.turnEndsAt = Date.now()+TURN_SECONDS*1000;
  clearInterval(turnTicker);
  turnTicker = setInterval(onTurnTick, 250);
  announce("🎉 Game started!");
  emitState();
}

function endGameIfNeeded(){
  const order = activeOrder();
  if (order.length <= 1 && game) {
    announce("❗ Game ended: not enough players.");
    game = null;
    emitState();
  }
}

function advanceTurn(skips=1){
  const order = activeOrder();
  if (!order.length || !game) { endGameIfNeeded(); return; }
  let idx = order.indexOf(game.current);
  if (idx<0) idx = 0;
  for (let s=0; s<skips; s++){
    idx = nextIdx(idx, game.dir, order);
  }
  game.current = order[idx];
  game.turnEndsAt = Date.now()+TURN_SECONDS*1000;
}

function onTurnTick(){
  if (game?.started) {
    const w = winnerIfAny();
    if (w) { settleWinIf(w); return; }
  }
  if (!game?.started || !game.current) return;
  if (Date.now() < game.turnEndsAt) return;

  const curSid = game.current;
  const p = players.find(x=>x.sid===curSid);
  if (p && !p.spectator) {
    // If penalty pending and target timed out: settle penalty
    if (game.pendingPenalty && game.pendingPenalty.targetSid === curSid) {
      const total = game.pendingPenalty.total;
      restockDeckIfNeeded(total);
      for (let i=0;i<total;i++) drawOne(curSid);
      announce(`${p.name} drew ${total} (stack ended).`);
      game.pendingPenalty = null;
      game.relaxLock = false;
      advanceTurn(1);
      emitState();
      return;
    }
    // Normal timeout: draw 1 and pass
    drawOne(p.sid);
    announce(`⏰ ${p.name} ran out of time and drew 1.`);
  }
  advanceTurn(1);
  emitState();
}

/* ------------------- Win & round rollover ------------------- */
function settleWinIf(winnerSid){
  const name = players.find(p=>p.sid===winnerSid)?.name || "Player";
  announce(`🏆 ${name} wins the round!`);

  // Points (house rule, if enabled)
  try {
    const winner = players.find(p=>p.sid===winnerSid);
    const winnerClientId = winner?.clientId;
    const prof = winnerClientId ? getProfileForClientId(winnerClientId, winner?.name) : null;

    if (prof) {
      prof.wins = (prof.wins||0) + 1;

      if (POINTS_ENABLED) {
        // sum of all opponents' hands
        let pts = 0;
        const actives = new Set(activeOrder());
        for (const sid of actives) {
          if (sid === winnerSid) continue;
          pts += handPoints(game.hands[sid] || []);
        }
        prof.points = (prof.points||0) + pts;
      }
      saveScores();
    }
  } catch { /* ignore scoring errors */ }

  // Prepare next game and countdown
  game = emptyGame();
  game.started = false;
  let endsAt = Date.now() + COUNTDOWN_SECONDS*1000;
  game.countdownEndsAt = endsAt;
  announce(`⏳ Next round in ${COUNTDOWN_SECONDS}s… promoting spectators if space is available.`);

  // Promote spectators up to MAX_PLAYERS
  const actives = players.filter(p=>!p.spectator);
  const specs = players.filter(p=>p.spectator);
  const available = Math.max(0, MAX_PLAYERS - actives.length);
  for (let i=0;i<Math.min(available, specs.length); i++){
    specs[i].spectator = false;
    announce(`🎟️ ${specs[i].name} moved to players for next round.`);
  }
  emitState();

  clearInterval(countdownTimer);
  countdownTimer = setInterval(()=>{
    const enough = players.filter(p=>!p.spectator).length >= 2;
    if (Date.now() >= endsAt) {
      if (enough) { clearInterval(countdownTimer); countdownTimer=null; initGame(); }
      else {
        announce("⏳ Waiting for at least 2 players to start the next round…");
        endsAt = Date.now() + COUNTDOWN_SECONDS*1000;
        game.countdownEndsAt = endsAt;
        emitState();
      }
    }
  }, 300);
}

/* ------------------- Penalties (stacking) ------------------- */
function beginPenalty(fromSid, type){
  const nextSid = nextActiveSid(fromSid);
  const add = (type==="draw2") ? 2 : 4;
  const fromName = sidToName(fromSid);
  const nextName = sidToName(nextSid);
  if (!game.pendingPenalty) {
    game.pendingPenalty = { total:add, type: (type==="draw2"?"draw2":"wild_draw4"), targetSid: nextSid, lastFromSid: fromSid };
    announce(`${fromName} started a +${add} stack → ${nextName}. ${nextName} can draw +${add} or stack.`);
  } else {
    if (game.pendingPenalty.type === (type==="draw2"?"draw2":"wild_draw4")) {
      game.pendingPenalty.total += add;
      game.pendingPenalty.lastFromSid = fromSid;
      const total = game.pendingPenalty.total;
      const targetName = sidToName(game.pendingPenalty.targetSid);
      announce(`${fromName} added +${add} — ${targetName} can draw +${total} or stack.`);
    }
  }
}

function cancelPenaltyByRelax(actorSid, chosenColor){
  if (!game.pendingPenalty || game.relaxLock) return false;
  game.relaxLock = true;
  const lastType = game.pendingPenalty.type; // retain last type as table value
  game.pendingPenalty = null;
  game.color = chosenColor;
  game.value = lastType;
  announce(`🌴 Relax: draw penalty canceled. Color → ${chosenColor.toUpperCase()}.`);
  advanceTurn(1);
  game.relaxLock = false;
  return true;
}

/* ------------------- Legality ------------------- */
function isWild(type){ return String(type||"").startsWith("wild"); }
function cardMatchesTop(card, color, value) {
  if (isWild(card.type)) return true;
  if (card.type === "number") return card.color === color || card.value === value;
  return card.color === color || card.type === value;
}

/* ------------------- Prompt helper (scoped to a player socket) ------------------- */
function requireChoice(sid, kind, data, timeoutMs, onOk, onTimeout){
  const sockId = players.find(p=>p.sid===sid)?.id;
  if (!sockId) { if (onTimeout) onTimeout(); return; }
  const sock = io.sockets.sockets.get(sockId);
  if (!sock) { if (onTimeout) onTimeout(); return; }

  let done = false;
  const timer = setTimeout(()=>{ if (done) return; done = true; try { sock.removeListener("promptChoice", onChoice); } catch{}; onTimeout && onTimeout(); }, timeoutMs || 15000);

  function onChoice(payload){
    if (done) return;
    if (!payload || payload.kind !== kind) return; // ignore other prompts
    done = true;
    clearTimeout(timer);
    sock.removeListener("promptChoice", onChoice);
    onOk && onOk(payload);
  }

  sock.once("promptChoice", onChoice);
  sock.emit("prompt", { kind, data, timeoutMs });
}

/* ------------------- Sockets ------------------- */
io.on("connection", (socket) => {
  socket.emit("helloAck", { ok:true, you:socket.id, at:Date.now() });
  socket.emit("state", buildState());

  // JOIN with ACK and direct state push
  socket.on("join", (payload, ack) => {
    try {
      let name = ""; let clientId = "";
      if (typeof payload === "string") { name = payload; }
      else if (payload && typeof payload === "object") { name = payload.name || ""; clientId = payload.clientId || ""; }

      let me = clientId && players.find(p => p.clientId === clientId);
      if (me) {
        me.id = socket.id;
        me.sid = me.sid || socket.id;
        if (name && name.trim()) me.name = uniqueName(name);
      } else {
        name = uniqueName(name);
        const spectator = !!(game?.started) || players.filter(p=>!p.spectator).length >= MAX_PLAYERS;
        me = { id:socket.id, sid:socket.id, clientId: clientId || (`c_${Math.random().toString(36).slice(2)}`), name, spectator, misses:0, lastChatAt:0 };
        players.push(me);
        announce(`👤 ${me.name} ${me.spectator?"joined as spectator.":"joined the game."}`);
      }

      // ensure profile exists and keep the display name in sync
      try { getProfileForClientId(me.clientId, me.name); saveScores(); } catch {}

      // ack & self state
      socket.emit("me", { id: me.sid, name: me.name, spectator: me.spectator, clientId: me.clientId });
      socket.emit("state", buildState());

      // kick off countdown if possible
      if (!game?.started && players.filter(p=>!p.spectator).length >= 2) startCountdown();

      emitState(); // update everyone

      if (typeof ack === "function") ack({ ok: true, me: { id: me.sid, name: me.name, spectator: me.spectator, clientId: me.clientId } });
    } catch (e) {
      if (typeof ack === "function") ack({ ok:false, error:String(e?.message||e) });
    }
  });

  // CHAT
  socket.on("chat", (msg) => {
    const me = players.find(p=>p.id===socket.id);
    if (!me) return;
    const now = Date.now();
    if (now - (me.lastChatAt || 0) < 500) return; // rate limit
    me.lastChatAt = now;
    const id = (chatCounter = (chatCounter||0) + 1);
    const payload = { id, fromSid: me.sid, fromName: me.name, msg: String(msg||""), at: now };
    chatBuffer.push(payload);
    if (chatBuffer.length > 200) chatBuffer.shift();
    io.emit("chat", payload);
  });

  // HAPPY flag
  socket.on("happyFlag", ({ messageId })=>{
    if (!game?.roundFlags?.happy) return;
    if (!messageId) return;
    if (!game._happyFlagged) game._happyFlagged = new Set();
    if (game._happyFlagged.has(messageId)) return;
    const found = chatBuffer.find(m=>m.id===messageId);
    if (!found) return;
    game._happyFlagged.add(messageId);
    // Exclude admin/system and spectators
    const actor = players.find(p=>p.sid===found.fromSid);
    if (!actor || actor.spectator || found.fromSid==="admin") return;
    drawOne(found.fromSid);
    io.emit("happyFlagApplied", { messageId });
    announce(`😊 Happy: ${found.fromName} draws 1 (message flagged).`);
    emitState();
  });

  // UNO call
  socket.on("callUno", ()=>{
    const me = players.find(p=>p.id===socket.id);
    if (!me || !game?.started) return;
    announce(`📣 ${me.name} called UNO!`);
  });

  // DRAW (normal or settle stack)
  socket.on("drawCard", ()=>{
    const me = players.find(p=>p.id===socket.id);
    if (!me || !game?.started) return;

    if (game.pendingPenalty && game.pendingPenalty.targetSid === me.sid && game.current === me.sid) {
      const total = game.pendingPenalty.total;
      restockDeckIfNeeded(total);
      for (let i=0;i<total;i++) drawOne(me.sid);
      announce(`${me.name} drew ${total} (stack ended).`);
      game.pendingPenalty = null; game.relaxLock = false;
      if (checkAndSettleWin(me.sid)) return;
      advanceTurn(1);
      emitState();
      return;
    }

    if (game.current !== me.sid) return; // your turn only
    drawOne(me.sid);
    announce(`🃏 ${me.name} drew 1 card.`);
    if (checkAndSettleWin(me.sid)) return;
    advanceTurn(1);
    emitState();
  });

  // RELAX (out-of-turn)
  socket.on("playRelax", ({ index })=>{
    if (!game?.started || !game.pendingPenalty) return;
    const me = players.find(p=>p.id===socket.id);
    if (!me) return;
    const hand = game.hands[me.sid] || [];
    const card = hand[index];
    if (!card || card.type!=="wild_relax") return;
    // place RELAX
    hand.splice(index,1);
    game.discard.push(card);
    announce(`${sidToName(me.sid)}: played a ${faceString(card)}.`);
    // choose color via prompt to the actor
    io.to(me.id).emit("chooseColor");
    socket.once("colorChosen", ({ color })=>{
      const chosen = COLORS.includes(color)?color:sample(COLORS);
      cancelPenaltyByRelax(me.sid, chosen);
      if (checkAndSettleWin(me.sid)) return;
      emitState();
    });
  });

  // PLAY a card
  socket.on("playCard", ({ index })=>{
    const me = players.find(p=>p.id===socket.id);
    if (!me || !game?.started) return;
    const hand = game.hands[me.sid] || [];
    if (typeof index !== "number" || index<0 || index>=hand.length) return;
    const card = hand[index];

    // Pending penalty: target may ONLY stack same penalty type or draw (no other plays)
    if (game.pendingPenalty && game.pendingPenalty.targetSid === me.sid) {
      const pType = game.pendingPenalty.type; // "draw2" or "wild_draw4"
      if (card.type !== pType) return;
    }

    if (game.current !== me.sid) return; // not your turn (RELAX handled separately)
    if (!card || !cardMatchesTop(card, game.color, game.value)) return;

    // remove from hand & place on discard
    hand.splice(index,1);
    game.discard.push(card);

    // Wilds ALWAYS trigger color picker in addition to their effect
    if (isWild(card.type)) {
      // announce play before effect resolves
      announce(`${sidToName(me.sid)}: played a ${faceString(card)}.`);

      const chooseAndProceed = (nextStep) => {
        io.to(me.id).emit("chooseColor");
        socket.once("colorChosen", ({ color })=>{
          const chosen = COLORS.includes(color)?color:sample(COLORS);
          nextStep(chosen);
        });
      };

      if (card.type === "wild") {
        chooseAndProceed((chosen)=>{
          game.color = chosen; game.value = "wild";
          if (checkAndSettleWin(me.sid)) return;
          advanceTurn(1); emitState();
        });
        return;
      }

      if (card.type === "wild_draw4") {
        chooseAndProceed((chosen)=>{
          game.color = chosen; game.value = "wild_draw4";
          beginPenalty(me.sid, "wild_draw4");
          emitState();
        });
        return;
      }

      if (card.type === "wild_boss") {
        chooseAndProceed((chosen)=>{
          game.color = chosen; game.value = "wild_boss";
          const actives = activeOrder();
          const bossSid = me.sid;
          for (const sid of actives) if (sid!==bossSid) giveRandomCard(sid, bossSid);
          announce(`👑 Boss: everyone gifts 1 to ${sidToName(bossSid)}.`);
          if (checkAndSettleWin(me.sid)) return;
          advanceTurn(1); emitState();
        });
        return;
      }

      if (card.type === "wild_packyourbags") {
        chooseAndProceed((chosen)=>{
          game.color = chosen; game.value = "wild_packyourbags";
          rotateHands(game.dir);
          announce(`🧳 Pack Your Bags: hands rotated around the table. Color → ${chosen.toUpperCase()}.`);
          if (checkAndSettleWin(me.sid)) return;
          advanceTurn(1); emitState();
        });
        return;
      }

      if (card.type === "wild_relax") {
        chooseAndProceed((chosen)=>{
          if (game.pendingPenalty) cancelPenaltyByRelax(me.sid, chosen);
          else { game.color = chosen; game.value = "wild_relax"; advanceTurn(1); }
          if (checkAndSettleWin(me.sid)) return;
          emitState();
        });
        return;
      }

      if (card.type === "wild_rainbow") {
        // Player must discard one of each color from their hand (R/Y/G/B)
        const colorsInHand = new Set((game.hands[me.sid]||[]).filter(c=>COLORS.includes(c.color)).map(c=>c.color));
        if (colorsInHand.size < 4) { // not enough variety; still choose a color and pass
          chooseAndProceed((chosen)=>{ game.color=chosen; game.value="wild_rainbow"; advanceTurn(1); emitState(); });
          return;
        }
        const myHandView = (game.hands[me.sid]||[]).map((c,i)=>({idx:i,color:c.color,type:c.type,img:c.img}));
        requireChoice(me.sid, "rainbowSelects", { hand: myHandView }, 20000,
          ({ picks })=>{
            // picks are indexes in the original hand
            const h = game.hands[me.sid] || [];
            const selected = Array.isArray(picks) ? [...picks] : [];
            const sorted = selected.sort((a,b)=>b-a);
            const removed = [];
            for (const pi of sorted){ if (pi>=0 && pi<h.length) removed.push(h.splice(pi,1)[0]); }
            for (const rc of removed) game.discard.push(rc);
            chooseAndProceed((chosen)=>{
              announce(`🌈 Rainbow: discarded one of each color. Color → ${chosen.toUpperCase()}.`);
              game.color = chosen; game.value = "wild_rainbow";
              if (checkAndSettleWin(me.sid)) return;
              advanceTurn(1); emitState();
            });
          },
          ()=>{ // timeout → auto resolve minimally
            chooseAndProceed((chosen)=>{ game.color=chosen; game.value="wild_rainbow"; advanceTurn(1); emitState(); });
          }
        );
        return;
      }

      // unknown wild variant: just pick color and pass
      chooseAndProceed((chosen)=>{ game.color = chosen; game.value = card.type; advanceTurn(1); emitState(); });
      return;
    }

    // Non-wild (number / colored actions)
    announce(`${sidToName(me.sid)}: played a ${faceString(card)}.`);

    if (card.type === "number") {
      game.color = card.color; game.value = card.value;
      if (checkAndSettleWin(me.sid)) return;
      advanceTurn(1); emitState(); return;
    }

    // House specialties
    if (card.type === "it" && card.color==="red") {
      game.color = "red"; game.value = "it";
      const prev = previousActiveSid(me.sid);
      const nxt  = nextActiveSid(me.sid);
      if (prev && nxt) {
        giveRandomCard(prev, nxt);
        announce(`🔴 IT: ${sidToName(prev)} floats a card to ${sidToName(nxt)}!`);
        if ((game.hands[prev]||[]).length===0) { settleWinIf(prev); return; }
      }
      if (checkAndSettleWin(me.sid)) return;
      advanceTurn(1); emitState(); return;
    }

    if (card.type === "noc" && card.color==="red") {
      game.color = "red"; game.value = "noc";
      const actives = activeOrder().filter(sid=>sid!==me.sid);
      if (actives.length){
        const target = sample(actives);
        for (let i=0;i<3;i++) drawOne(target);
        announce(`🛑 NOC: Severity incident — ${sidToName(target)} draws 3 cards.`);
      }
      if (checkAndSettleWin(me.sid)) return;
      advanceTurn(1); emitState(); return;
    }

    if (card.type === "moon" && card.color==="blue") {
      game.color = "blue"; game.value = "moon";
      const order = activeOrder();
      const victim = order[Math.floor(Math.random()*order.length)];
      if (victim) { drawOne(victim); announce(`🌙 Moon: random player (${sidToName(victim)}) draws 1.`); }
      if (checkAndSettleWin(me.sid)) return;
      advanceTurn(1); emitState(); return;
    }

    if (card.type === "look" && card.color==="blue") {
      game.color = "blue"; game.value = "look";
      const top4 = [];
      for (let i=0;i<4;i++){ restockDeckIfNeeded(1); const c=game.deck.pop(); if (c) top4.push(c); }
      const payload = top4.map((c,i)=>({ img:c.img, idx:i }));
      requireChoice(me.sid, "lookOrder", { top4: payload }, 15000,
        ({ order })=>{
          const ord = Array.isArray(order) && order.length===4 ? order : [0,1,2,3];
          const arr = [top4[ord[3]], top4[ord[2]], top4[ord[1]], top4[ord[0]]].filter(Boolean);
          game.deck.push(...arr);
          announce(`👀 Look: top 4 reordered.`);
          if (checkAndSettleWin(me.sid)) return;
          advanceTurn(1); emitState();
        },
        ()=>{ advanceTurn(1); emitState(); }
      );
      return;
    }

    if (card.type === "happy" && card.color==="green") {
      game.color = "green"; game.value = "happy";
      game.roundFlags.happy = true;
      announce(`🙂 HAPPY mode: flag a chat to make the author draw 1 (admin/spectators excluded).`);
      if (checkAndSettleWin(me.sid)) return;
      advanceTurn(1); emitState(); return;
    }

    if (card.type === "recycle" && card.color==="green") {
      game.color = "green"; game.value = "recycle";
      const actives = activeOrder();
      let pool=[]; for (const sid of actives){ pool = pool.concat(game.hands[sid]||[]); game.hands[sid]=[]; }
      const totalCollected = pool.length;
      shuffle(pool);
      const per = Math.floor(totalCollected / actives.length);
      const leftover = totalCollected % actives.length;
      for (const sid of actives){ game.hands[sid] = pool.splice(0,per); }
      const rest = pool.splice(0);
      for (const c of rest) game.deck.unshift(c);
      announce(`♻️ Recycle: ${totalCollected} collected → ${per} each, ${leftover} recycled to draw pile.`);
      if (checkAndSettleWin(me.sid)) return;
      advanceTurn(1); emitState(); return;
    }

    if (card.type === "pinky" && card.color==="yellow") {
      game.color = "yellow"; game.value = "pinky";
      const targets = activeOrder().filter(sid=>sid!==me.sid).map(sid=>({ sid, name: sidToName(sid) }));
      requireChoice(me.sid, "targetPicker", { targets }, 15000,
        ({ targetSid })=>{
          if (!targetSid || !game.hands[targetSid]) { advanceTurn(1); emitState(); return; }
          let pool = (game.hands[me.sid]||[]).concat(game.hands[targetSid]||[]);
          shuffle(pool);
          const aCount = Math.floor(pool.length/2);
          const bCount = pool.length - aCount;
          game.hands[me.sid] = pool.splice(0,aCount);
          game.hands[targetSid] = pool.splice(0,bCount);
          announce(`🤝 Pinky Promise: ${sidToName(me.sid)} split cards with ${sidToName(targetSid)}.`);
          if (checkAndSettleWin(me.sid)) return;
          advanceTurn(1); emitState();
        },
        ()=>{ advanceTurn(1); emitState(); }
      );
      return;
    }

    if (card.type === "shopping" && card.color==="yellow") {
      game.color = "yellow"; game.value = "shopping";
      // Pick a target with at least 1 card
      const candidates = activeOrder().filter(sid=>sid!==me.sid && (game.hands[sid]||[]).length>0);
      if (!candidates.length || (game.hands[me.sid]||[]).length < 2) { advanceTurn(1); emitState(); return; }
      const targetSid = sample(candidates);
      const mine = (game.hands[me.sid]||[]).map((c,i)=>({ idx:i, img:c.img }));
      const theirs = (game.hands[targetSid]||[]).map((c,i)=>({ idx:i, img:c.img }));
      requireChoice(me.sid, "shoppingTrade", { mine, theirs }, 20000,
        ({ myTwo, theirOne })=>{
          const mySet = Array.isArray(myTwo) ? new Set(myTwo) : new Set();
          const theirIdx = (typeof theirOne === "number") ? theirOne : null;
          const myHand = game.hands[me.sid] || [];
          const tHand  = game.hands[targetSid] || [];
          if (mySet.size !== 2 || theirIdx==null || theirIdx<0 || theirIdx>=tHand.length) { advanceTurn(1); emitState(); return; }

          // remove two from me (by descending index)
          const myIndexes = Array.from(mySet).sort((a,b)=>b-a);
          const myCards = [];
          for (const i of myIndexes) if (i>=0 && i<myHand.length) myCards.push(myHand.splice(i,1)[0]);

          // remove one from target
          const takeCard = tHand.splice(theirIdx,1)[0];

          // trade
          if (takeCard) myHand.push(takeCard);
          for (const c of myCards) tHand.push(c);

          announce(`🛍️ Shopping: ${sidToName(me.sid)} traded 2 for 1 with ${sidToName(targetSid)}.`);
          if (checkAndSettleWin(me.sid)) return;
          advanceTurn(1); emitState();
        },
        ()=>{ advanceTurn(1); emitState(); }
      );
      return;
    }

    // Standard actions
    if (card.type === "skip") {
      game.color = card.color; game.value = "skip";
      announce(`⛔ Skip next`);
      if (checkAndSettleWin(me.sid)) return;
      advanceTurn(2); emitState(); return;
    }
    if (card.type === "reverse") {
      game.color = card.color; game.value = "reverse";
      game.dir *= -1;
      announce(`🔁 Reverse direction`);
      if (checkAndSettleWin(me.sid)) return;
      if (activeOrder().length === 2) advanceTurn(2); else advanceTurn(1);
      emitState(); return;
    }
    if (card.type === "draw2") {
      game.color = card.color; game.value = "draw2";
      beginPenalty(me.sid, "draw2");
      emitState(); return;
    }

    // default
    advanceTurn(1); emitState();
  });

  // Admin utilities
  socket.on("admin:refresh", ()=> socket.emit("state", buildState()));

  socket.on("admin:newRound", ()=>{
    if (countdownTimer) return;
    if (!game?.started && players.filter(p=>!p.spectator).length >= 2) startCountdown();
    else { announce("⏳ Cannot start: round active or insufficient players."); }
  });

  socket.on("admin:endRound", ()=>{
    if (!game?.started) return;
    announce("⛔ Round ended by admin.");
    game = null; emitState();
  });

  // Admin chat
  socket.on("admin:chat", ({ msg })=>{
    const text = String(msg||"").trim();
    if (!text) return;
    const payload = { id: 0, fromSid: "admin", fromName: "Admin", msg: text, at: Date.now() };
    io.emit("chat", payload);
  });

  // Admin Hub commands
  socket.on("admin:cmd", (data={})=>{
    switch (data.type) {
      case "toggleHappy":
        game.roundFlags.happy = !game.roundFlags.happy;
        announce(`Admin toggled HAPPY: ${game.roundFlags.happy?"ON":"OFF"}.`);
        emitState();
        break;
      case "rotateHands":
        rotateHands(data.dir===-1?-1:1);
        announce(`Admin rotated hands ${data.dir===-1?"◀︎ left":"▶︎ right"}.`);
        emitState();
        break;
      case "kick": {
        const sid = data.sid;
        const i = players.findIndex(p=>p.sid===sid);
        if (i>=0) {
          announce(`Admin kicked ${players[i].name}.`);
          if (game?.hands) delete game.hands[players[i].sid];
          players.splice(i,1);
          endGameIfNeeded();
          emitState();
        }
        break;
      }
      case "drawOne": {
        const sid = data.sid; if (!sid) break;
        drawOne(sid); announce(`Admin: forced draw 1 to ${sidToName(sid)}.`);
        emitState();
        break;
      }
      case "giveCard": {
        const sid = data.sid; const card = data.card;
        if (sid && card) { if (!game.hands[sid]) game.hands[sid]=[]; game.hands[sid].push(card); announce(`Admin gave a card to ${sidToName(sid)}.`); emitState(); }
        break;
      }
      case "setColor": {
        const c = data.color;
        if (COLORS.includes(c)) { game.color = c; announce(`Admin set table color → ${c.toUpperCase()}.`); emitState(); }
        break;
      }
      case "forceRelax": {
        if (game.pendingPenalty) {
          announce(`Admin forced RELAX: penalty canceled.`);
          game.pendingPenalty = null; game.relaxLock=false;
          advanceTurn(1); emitState();
        }
        break;
      }
      default:
        announce(`Admin: unknown command '${data.type}'.`);
    }
  });
});

/* ------------------- Rotate hands helper ------------------- */
function rotateHands(direction){
  const order = activeOrder();
  if (order.length <= 1) return;
  let hands = order.map(sid=> game.hands[sid] || []);
  if (direction === -1) { // left
    hands.push(hands.shift());
  } else { // right
    hands.unshift(hands.pop());
  }
  order.forEach((sid,i)=> game.hands[sid] = hands[i]);
}

/* ------------------- Chat buffer for HAPPY ------------------- */
let chatCounter = 1;
let chatBuffer = []; // last 200 messages

/* ------------------- Start server ------------------- */
server.listen(PORT, () => console.log("🚀 listening on", PORT));
