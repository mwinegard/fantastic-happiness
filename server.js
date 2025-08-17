// UNO server with specialty cards, stacking (draw2/+4), wild_relax interrupt, rich announcements,
// HAPPY chat emoji moderation, Look/Shopping/Rainbow flows, Admin commands, and house rules.
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

/* ---------- Scores (ephemeral) ---------- */
const SCORE_PATH = "./scores.json";
let scores = {};
try {
  if (fs.existsSync(SCORE_PATH)) {
    scores = JSON.parse(fs.readFileSync(SCORE_PATH, "utf8") || "{}");
  }
} catch {}
function saveScores() {
  try {
    fs.writeFileSync(SCORE_PATH, JSON.stringify(scores, null, 2));
  } catch {}
}
app.get("/scores", (_req, res) => res.json(scores));

/* ---------- Game state ---------- */
const MAX_PLAYERS = 10;
const TURN_SECONDS = 60;
const COUNTDOWN_SECONDS = 60;

let players = []; // {id,sid,clientId,name,spectator,misses,lastChatAt}
let game = null;  // main game object
let countdownTimer = null;
let turnTicker = null;

/* ---------- Helpers ---------- */
const COLORS = ["red","yellow","green","blue"];
const ANIMALS = ["Aardvark","Badger","Cougar","Dolphin","Eagle","Fox","Gopher","Heron","Ibis","Jay","Koala","Lynx","Moose","Newt","Otter","Puma","Quail","Raven","Seal","Tiger","Urchin","Viper","Wolf","Xerus","Yak","Zebra"];
const NUM = ["One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten"];

