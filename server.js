// UNO server with specialty cards, stacking, wild_relax interrupt, and rich announcements
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
try { if (fs.existsSync(SCORE_PATH)) scores = JSON.parse(fs.readFileSync(SCORE_PATH, "utf8") || "{}"); } catch {}
function saveScores(){ try { fs.writeFileSync(SCORE_PATH, JSON.stringify(scores, null, 2)); } catch {} }
app.get("/scores", (_req, res) => res.json(scores));

/* ---------- Game state ---------- */
const MAX_PLAYERS = 10;
const TURN_SECONDS = 60;
const COUNTDOWN_SECONDS = 20;
const MISSES_TO_KICK = 3;

let players = []; // {id,sid,clientId,name,spectator,misses,lastChatAt}
let game = null;  // main game object
let countdownTimer = null;
let turnTicker = null;

/* ---------- Helpers ---------- */
const COLORS = ["red","yellow","green","blue"];
const ANIMALS = ["Aardvark","Badger","Cougar","Dolphin","Eagle","Fox","Giraffe","Hedgehog","Iguana","Jaguar","Koala","Lemur","Manatee","Narwhal","Otter","Panda","Quokka","Raccoon","Sloth","Turtle","Urchin","Vulture","Walrus","Yak","Zebra"];
const NUM = ["One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten"];

function announce(t){ io.emit("announce", t); }
let chatCounter = 1;
function postChat(fromSid, msg) {
  const p = players.find(x=>x.sid===fromSid);
  const payload = { id: chatCounter++, fromSid, fromName: p?.name || "Player", msg: String(msg||""), at: Date.now() };
  io.emit("chat", payload);
  return payload.id;
}
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
function activePlayers(){ return players.filter(p=>!p.spectator && p.id); }
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
  d.push({color:"red",   type:"it",           img:"red_it.png"});
  d.push({color:"red",   type:"noc",          img:"red_noc.png"});
  d.push({color:"blue",  type:"moon",         img:"blue_moon.png"});
  d.push({color:"blue",  type:"look",         img:"blue_look.png"});
  d.push({color:"green", type:"happy",        img:"green_happy.png"});
  d.push({color:"green", type:"recycle",      img:"green_recycle.png"});
  d.push({color:"yellow",type:"pinky",        img:"yellow_pinky_promise.png"});
  d.push({color:"yellow",type:"shopping",     img:"yellow_shopping.png"});
  d.push({color:"wild",  type:"wild_boss",    img:"wild_boss.png"});
  d.push({color:"wild",  type:"wild_packyourbags", img:"wild_packyourbags.png"});
  d.push({color:"wild",  type:"wild_rainbow", img:"wild_rainbow.png"});
  d.push({color:"wild",  type:"wild_relax",   img:"wild_relax.png"});
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
  };
}

function drawOne(sid){
  if (!game) return null;
  if (game.deck.length === 0) {
    const top = game.discard.pop();
    game.deck = shuffle(game.discard);
    game.discard = [top];
  }
  const card = game.deck.pop();
  if (!card.img) card.img = cardImageName(card);
  if (!game.hands[sid]) game.hands[sid] = [];
  game.hands[sid].push(card);
  return card;
}

function winnerIfAny(){
  if (!game) return null;
  for (const pid of Object.keys(game.hands || {})) if ((game.hands[pid]||[]).length === 0) return pid;
  return null;
}