function announce(t){ io.emit("announce", t); }
function uniqueName(base) {
  let name = String(base||"").trim();
  if (!name) name = `${NUM[Math.min(players.length,9)]} ${ANIMALS[Math.floor(Math.random()*ANIMALS.length)]}`;
  const taken = new Set(players.map(p => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let n = 2; while (taken.has(`${name} ${n}`.toLowerCase())) n++;
  return `${name} ${n}`;
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function sample(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function activeOrder(){ return players.filter(p=>!p.spectator).map(p=>p.sid); }
function nextIdx(idx, dir, order){ return (idx + dir + order.length) % order.length; }

function cardImageName(card) {
  if (card.color === "wild") return `${card.type}.png`; // wild.png or wild_draw4.png / wild_* specials
  if (card.type === "number") return `${card.color}_${card.value}.png`;
  if (card.type === "draw2") return `${card.color}_draw.png`;
  return `${card.color}_${card.type}.png`;
}

/* ---------- Deck ---------- */
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
  // Standard wilds (4 each)
  for (let i=0;i<4;i++){
    d.push({color:"wild",type:"wild",       img:`wild.png`});
    d.push({color:"wild",type:"wild_draw4", img:`wild_draw4.png`});
  }
  // Specialty (1 copy each per deck)
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

/* ---------- Game object ---------- */
function emptyGame() {
  return {
    started:false,
    deck:[],
    discard:[],
    color:null,
    value:null, // number value or action type string
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
    // Session house rules (all ON by default)
    rules: { stacking:true, relax:true, points:true },
  };
}

/* ---------- Drawing / checks ---------- */
function restockDeckIfNeeded(nNeeded=1){
  if (!game) return;
  const need = Math.max(nNeeded, 0);
  if ((game.deck?.length || 0) <= 10 || (game.deck?.length || 0) < need) {
    if ((game.discard?.length || 0) > 1) {
      const top = game.discard.pop();
      const rest = game.discard.splice(0);
      shuffle(rest);
      // place rest at the BOTTOM of the draw pile
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
    // fallback: last resort rebuild
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

/* Give one random card from fromSid to toSid */
function giveRandomCard(fromSid, toSid){
  if (!game || !fromSid || !toSid || fromSid === toSid) return null;
  const from = game.hands[fromSid] || [];
  if (from.length === 0) return null;
  const idx = Math.floor(Math.random() * from.length);
  const c = from.splice(idx, 1)[0];
  if (!c) return null;
  if (!game.hands[toSid]) game.hands[toSid] = [];
  game.hands[toSid].push(c);
  return c;
}

function winnerIfAny(){
  if (!game) return null;
  const actives = new Set(activeOrder()); // ignore spectators
  for (const sid of actives) {
    if ((game.hands[sid] || []).length === 0) return sid;
  }
  return null;
}

/* settle if actor emptied hand or any winner exists; returns boolean */
function checkAndSettleWin(actorSid){
  const w = actorSid && (game?.hands?.[actorSid]?.length === 0 ? actorSid : null) || winnerIfAny();
  if (!w) return false;
  settleWinIf(w);
  return true;
}

function settleWinIf(anySid){
  const name = players.find(p=>p.sid===anySid)?.name || "Player";
  announce(`🏆 ${name} wins the round!`);
  // Points only if rule 'points' is ON (default)
  if (!game || game.rules.points !== false) {
    scores[name] = (scores[name]||0)+1;
    saveScores();
  }

  // Prepare next game and countdown
  game = emptyGame();
  game.started = false;
  let endsAt = Date.now() + 60000;
  game.countdownEndsAt = endsAt;
  announce("⏳ Next round in 60s… promoting spectators if space is available.");

  // Promote spectators to players until we reach MAX_PLAYERS
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
        endsAt = Date.now() + 60000; // extend by 60s chunks until enough players
        game.countdownEndsAt = endsAt;
        emitState();
      }
    }
  }, 300);
}

/* ---------- Build state snapshot for clients ---------- */
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

/* ---------- Countdown -> Init ---------- */
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
  // Only truthy SIDs (defensive)
  const order = activeOrder().filter(Boolean);

  const deck = deckNew();
  const hands = {};
  // Deal 7 per active player (robust)
  for (const sid of order) hands[sid] = [];
  for (let r=0; r<7; r++) for (const sid of order) { const c = deck.pop(); if (c) hands[sid].push(c); }

  // Flip a number to start
  let first = deck.pop();
  let safety = 0;
  while (first && first.type !== "number" && safety < 50) { deck.unshift(first); shuffle(deck); first = deck.pop(); safety++; }
  if (!first) { first = { color:"red", type:"number", value:0, img:"red_0.png" }; }

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
  if (!order.length) { endGameIfNeeded(); return; }
  let idx = order.indexOf(game.current);
  if (idx<0) idx = 0;
  for (let s=0; s<skips; s++){
    idx = nextIdx(idx, game.dir, order);
  }
  game.current = order[idx];
  game.turnEndsAt = Date.now()+TURN_SECONDS*1000;
}

function onTurnTick(){
  // Between-turn winner check
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

/* ---------- Chat buffer for HAPPY ---------- */
let chatCounter = 1;
let chatBuffer = []; // last 200 messages

/* ---------- Announcer helpers ---------- */
function faceString(card){
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
  return `${color} ${t}`;
}
function sidToName(sid){ return players.find(p=>p.sid===sid)?.name || "Player"; }
function previousActiveSid(fromSid){
  const order = activeOrder();
  const idx = order.indexOf(fromSid);
  if (idx<0) return null;
  return order[(idx - game.dir + order.length) % order.length];
}
function nextActiveSid(fromSid){
  const order = activeOrder();
  const idx = order.indexOf(fromSid);
  if (idx<0) return null;
  return order[(idx + game.dir + order.length) % order.length];
}
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
function isWild(type){ return String(type||"").startsWith("wild"); }
function cardMatchesTop(card, color, value) {
  if (isWild(card.type)) return true;
  if (card.type === "number") return card.color === color || card.value === value;
  // any action type can match action type (including specialties)
  return card.color === color || card.type === value;
}

/* ---------- Admin + rules helpers ---------- */
function isActiveSid(sid){ return activeOrder().includes(sid); }

function forceSettlePenalty(){
  if (!game?.pendingPenalty) return false;
  const { total, targetSid } = game.pendingPenalty;
  restockDeckIfNeeded(total);
  for (let i=0;i<total;i++) drawOne(targetSid);
  announce(`${sidToName(targetSid)} drew ${total} (stack force-settled).`);
  game.pendingPenalty = null; game.relaxLock = false;
  advanceTurn(1);
  return true;
}

function addTurnSeconds(sec){
  if (!game?.started) return false;
  game.turnEndsAt = (game.turnEndsAt || Date.now()) + Math.max(1, sec)*1000;
  return true;
}

function addCountdownSeconds(sec){
  if (!game || !game.countdownEndsAt) return false;
  game.countdownEndsAt += Math.max(1, sec)*1000;
  return true;
}

function adminStartNow(){
  if (game?.started) { announce("Admin: cannot start — round already active."); return false; }
  const enough = players.filter(p=>!p.spectator).length >= 2;
  if (!enough) { announce("Admin: cannot start — need at least 2 players."); return false; }
  if (typeof countdownTimer !== "undefined" && countdownTimer) { clearInterval(countdownTimer); countdownTimer=null; }
  initGame();
  return true;
}

function burnTop(){
  if (!game) return false;
  if ((game.discard?.length || 0) <= 1) return false;
  const top = game.discard.pop();
  // put old top to bottom of draw pile
  game.deck.unshift(top);
  const newTop = game.discard[game.discard.length-1] || null;
  if (newTop) { game.color = newTop.color || game.color; game.value = newTop.value ?? newTop.type ?? game.value; }
  return true;
}

/* ---------- Penalty management (stacking; respects rules) ---------- */
function beginPenalty(fromSid, type){
  const add = (type==="draw2") ? 2 : 4;
  const fromName = sidToName(fromSid);

  // Stacking disabled → immediate draw for next player and skip them
  if (game?.rules && game.rules.stacking === false) {
    const targetSid = nextActiveSid(fromSid);
    if (!targetSid) return;
    const targetName = sidToName(targetSid);
    restockDeckIfNeeded(add);
    for (let i=0;i<add;i++) drawOne(targetSid);
    announce(`${targetName} drew +${add} (stacking off).`);
    const afterTarget = nextActiveSid(targetSid);
    game.current = afterTarget || targetSid;
    game.turnEndsAt = Date.now()+TURN_SECONDS*1000;
    return;
  }

  // Normal stacking flow (ON)
  if (!game.pendingPenalty) {
    const nextSid = nextActiveSid(fromSid);
    const nextName = sidToName(nextSid);
    game.pendingPenalty = { total:add, type: (type==="draw2"?"draw2":"wild_draw4"), targetSid: nextSid, lastFromSid: fromSid };
    game.current = nextSid; // target's turn
    game.turnEndsAt = Date.now()+TURN_SECONDS*1000;
    announce(`${fromName} started a +${add} stack → ${nextName}. ${nextName} can draw +${add} or stack.`);
    return;
  }

  // Adding to an existing stack
  const stackType = (type==="draw2"?"draw2":"wild_draw4");
  if (game.pendingPenalty.type !== stackType) return;

  game.pendingPenalty.total += add;
  game.pendingPenalty.lastFromSid = fromSid;

  const newTargetSid = nextActiveSid(fromSid);
  game.pendingPenalty.targetSid = newTargetSid;
  game.current = newTargetSid;
  game.turnEndsAt = Date.now()+TURN_SECONDS*1000;

  const total = game.pendingPenalty.total;
  const targetName = sidToName(newTargetSid);
  announce(`${fromName} added +${add} — ${targetName} can draw +${total} or stack.`);
}

function cancelPenaltyByRelax(actorSid, chosenColor){
  if (!game.pendingPenalty || game.relaxLock) return false;
  game.relaxLock = true;
  const lastType = game.pendingPenalty.type;
  game.pendingPenalty = null;
  game.color = chosenColor;
  game.value = lastType;
  announce(`🌴 Relax: draw penalty canceled. Color → ${chosenColor.toUpperCase()}.`);
  advanceTurn(1);
  game.relaxLock = false;
  return true;
}

/* ---------- Prompt helper with cleanup ---------- */
function requireChoice(sid, kind, data, timeoutMs, onOk, onTimeout){
  const sock = players.find(p=>p.sid===sid)?.id;
  if (!sock) { onTimeout && onTimeout(); return; }
  io.to(sock).emit("prompt", { kind, data, timeoutMs });

  let used = false;
  let timer;

  const handler = (payload={})=>{
    if (used) return;
    used = true;
    clearTimeout(timer);
    onOk && onOk(payload);
  };

  timer = setTimeout(()=>{
    if (used) return;
    used = true;
    onTimeout && onTimeout();
  }, Math.max(500, timeoutMs||10000));

  return { handler, timer, sockId: sock };
}

/* ---------- SOCKETS ---------- */
io.on("connection", (socket) => {
  socket.emit("helloAck", { ok:true, you:socket.id, at:Date.now() });
  socket.emit("state", buildState());

  // JOIN
  socket.on("join", (payload) => {
    let name = ""; let clientId = "";
    if (typeof payload === "string") { name = payload; }
    else if (payload && typeof payload === "object") { name = payload.name || ""; clientId = payload.clientId || ""; }
    name = uniqueName(name);

    let me = clientId && players.find(p => p.clientId === clientId);
    if (me) {
      me.id = socket.id;
      me.sid = me.sid || socket.id;
      me.name = name || me.name;
    } else {
      const spectator = !!(game?.started) || players.filter(p=>!p.spectator).length >= MAX_PLAYERS;
      me = { id:socket.id, sid:socket.id, clientId: clientId || (`c_${Math.random().toString(36).slice(2)}`), name, spectator, misses:0, lastChatAt:0 };
      players.push(me);
      announce(`👤 ${me.name} ${me.spectator?"joined as spectator.":"joined the game."}`);
    }
    socket.emit("me", { id: me.sid, name: me.name, spectator: me.spectator, clientId: me.clientId });

    if (!game?.started && players.filter(p=>!p.spectator).length >= 2) startCountdown();
    emitState();
  });

  // CHAT
  socket.on("chat", (msg) => {
    const me = players.find(p=>p.id===socket.id);
    if (!me) return;
    const now = Date.now();
    if (now - (me.lastChatAt || 0) < 500) return; // rate limit
    me.lastChatAt = now;
    const id = chatCounter++;
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
    const actor = players.find(p=>p.sid===found.fromSid);
    if (!actor || actor.spectator || found.fromSid==="admin") return;
    drawOne(found.fromSid);
    io.emit("happyFlagApplied", { messageId });
    announce(`😊 Happy: ${found.fromName} draws 1 (message flagged).`);
    emitState();
  });

  // UNO shout
  socket.on("callUno", ()=>{
    const me = players.find(p=>p.id===socket.id);
    if (!me || !game?.started) return;
    announce(`📣 ${me.name} called UNO!`);
  });

  // DRAW (normal or penalty settle)
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

    if (game.current !== me.sid) return;

    drawOne(me.sid);
    announce(`🃏 ${me.name} drew 1 card.`);
    if (checkAndSettleWin(me.sid)) return;
    advanceTurn(1);
    emitState();
  });

  // WILD RELAX (out-of-turn interrupt) — always get a color choice; respect rule
  socket.on("playRelax", ({ index, color })=>{
    if (!game?.started || !game.pendingPenalty) return;
    if (game?.rules && game.rules.relax === false) return; // Relax disabled
    const me = players.find(p=>p.id===socket.id);
    if (!me) return;
    const hand = game.hands[me.sid] || [];
    const card = hand[index];
    if (!card || card.type!=="wild_relax") return;

    const apply = (chosenColor)=>{
      hand.splice(index,1);
      game.discard.push(card);
      announce(`${sidToName(me.sid)}: played a wild relax.`);
      const chosen = COLORS.includes(chosenColor)?chosenColor:sample(COLORS);
      const ok = cancelPenaltyByRelax(me.sid, chosen);
      if (!ok) return;
      if (checkAndSettleWin(me.sid)) return;
      emitState();
    };

    if (!COLORS.includes(color)) {
      io.to(me.id).emit("chooseColor");
      socket.once("colorChosen", ({ color: c })=> apply(c));
      return;
    }
    apply(color);
  });

  // PLAY
  socket.on("playCard", ({ index })=>{
    const me = players.find(p=>p.id===socket.id);
    if (!me || !game?.started) return;
    const hand = game.hands[me.sid] || [];
    if (typeof index !== "number" || index<0 || index>=hand.length) return;
    const card = hand[index];

    // if you're the target of a stack, you may only stack same type or draw (or forbidden if stacking off)
    if (game.pendingPenalty && game.pendingPenalty.targetSid === me.sid) {
      const pType = game.pendingPenalty.type; // "draw2" or "wild_draw4"
      if (game.rules && game.rules.stacking === false) return; // stacking disabled -> must draw
      if (card.type !== pType) return;
    }
    if (game.current !== me.sid) return;
    if (!card || !cardMatchesTop(card, game.color, game.value)) return;

    // play the card
    hand.splice(index,1);
    game.discard.push(card);
    announce(`${sidToName(me.sid)}: played a ${faceString(card)}.`);
    if (checkAndSettleWin(me.sid)) return;

    /* -------- WILDS (always choose color) -------- */
    const resetPromptTimer = ()=>{ game.turnEndsAt = Date.now()+TURN_SECONDS*1000; emitState(); };
    if (isWild(card.type)) {
      if (card.type === "wild") {
        io.to(me.id).emit("chooseColor"); resetPromptTimer();
        socket.once("colorChosen", ({ color })=>{
          const chosen = COLORS.includes(color)?color:sample(COLORS);
          game.color = chosen; game.value = "wild";
          if (checkAndSettleWin(me.sid)) return;
          advanceTurn(1); emitState();
        });
        return;
      }
      if (card.type === "wild_draw4") {
        io.to(me.id).emit("chooseColor"); resetPromptTimer();
        socket.once("colorChosen", ({ color })=>{
          const chosen = COLORS.includes(color)?color:sample(COLORS);
          game.color = chosen; game.value = "wild_draw4";
          beginPenalty(me.sid, "wild_draw4"); // target becomes current (or settles if stacking off)
          emitState();
        });
        return;
      }
      if (card.type === "wild_boss") {
        io.to(me.id).emit("chooseColor"); resetPromptTimer();
        socket.once("colorChosen", ({ color })=>{
          const chosen = COLORS.includes(color)?color:sample(COLORS);
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
        io.to(me.id).emit("chooseColor"); resetPromptTimer();
        socket.once("colorChosen", ({ color })=>{
          const chosen = COLORS.includes(color)?color:sample(COLORS);
          game.color = chosen; game.value = "wild_packyourbags";
          rotateHands(game.dir);
          announce(`🧳 Pack Your Bags: hands rotated around the table. Color → ${chosen.toUpperCase()}.`);
          if (checkAndSettleWin(me.sid)) return;
          advanceTurn(1); emitState();
        });
        return;
      }
      if (card.type === "wild_relax") {
        io.to(me.id).emit("chooseColor"); resetPromptTimer();
        socket.once("colorChosen", ({ color })=>{
          const chosen = COLORS.includes(color)?color:sample(COLORS);
          if (game.pendingPenalty) cancelPenaltyByRelax(me.sid, chosen);
          else { game.color = chosen; game.value = "wild_relax"; advanceTurn(1); }
          if (checkAndSettleWin(me.sid)) return;
          emitState();
        });
        return;
      }
      if (card.type === "wild_rainbow") {
        const handArr = (game.hands[me.sid]||[]);
        const colorSlots = new Set(handArr.filter(c=>COLORS.includes(c.color)).map(c=>c.color));
        if (colorSlots.size < 4) {
          io.to(me.id).emit("chooseColor"); resetPromptTimer();
          socket.once("colorChosen", ({ color })=>{
            const chosen = COLORS.includes(color)?color:sample(COLORS);
            announce(`🌈 Rainbow (lite): not all colors present. Color → ${chosen.toUpperCase()}.`);
            game.color = chosen; game.value = "wild_rainbow";
            if (checkAndSettleWin(me.sid)) return;
            advanceTurn(1); emitState();
          });
          return;
        }
        const myHand = handArr.map((c,i)=>({idx:i,color:c.color,type:c.type,img:c.img}));
        io.to(me.id).emit("prompt", { kind:"rainbowSelects", data:{ hand: myHand }, timeoutMs: 20000 });
        resetPromptTimer();
        const t = setTimeout(resolveAuto, 20000);

        function picksAreValid(picks){
          if (!Array.isArray(picks) || picks.length!==4) return false;
          const colors = picks.map(i=>handArr[i]?.color);
          return COLORS.every(col => colors.includes(col));
        }
        function resolveAuto(){
          const needed = new Set(COLORS); const picks=[];
          for (let i=0;i<handArr.length;i++){
            const c = handArr[i];
            if (needed.has(c.color)) { picks.push(i); needed.delete(c.color); }
            if (picks.length===4) break;
          }
          applyPicks(picks);
        }
        socket.once("promptChoice", ({ kind, picks })=>{
          if (kind!=="rainbowSelects" || !picksAreValid(picks)) return resolveAuto();
          applyPicks(picks);
        });
        function applyPicks(picks){
          clearTimeout(t);
          const h = game.hands[me.sid] || [];
          const sorted = [...picks].sort((a,b)=>b-a);
          const removed = [];
          for (const pi of sorted){ if (pi>=0 && pi<h.length) removed.push(h.splice(pi,1)[0]); }
          for (const rc of removed) game.discard.push(rc);
          io.to(me.id).emit("chooseColor"); resetPromptTimer();
          socket.once("colorChosen", ({ color })=>{
            const chosen = COLORS.includes(color)?color:sample(COLORS);
            announce(`🌈 Rainbow: discarded one of each color. Color → ${chosen.toUpperCase()}.`);
            game.color = chosen; game.value = "wild_rainbow";
            if (checkAndSettleWin(me.sid)) return;
            advanceTurn(1); emitState();
          });
        }
        return;
      }
    }

    /* -------- NUMBERS & COLORED ACTIONS -------- */
    if (card.type === "number") {
      game.color = card.color; game.value = card.value;
      if (checkAndSettleWin(me.sid)) return;
      advanceTurn(1);
      emitState();
      return;
    }

    // Specialty colored actions
    if (card.type === "it" && card.color==="red") {
      game.color = "red"; game.value = "it";
      const prev = previousActiveSid(me.sid);
      const nxt  = nextActiveSid(me.sid);
      if (prev && nxt) {
        giveRandomCard(prev, nxt);
        announce(`🔴 IT: “We all **float** down here.” ${sidToName(prev)} floats a card to ${sidToName(nxt)}!`);
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
        announce(`🛑 NOC: Severity 1 incident — ${sidToName(target)} draw 3 cards.`);
      }
      if (checkAndSettleWin(me.sid)) return;
      advanceTurn(1); emitState(); return;
    }

    if (card.type === "moon" && card.color==="blue") {
      game.color = "blue"; game.value = "moon";
      const order = activeOrder();
      const r = Math.floor(Math.random()*order.length);
      const victim = order[r];
      if (victim) { drawOne(victim); announce(`🌙 Moon: random player (${sidToName(victim)}) draws 1.`); }
      if (checkAndSettleWin(me.sid)) return;
      advanceTurn(1); emitState(); return;
    }

    if (card.type === "look" && card.color==="blue") {
      game.color = "blue"; game.value = "look";
      const top4 = [];
      for (let i=0;i<4;i++){ restockDeckIfNeeded(1); const c=game.deck.pop(); if (c) top4.push(c); }
      const payload = top4.map((c,i)=>({ img:c.img, idx:i }));
      io.to(me.id).emit("prompt", { kind:"lookOrder", data:{ top4: payload }, timeoutMs: 15000 });
      game.turnEndsAt = Date.now()+TURN_SECONDS*1000; emitState();
      socket.once("promptChoice", ({ kind, order })=>{
        const ord = Array.isArray(order) && order.length===4 ? order : [0,1,2,3];
        const arr = [top4[ord[3]], top4[ord[2]], top4[ord[1]], top4[ord[0]]].filter(Boolean);
        game.deck.push(...arr);
        announce(`👀 Look: top 4 reordered.`);
        if (checkAndSettleWin(me.sid)) return;
        advanceTurn(1); emitState();
      });
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
      const prompt = requireChoice(me.sid, "targetPicker", { targets }, 15000,
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
      socket.once("promptChoice", payload => prompt && prompt.handler && prompt.handler(payload||{}));
      game.turnEndsAt = Date.now()+TURN_SECONDS*1000; emitState();
      return;
    }

    if (card.type === "shopping" && card.color === "yellow") {
      game.color = "yellow"; game.value = "shopping";
      const targetSid = nextActiveSid(me.sid);
      if (!targetSid || !(game.hands[targetSid] || []).length) {
        announce(`🛍️ Shopping: no valid target — skipped.`);
        if (checkAndSettleWin(me.sid)) return;
        advanceTurn(1); emitState(); return;
      }
      const myHand = (game.hands[me.sid] || []).map((c,i)=>({ idx:i, img:c.img }));
      const theirHand = (game.hands[targetSid] || []).map((c,i)=>({ idx:i, img:c.img }));
      const prompt = requireChoice(me.sid, "shoppingTrade", { mine: myHand, theirs: theirHand }, 20000,
        ({ myTwo, theirOne })=>{
          if (!Array.isArray(myTwo) || myTwo.length !== 2 || typeof theirOne !== "number") {
            announce(`🛍️ Shopping: no valid picks — canceled.`);
            if (checkAndSettleWin(me.sid)) return;
            advanceTurn(1); emitState(); return;
          }
          const mine = game.hands[me.sid] || [];
          const theirs = game.hands[targetSid] || [];
          const [a,b] = myTwo.map(Number).sort((x,y)=>y-x);
          if (a<0 || a>=mine.length || b<0 || b>=mine.length || a===b) {
            announce(`🛍️ Shopping: invalid indices — canceled.`);
            if (checkAndSettleWin(me.sid)) return;
            advanceTurn(1); emitState(); return;
          }
          if (theirOne < 0 || theirOne >= (theirs.length||0)) {
            announce(`🛍️ Shopping: invalid target index — canceled.`);
            if (checkAndSettleWin(me.sid)) return;
            advanceTurn(1); emitState(); return;
          }
          const give1 = mine.splice(a,1)[0];
          const give2 = mine.splice(b,1)[0];
          const take1 = theirs.splice(theirOne,1)[0];
          if (give1) theirs.push(give1);
          if (give2) theirs.push(give2);
          if (take1) mine.push(take1);
          announce(`🛍️ Shopping: ${sidToName(me.sid)} traded 2 for 1 with ${sidToName(targetSid)}.`);
          if (checkAndSettleWin(me.sid)) return;
          advanceTurn(1); emitState();
        },
        ()=>{ announce(`🛍️ Shopping: no selection — timed out.`); advanceTurn(1); emitState(); }
      );
      socket.once("promptChoice", payload => prompt && prompt.handler && prompt.handler(payload||{}));
      game.turnEndsAt = Date.now()+TURN_SECONDS*1000; emitState();
      return;
    }

    // Standard base actions
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
      beginPenalty(me.sid, "draw2"); // target becomes current (or settles if stacking off)
      emitState(); return;
    }

    // default fallback
    advanceTurn(1); emitState();
  });

  // Admin utilities (no auth gating per your request)
  socket.on("admin:refresh", ()=> socket.emit("state", buildState()));

  socket.on("admin:newRound", ()=>{
    if (countdownTimer) { announce("Admin requested new round, but countdown already active."); return; }
    if (!game?.started && players.filter(p=>!p.spectator).length >= 2) {
      announce("Admin started a new round countdown.");
      startCountdown();
    } else {
      announce("Admin requested new round but round is active or insufficient players.");
    }
  });

  socket.on("admin:endRound", ()=>{
    if (!game?.started) { announce("Admin tried to end round, but no active round."); return; }
    announce("⛔ Round ended by Admin.");
    game = null; emitState();
  });

  // Admin chat (broadcast as Admin)
  socket.on("admin:chat", ({ msg })=>{
    const text = String(msg||"").trim();
    if (!text) return;
    const payload = { id: 0, fromSid: "admin", fromName: "Admin", msg: text, at: Date.now() };
    io.emit("chat", payload);
  });

  /* ---------- Admin Hub commands (simple, no auth) ---------- */
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
          // If they were target of a stack, cancel it safely
          if (game?.pendingPenalty && game.pendingPenalty.targetSid === players[i].sid) {
            announce(`Penalty against ${players[i].name} canceled due to kick.`);
            game.pendingPenalty = null; game.relaxLock = false;
          }
          const wasCurrent = game?.current === players[i].sid;
          players.splice(i,1);
          if (wasCurrent && game?.started) advanceTurn(1);
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
        else announce("Admin setColor: invalid color.");
        break;
      }

      case "forceRelax": {
        if (game?.pendingPenalty) {
          announce(`Admin forced RELAX: penalty canceled.`);
          game.pendingPenalty = null; game.relaxLock=false;
          advanceTurn(1); emitState();
        } else {
          announce(`Admin forceRelax: no penalty to cancel.`);
        }
        break;
      }

      /* === New admin QoL actions === */
      case "extendCountdown": {
        const sec = Number(data.seconds) || 30;
        if (addCountdownSeconds(sec)) { announce(`Admin: extended start countdown by ${sec}s.`); emitState(); }
        else announce("Admin: no active countdown to extend.");
        break;
      }

      case "startNow": {
        const ok = adminStartNow(); if (ok) emitState();
        break;
      }

      case "skipTurn": {
        if (!game?.started) { announce("Admin: no active round to skip turn."); break; }
        announce("Admin: skipped current player's turn.");
        advanceTurn(1); emitState();
        break;
      }

      case "extendTurn": {
        if (!game?.started) { announce("Admin: no active round to extend turn."); break; }
        const sec = Number(data.seconds) || 10;
        addTurnSeconds(sec);
        announce(`Admin: added +${sec}s to the current turn.`);
        emitState();
        break;
      }

      case "setCurrent": {
        const sid = data.sid;
        if (!game?.started || !sid || !isActiveSid(sid)) { announce("Admin: invalid player for setCurrent."); break; }
        game.current = sid;
        game.turnEndsAt = Date.now()+TURN_SECONDS*1000;
        announce(`Admin: set current turn to ${sidToName(sid)}.`);
        emitState();
        break;
      }

      case "forceSettleStack": {
        if (!game?.pendingPenalty) { announce("Admin: no stack to settle."); break; }
        const ok = forceSettlePenalty(); if (ok) emitState();
        break;
      }

      case "burnTop": {
        const ok = burnTop();
        announce(ok ? "Admin: burned top discard and flipped next." : "Admin: cannot burn — need more cards in discard.");
        emitState();
        break;
      }

      case "forceDrawN": {
        const n = Math.max(1, Number(data.n) || 1);
        const sid = data.sid;
        if (!sid || !isActiveSid(sid)) { announce("Admin: invalid player for forceDrawN."); break; }
        restockDeckIfNeeded(n);
        for (let i=0;i<n;i++) drawOne(sid);
        announce(`Admin: forced draw ${n} to ${sidToName(sid)}.`);
        emitState();
        break;
      }

      case "setRule": {
        const key = String(data.key||"").toLowerCase(); // 'stacking' | 'relax' | 'points'
        const val = !!data.value;
        if (!game) { announce("Admin: no session to set rule on."); break; }
        if (!["stacking","relax","points"].includes(key)) { announce("Admin: unknown rule key."); break; }
        game.rules[key] = val;
        announce(`Admin: rule '${key}' → ${val ? "ON" : "OFF"}.`);
        emitState();
        break;
      }

      default:
        announce(`Admin: unknown command '${data.type}'.`);
    }
  });

});

server.listen(PORT, () => console.log("🚀 listening on", PORT));