function emitState(){
  const state = {
    started: !!game?.started,
    countdownEndsAt: game?.countdownEndsAt || null,
    turnEndsAt: game?.turnEndsAt || null,
    current: game?.current || null,
    direction: game?.dir || 1,
    color: game?.color || null,
    top: game?.discard?.[game.discard.length-1] || null,
    penalty: game?.pendingPenalty ? { total: game.pendingPenalty.total, type: game.pendingPenalty.type, target: game.pendingPenalty.targetSid } : null,
    roundFlags: game?.roundFlags || { happy:false },
    players: players.map(p=>({ id:p.sid, name:p.name, spectator:!!p.spectator, handCount: game?.hands?.[p.sid]?.length ?? 0 }))
  };
  io.emit("state", state);
  // Push each player's hand privately
  if (game?.hands) {
    for (const p of players) {
      const hand = game.hands[p.sid] || [];
      io.to(p.id).emit("handSnapshot", hand);
    }
  }
}

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
    if (!enough) { clearInterval(countdownTimer); countdownTimer=null; game=null; announce("❌ Countdown canceled—need at least 2 players."); emitState(); return; }
    if (Date.now() >= endsAt) { clearInterval(countdownTimer); countdownTimer=null; initGame(); }
  }, 300);
}

function initGame(){
  const order = activeOrder();
  const deck = deckNew();
  const hands = {};
  for (const sid of order) hands[sid] = [deck.pop(),deck.pop(),deck.pop(),deck.pop(),deck.pop(),deck.pop(),deck.pop()];
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
  game.turnIdx = 0;
  game.current = order[0] || null;
  game.turnEndsAt = Date.now()+TURN_SECONDS*1000;
  for (const p of players) p.misses = 0;
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
  if (order.length === 0) { endGameIfNeeded(); return; }
  let idx = game.turnIdx;
  for (let i=0;i<skips;i++) idx = nextIdx(idx, game.dir, order);
  game.turnIdx = idx;
  game.current = order[idx];
  game.turnEndsAt = Date.now() + TURN_SECONDS*1000;
}

function onTurnTick(){
  if (!game?.started || !game.current) return;
  if (Date.now() < game.turnEndsAt) return;
  const order = activeOrder();
  const curSid = game.current;
  const p = players.find(x=>x.sid===curSid);
  if (p && !p.spectator) {
    p.misses = (p.misses||0)+1;
    // If penalty pending and target timed out: settle penalty
    if (game.pendingPenalty && game.pendingPenalty.targetSid === curSid) {
      const total = game.pendingPenalty.total;
      for (let i=0;i<total;i++) drawOne(curSid);
      postChat(curSid, `drew ${total} (stack ended).`);
      game.pendingPenalty = null;
      game.relaxLock = false;
      // Advance past penalized player according to last draw type
      // We treat both draw2 and draw4 as skipping the penalized player's turn (advance +1)
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

/* ---------- Legality ---------- */
function isWild(type){ return type==="wild" || type==="wild_draw4" || type.startsWith("wild_"); }
function cardMatchesTop(card, color, value) {
  if (isWild(card.type)) return true;
  if (card.type === "number") return card.color === color || card.value === value;
  // any action type can match action type (maintainable & fun)
  return card.color === color || card.type === value;
}

/* ---------- Specialty helpers ---------- */
function sidToName(sid){ return players.find(p=>p.sid===sid)?.name || "Player"; }
function currentOrder(){ return activeOrder(); }
function previousActiveSid(fromSid){
  const order = currentOrder();
  const idx = order.indexOf(fromSid);
  if (idx<0) return null;
  return order[(idx - game.dir + order.length) % order.length];
}
function nextActiveSid(fromSid){
  const order = currentOrder();
  const idx = order.indexOf(fromSid);
  if (idx<0) return null;
  return order[(idx + game.dir + order.length) % order.length];
}
function rotateHands(direction){
  const order = currentOrder();
  if (order.length<=1) return;
  const hands = order.map(sid=>game.hands[sid]||[]);
  if (direction===-1) {
    const first = hands.shift();
    hands.push(first);
  } else {
    const last = hands.pop();
    hands.unshift(last);
  }
  order.forEach((sid,i)=>{ game.hands[sid] = hands[i]; });
}
function giveRandomCard(fromSid, toSid){
  const h = game.hands[fromSid]||[];
  if (!h.length) return null;
  const idx = Math.floor(Math.random()*h.length);
  const [card] = h.splice(idx,1);
  if (!game.hands[toSid]) game.hands[toSid]=[];
  game.hands[toSid].push(card);
  return card;
}

/* ---------- Prompts (private socket flows) ---------- */
function requireChoice(targetSid, kind, data, timeoutMs, onResolve, onTimeout){
  const sock = players.find(p=>p.sid===targetSid);
  if (!sock?.id) { onTimeout && onTimeout(); return; }
  io.to(sock.id).emit("prompt", { kind, data, timeoutMs });
  const t = setTimeout(()=>{ onTimeout && onTimeout(); }, timeoutMs||15000);
  const handler = (payload) => {
    clearTimeout(t);
    io.to(sock.id).removeListener("promptChoice", handler);
    onResolve && onResolve(payload||{});
  };
  io.to(sock.id).on("promptChoice", handler);
}

/* ---------- Core play announcer ---------- */
function faceString(card){
  if (card.type==="number") return `${card.color} ${card.value}`;
  return card.type.startsWith("wild") ? card.type : `${card.color} ${card.type}`;
}
function turnPlayedLine(actorSid, card){
  const name = sidToName(actorSid);
  const face = faceString(card);
  announce(`${name}: played a ${face}.`);
}

/* ---------- Effects ---------- */
function settleWinIf(anySid){
  const name = sidToName(anySid);
  announce(`🏆 ${name} wins the round!`);
  scores[name] = (scores[name]||0)+1; saveScores();
  game = null; emitState();
}

function beginPenalty(fromSid, type){
  const order = currentOrder();
  const nextSid = nextActiveSid(fromSid);
  const add = (type==="draw2") ? 2 : 4;
  if (!game.pendingPenalty) {
    game.pendingPenalty = { total:add, type: (type==="draw2"?"draw2":"wild_draw4"), targetSid: nextSid, lastFromSid: fromSid };
    postChat(fromSid, `Penalty in play: +${game.pendingPenalty.total}. Play a Draw card to stack, or wait.`);
  } else {
    // stacking continues only if same type
    if (game.pendingPenalty.type === (type==="draw2"?"draw2":"wild_draw4")) {
      game.pendingPenalty.total += add;
      game.pendingPenalty.lastFromSid = fromSid;
      postChat(fromSid, `stacked +${add} → total +${game.pendingPenalty.total}.`);
    } else {
      // shouldn't happen by legality; ignore
    }
  }
  // advance turn to target (they must stack or draw on their turn)
  advanceTurn(1);
}

function cancelPenaltyByRelax(casterSid, chosenColor){
  if (!game.pendingPenalty || game.relaxLock) return false;
  game.relaxLock = true;
  const lastType = game.pendingPenalty.type; // draw2 or wild_draw4
  // End chain: no one draws. Advance as if last draw resolved (skip the penalized player's opportunity)
  const targetSid = game.pendingPenalty.targetSid;
  // For simplicity: we advance +1 past target (i.e., target loses their turn same as if penalty resolved)
  // Set color per Relax
  game.color = chosenColor;
  game.value = lastType; // keep action type on top for matching-by-type
  announce(`🌴 Relax: draw penalty canceled. Color → ${chosenColor.toUpperCase()}.`);
  game.pendingPenalty = null;
  advanceTurn(1);
  game.relaxLock = false;
  return true;
}

/* ---------- SOCKETS ---------- */
io.on("connection", (socket) => {
  socket.emit("helloAck", { ok:true, you:socket.id, at:Date.now() });

  // JOIN (supports reconnect via clientId)
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
    postChat(me.sid, msg);
  });

  // HAPPY flagging (🙂 → 😼)
  socket.on("happyFlag", ({ messageId })=>{
    if (!game?.roundFlags?.happy) return;
    const me = players.find(p=>p.id===socket.id);
    if (!me) return;
    io.emit("happyFlagApplied", { messageId }); // UI flip; server does the draw 1 for author via a separate event request from client? Better: we need the author id.
    // For simplicity, the client sends messageId and the server also expects the client to have included author in the chat payload earlier.
    // We'll store last N chats on server to resolve authors.
  });

  // To resolve HAPPY correctly store a small chat buffer:
}).on("connection", (socket) => {});

let chatBuffer = []; // store last 200 messages
io.on("connection", (socket)=>{
  socket.on("chat", (msg)=>{
    const me = players.find(p=>p.id===socket.id);
    if (!me) return;
    const now = Date.now();
    if (now - (me.lastChatAt || 0) < 500) return;
    me.lastChatAt = now;
    const id = chatCounter++;
    const payload = { id, fromSid: me.sid, fromName: me.name, msg: String(msg||""), at: now };
    chatBuffer.push(payload);
    if (chatBuffer.length > 200) chatBuffer.shift();
    io.emit("chat", payload);
  });
  socket.on("happyFlag", ({ messageId })=>{
    if (!game?.roundFlags?.happy) return;
    const found = chatBuffer.find(m=>m.id===messageId);
    if (!found) return;
    // Only once per message; store a flagged set on server
    game._happyFlagged = game._happyFlagged || new Set();
    if (game._happyFlagged.has(messageId)) return;
    game._happyFlagged.add(messageId);
    // Author draws 1
    drawOne(found.fromSid);
    io.emit("happyFlagApplied", { messageId });
    announce(`😊 Happy: ${found.fromName} draws 1 (message flagged).`);
    emitState();
  });
});

io.on("connection", (socket) => {

  // DRAW (normal)
  socket.on("drawCard", ()=>{
    const me = players.find(p=>p.id===socket.id);
    if (!me || !game?.started) return;

    // If penalty is pending and it's your turn as target, drawing settles
    if (game.pendingPenalty && game.pendingPenalty.targetSid === me.sid && game.current === me.sid) {
      const total = game.pendingPenalty.total;
      for (let i=0;i<total;i++) drawOne(me.sid);
      postChat(me.sid, `drew ${total} (stack ended).`);
      game.pendingPenalty = null; game.relaxLock = false;
      advanceTurn(1);
      emitState();
      return;
    }

    if (game.current !== me.sid) return; // normal draw only on your turn

    drawOne(me.sid);
    announce(`🃏 ${me.name} drew 1 card.`);
    advanceTurn(1);
    emitState();
  });

  // WILD RELAX (out-of-turn interrupt)
  socket.on("playRelax", ({ index, color })=>{
    if (!game?.started || !game.pendingPenalty) return;
    const me = players.find(p=>p.id===socket.id);
    if (!me) return;
    const hand = game.hands[me.sid] || [];
    const card = hand[index];
    if (!card || card.type!=="wild_relax") return;
    // Remove card
    hand.splice(index,1);
    game.discard.push(card);
    turnPlayedLine(me.sid, card);
    const chosen = (COLORS.includes(color)?color:sample(COLORS));
    const ok = cancelPenaltyByRelax(me.sid, chosen);
    if (!ok) return; // already canceled
    const w = winnerIfAny(); if (w) return settleWinIf(w);
    emitState();
  });

  // PLAY
  socket.on("playCard", ({ index })=>{
    const me = players.find(p=>p.id===socket.id);
    if (!me || !game?.started) return;
    const hand = game.hands[me.sid] || [];
    if (typeof index !== "number" || index<0 || index>=hand.length) return;
    const card = hand[index];

    // Out-of-turn only allowed for wild_relax during penalty
    if (game.current !== me.sid) {
      if (card?.type==="wild_relax" && game.pendingPenalty) {
        // redirect to relax flow (safety)
        socket.emit("needRelaxColor");
        socket.once("colorChosen", ({ color })=>{
          // hand index may have shifted; re-find first relax
          const h = game.hands[me.sid]||[];
          const idx = h.findIndex(c=>c.type==="wild_relax");
          if (idx>=0) io.emit("debug", {});
          if (idx<0) return;
          h.splice(idx,1);
          game.discard.push({color:"wild",type:"wild_relax",img:"wild_relax.png"});
          turnPlayedLine(me.sid, {color:"wild",type:"wild_relax"});
          cancelPenaltyByRelax(me.sid, COLORS.includes(color)?color:sample(COLORS));
          const w = winnerIfAny(); if (w) return settleWinIf(w);
          emitState();
        });
      }
      return;
    }

    // Normal turn beyond here
    if (!card || !cardMatchesTop(card, game.color, game.value)) return;

    // remove from hand & place
    hand.splice(index,1);
    game.discard.push(card);
    const actor = me.sid;

    // Turn announcement
    turnPlayedLine(actor, card);

    // ---- Specialty / Standard handling ----
    if (isWild(card.type)) {
      // Some wilds defer color choose until after sub-effect; rainbow defers color until after 4 discards.
      if (card.type === "wild") {
        io.to(socket.id).emit("chooseColor");
        socket.once("colorChosen", ({ color })=>{
          const chosen = COLORS.includes(color)?color:sample(COLORS);
          game.color = chosen; game.value = "wild";
          advanceTurn(1); emitState();
        });
        return;
      }
      if (card.type === "wild_draw4") {
        io.to(socket.id).emit("chooseColor");
        socket.once("colorChosen", ({ color })=>{
          const chosen = COLORS.includes(color)?color:sample(COLORS);
          game.color = chosen; game.value = "wild_draw4";
          beginPenalty(actor, "wild_draw4");
          emitState();
        });
        return;
      }
      if (card.type === "wild_boss") {
        io.to(socket.id).emit("chooseColor");
        socket.once("colorChosen", ({ color })=>{
          const chosen = COLORS.includes(color)?color:sample(COLORS);
          // Boss is fewest cards; tie → random, announce promotion
          const actives = activeOrder();
          let few = Infinity; let cands=[];
          for (const sid of actives){ const n=(game.hands[sid]||[]).length; if (n<few){few=n;cands=[sid];} else if (n===few){cands.push(sid);} }
          let bossSid = cands.length===1 ? cands[0] : sample(cands);
          if (cands.length>1) announce(`👑 Boss: tie broken — ${sidToName(bossSid)} promoted to the Boss! Color → ${chosen.toUpperCase()}.`);
          else announce(`👑 Boss: Color → ${chosen.toUpperCase()}.`);
          game.color = chosen; game.value = "wild_boss";
          // Everyone else gifts 1 random card to boss
          for (const sid of actives) if (sid!==bossSid) giveRandomCard(sid, bossSid);
          announce(`👑 Boss: everyone gifts 1 to ${sidToName(bossSid)}.`);
          const w = winnerIfAny(); if (w) return settleWinIf(w);
          advanceTurn(1); emitState();
        });
        return;
      }
      if (card.type === "wild_packyourbags") {
        io.to(socket.id).emit("chooseColor");
        socket.once("colorChosen", ({ color })=>{
          const chosen = COLORS.includes(color)?color:sample(COLORS);
          game.color = chosen; game.value = "wild_packyourbags";
          rotateHands(game.dir);
          announce(`🧳 Pack Your Bags: hands rotated around the table. Color → ${chosen.toUpperCase()}.`);
          const w = winnerIfAny(); if (w) return settleWinIf(w);
          advanceTurn(1); emitState();
        });
        return;
      }
      if (card.type === "wild_relax") {
        // Playing Relax on your turn just sets color; also cancels if penalty pending.
        io.to(socket.id).emit("chooseColor");
        socket.once("colorChosen", ({ color })=>{
          const chosen = COLORS.includes(color)?color:sample(COLORS);
          if (game.pendingPenalty) cancelPenaltyByRelax(actor, chosen);
          else { game.color = chosen; game.value = "wild_relax"; advanceTurn(1); }
          const w = winnerIfAny(); if (w) return settleWinIf(w);
          emitState();
        });
        return;
      }
      if (card.type === "wild_rainbow") {
        // gate: must have at least one of each color in hand BEFORE play
        const colorsInHand = new Set((game.hands[actor]||[]).filter(c=>COLORS.includes(c.color)).map(c=>c.color));
        if (colorsInHand.size < 4) { /* illegal by UI normally */ advanceTurn(1); emitState(); return; }
        // Prompt to choose one card of each color to discard (4 picks)
        const myHand = (game.hands[actor]||[]).map((c,i)=>({idx:i,color:c.color,type:c.type,img:c.img}));
        io.to(socket.id).emit("prompt", { kind:"rainbowSelects", data:{ hand: myHand }, timeoutMs: 20000 });
        const t = setTimeout(()=>{ /* timeout: auto-pick one of each by first occurrence */ resolveRainbowAuto(); }, 20000);
        function resolveRainbowAuto(){
          const needed = new Set(COLORS); const picks=[];
          const handArr = (game.hands[actor]||[]);
          for (let i=0;i<handArr.length;i++){
            const cc = handArr[i];
            if (needed.has(cc.color)) { picks.push(i); needed.delete(cc.color); }
            if (needed.size===0) break;
          }
          applyRainbow(picks);
        }
        socket.once("promptChoice", ({ kind, picks })=>{
          clearTimeout(t);
          if (kind!=="rainbowSelects" || !Array.isArray(picks) || picks.length!==4) return resolveRainbowAuto();
          applyRainbow(picks);
        });
        function applyRainbow(picks){
          // picks are indices as of prompt time; re-map carefully
          const h = game.hands[actor]||[];
          // Sort descending to splice safely
          const sorted = [...picks].sort((a,b)=>b-a);
          const removed = [];
          for (const pi of sorted){
            if (pi>=0 && pi<h.length) removed.push(h.splice(pi,1)[0]);
          }
          // Put removed to discard (no effects)
          for (const rc of removed) game.discard.push(rc);
          // After 4 discards, choose color, then END TURN
          io.to(socket.id).emit("chooseColor");
          socket.once("colorChosen", ({ color })=>{
            const chosen = COLORS.includes(color)?color:sample(COLORS);
            announce(`🌈 Rainbow: discarded one of each color. Color → ${chosen.toUpperCase()}.`);
            game.color = chosen; game.value = "wild_rainbow";
            const w = winnerIfAny(); if (w) return settleWinIf(w);
            advanceTurn(1); emitState();
          });
        }
        return;
      }
      return;
    }

    // COLORED ACTIONS + NUMBERS
    // set color/value first (note: some actions override advance logic)
    if (card.type === "number") {
      game.color = card.color; game.value = card.value;
      advanceTurn(1);
      emitState();
      return;
    }

    // Specialty colored actions
    if (card.type === "it" && card.color==="red") {
      game.color = "red"; game.value = "it";
      const prev = previousActiveSid(actor);
      const nxt  = nextActiveSid(actor);
      if (prev && nxt) {
        giveRandomCard(prev, nxt);
        announce(`🔴 IT: “We all **float** down here.” ${sidToName(prev)} floats a card to ${sidToName(nxt)}!`);
        if ((game.hands[prev]||[]).length===0) return settleWinIf(prev);
      }
      advanceTurn(1); emitState(); return;
    }
    if (card.type === "noc" && card.color==="red") {
      game.color = "red"; game.value = "noc";
      // Random active player draws 3
      const actives = activeOrder().filter(sid=>sid!==actor);
      if (actives.length){
        const target = sample(actives);
        for (let i=0;i<3;i++) drawOne(target);
        announce(`🛑 NOC: Severity 1 incident — ${sidToName(target)} draw 3 cards.`);
      }
      advanceTurn(1); emitState(); return;
    }
    if (card.type === "moon" && card.color==="blue") {
      game.color = "blue"; game.value = "moon";
      const others = activeOrder().filter(sid=>sid!==actor);
      if (others.length) {
        const target = sample(others);
        drawOne(target);
        announce(`🌙 To the Moon: the rocket lands near ${sidToName(target)} — they gain 1!`);
      }
      advanceTurn(1); emitState(); return;
    }
    if (card.type === "look" && card.color==="blue") {
      game.color = "blue"; game.value = "look";
      // Reveal top 4 to caster; click ordering (1..4)
      const top4 = [];
      for (let i=0;i<4;i++){ if (game.deck.length) top4.push(game.deck[game.deck.length-1-i]); }
      const payload = top4.map((c, i)=>({ idx:i, img:c.img, color:c.color, type:c.type }));
      io.to(socket.id).emit("prompt", { kind:"lookOrder", data:{ top4: payload }, timeoutMs:15000 });
      const t = setTimeout(()=>{ /* keep natural order */ announce(`👀 Look: top 4 of the draw pile were reordered.`); emitState(); }, 15000);
      socket.once("promptChoice", ({ kind, order })=>{
        clearTimeout(t);
        if (kind==="lookOrder" && Array.isArray(order) && order.length===4) {
          // order is indices 0..3 where first is the next to draw
          // We rebuild deck top accordingly
          const actual = [];
          for (const oi of order) if (typeof oi==="number" && top4[oi]) actual.push(top4[oi]);
          // remove existing 4 from deck top
          for (let i=0;i<top4.length;i++) game.deck.pop();
          // push back in reverse (last should be deepest)
          for (let i=actual.length-1;i>=0;i--) game.deck.push(actual[i]);
        }
        announce(`👀 Look: top 4 of the draw pile were reordered.`);
        advanceTurn(1); emitState();
      });
      return;
    }
    if (card.type === "happy" && card.color==="green") {
      game.color = "green"; game.value = "happy";
      game.roundFlags.happy = true;
      game._happyFlagged = new Set();
      announce(`😊 Happy: Be kind! Tap 🙂 on any message to make the author draw 1 (once per message) until round ends.`);
      advanceTurn(1); emitState(); return;
    }
    if (card.type === "recycle" && card.color==="green") {
      game.color = "green"; game.value = "recycle";
      // Pool all hands
      const actives = activeOrder();
      let pool=[]; for (const sid of actives){ pool = pool.concat(game.hands[sid]||[]); game.hands[sid]=[]; }
      const totalCollected = pool.length;
      shuffle(pool);
      const per = Math.floor(totalCollected / actives.length);
      const leftover = totalCollected % actives.length;
      for (const sid of actives){
        game.hands[sid] = pool.splice(0,per);
      }
      // leftovers to bottom of draw pile
      // (push at start = bottom)
      const rest = pool.splice(0);
      for (const c of rest) game.deck.unshift(c);
      announce(`♻️ Recycle: ${totalCollected} collected → ${per} each, ${leftover} recycled to draw pile.`);
      const w = winnerIfAny(); if (w) return settleWinIf(w);
      advanceTurn(1); emitState(); return;
    }
    if (card.type === "pinky" && card.color==="yellow") {
      game.color = "yellow"; game.value = "pinky";
      // target picker among actives (not self)
      const targets = activeOrder().filter(sid=>sid!==actor).map(sid=>({ sid, name: sidToName(sid) }));
      requireChoice(actor, "targetPicker", { targets }, 15000,
        ({ targetSid })=>{
          if (!targetSid || !game.hands[targetSid]) { advanceTurn(1); emitState(); return; }
          let pool = (game.hands[actor]||[]).concat(game.hands[targetSid]||[]);
          shuffle(pool);
          const aCount = Math.floor(pool.length/2);
          const bCount = pool.length - aCount;
          game.hands[actor] = pool.splice(0,aCount);
          game.hands[targetSid] = pool.splice(0,bCount);
          announce(`🤝 Pinky Promise: ${sidToName(actor)} and ${sidToName(targetSid)} reshuffled & split hands.`);
          const w = winnerIfAny(); if (w) return settleWinIf(w);
          advanceTurn(1); emitState();
        },
        ()=>{ advanceTurn(1); emitState(); }
      );
      return;
    }
    if (card.type === "shopping" && card.color==="yellow") {
      game.color = "yellow"; game.value = "shopping";
      // target picker
      const targets = activeOrder().filter(sid=>sid!==actor).map(sid=>({ sid, name: sidToName(sid) }));
      requireChoice(actor, "targetPicker", { targets }, 15000,
        ({ targetSid })=>{
          if (!targetSid || !game.hands[targetSid]) { advanceTurn(1); emitState(); return; }
          // Show both hands (indices) privately; choose 2 of mine, 1 of theirs
          const mine = (game.hands[actor]||[]).map((c,i)=>({idx:i,img:c.img,color:c.color,type:c.type}));
          const theirs = (game.hands[targetSid]||[]).map((c,i)=>({idx:i,img:c.img,color:c.color,type:c.type}));
          requireChoice(actor, "shoppingPick", { mine, theirs }, 20000,
            ({ myTwo, theirOne })=>{
              if (!Array.isArray(myTwo) || myTwo.length!==2 || typeof theirOne!=="number") { advanceTurn(1); emitState(); return; }
              const aHand = game.hands[actor]||[], bHand = game.hands[targetSid]||[];
              // grab actual cards safely
              const [a1Idx,a2Idx] = [...myTwo].sort((x,y)=>y-x);
              const takeA1 = aHand[a1Idx]; const takeA2 = aHand[a2Idx];
              const takeB  = bHand[theirOne];
              if (!takeA1 || !takeA2 || !takeB) { advanceTurn(1); emitState(); return; }
              // remove
              const remA1 = aHand.splice(a1Idx,1)[0];
              const remA2 = aHand.splice(a2Idx,1)[0];
              const remB  = bHand.splice(theirOne,1)[0];
              // place swapped
              aHand.push(remB);
              bHand.push(remA1, remA2);
              announce(`🛍️ Shopping: ${sidToName(actor)} traded 2 for 1 with ${sidToName(targetSid)}.`);
              const w = winnerIfAny(); if (w) return settleWinIf(w);
              advanceTurn(1); emitState();
            },
            ()=>{ advanceTurn(1); emitState(); }
          );
        },
        ()=>{ advanceTurn(1); emitState(); }
      );
      return;
    }

    // Standard base actions
    if (card.type === "skip") {
      game.color = card.color; game.value = "skip";
      announce(`⛔ Skip next`);
      advanceTurn(2); emitState(); return;
    }
    if (card.type === "reverse") {
      game.color = card.color; game.value = "reverse";
      game.dir *= -1;
      announce(`🔁 Reverse direction`);
      if (activeOrder().length === 2) advanceTurn(2); else advanceTurn(1);
      emitState(); return;
    }
    if (card.type === "draw2") {
      game.color = card.color; game.value = "draw2";
      beginPenalty(actor, "draw2");
      emitState(); return;
    }

  }); // end playCard

  // COLOR chosen for standard wild prompts that we emitted as separate event (fallback safety)
  socket.on("colorChosen", ({ color })=>{
    // handled in the specific flows above
  });

  // PROMPT resolution generic (client uses "promptChoice")
  socket.on("promptChoice", (_)=>{/* consumed by requireChoice listeners */});

  socket.on("disconnect", () => {
    const me = players.find(p=>p.id===socket.id);
    if (!me) return;
    me.id = "";
    setTimeout(() => {
      if (!me.id) {
        const idx = players.indexOf(me);
        if (idx>=0) {
          announce(`👋 ${me.name} left.`);
          players.splice(idx,1);
          if (game?.hands) delete game.hands[me.sid];
          endGameIfNeeded();
          emitState();
        }
      }
    }, 60000);
    emitState();
  });
});

server.listen(PORT, () => console.log("🚀 listening on", PORT));
