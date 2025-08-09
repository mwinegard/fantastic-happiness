const socket = io({ autoConnect: true });
window.socket = socket; // for inline fallback

let me = { id:null, name:null, spectator:false };
let current = null, started = false, direction = 1, color = null, top = null;
let turnEndsAt = null, countdownEndsAt = null, myHand = [], isMyTurn = false;
let muted = false, ready = false;

// Elements
const joinForm = document.getElementById("join-form");
const joinBtn  = document.getElementById("join-btn");
const nameInput = document.getElementById("name");
const joinScreen = document.getElementById("join-screen");
const gameScreen = document.getElementById("game-screen");
const playerList = document.getElementById("player-list");
const drawPile = document.getElementById("draw-pile");
const discardTop = document.getElementById("discard-top");
const handDiv = document.getElementById("player-hand");
const wildButtons = document.getElementById("wild-buttons");
const unoBtn = document.getElementById("uno-btn");
const muteBtn = document.getElementById("mute-toggle");
const chatLog = document.getElementById("chat-log");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const turnIndicator = document.getElementById("turn-indicator");
const dirLabel = document.getElementById("dir-label");
const colorLabel = document.getElementById("color-label");

// Sounds (non-blocking if files missing)
const sounds = {};
["draw","skip","reverse","wild","special","number","win","lose","start","joined","uno"].forEach(n=>{
  try { const a = new Audio(`assets/sounds/${n}.mp3`); a.preload = "auto"; sounds[n] = a; } catch {}
});
function playSound(name){ if(!muted && sounds[name]) { try { sounds[name].currentTime = 0; sounds[name].play(); } catch {} } }
muteBtn && muteBtn.addEventListener("click", () => {
  muted = !muted; muteBtn.textContent = muted ? "🔇 Sound Off" : "🔊 Sound On";
});

// Helpers
function cardImg(card){
  if (!card) return "assets/cards/back.png";
  if (card.type === "wild") return "assets/cards/wild.png";
  if (card.type === "wild_draw4") return "assets/cards/wild_draw4.png";
  if (card.type === "number") return `assets/cards/${card.color}_${card.value}.png`;
  if (card.type === "skip") return `assets/cards/${card.color}_skip.png`;
  if (card.type === "reverse") return `assets/cards/${card.color}_reverse.png`;
  if (card.type === "draw2") return `assets/cards/${card.color}_draw.png`;
  return "assets/cards/back.png";
}
function legal(card){
  if (!started || !top) return false;
  if (card.type === "wild" || card.type === "wild_draw4") return true;
  if (card.type === "number") return (card.color === color || (typeof top.value !== "undefined" && card.value === top.value));
  return (card.color === color || card.type === top.type);
}
function msToSec(ms){ return Math.max(0, Math.ceil(ms/1000)); }
function setUNOEnabled(){ if(unoBtn) unoBtn.disabled = !(myHand.length === 2 && started && !me.spectator); }

function renderPlayers(list, currentId){
  if (!playerList) return;
  playerList.innerHTML = "";
  (list||[]).forEach(p=>{
    const li = document.createElement("li");
    if (p.id === me.id) li.classList.add("me");
    if (p.id === currentId) li.classList.add("turn");
    li.innerHTML = `<span>${p.name}${p.spectator ? " (spectator)" : ""}</span><span>${p.spectator ? "—" : p.handCount}</span>`;
    playerList.appendChild(li);
  });
}
function renderPiles(){
  if (discardTop) discardTop.src = cardImg(top);
  if (colorLabel) colorLabel.textContent = `Color: ${color ? color.toUpperCase() : "—"}`;
  if (dirLabel) dirLabel.textContent = `Direction: ${direction === 1 ? "→" : "←"}`;
}
function renderHand(){
  if (!handDiv) return;
  handDiv.innerHTML = "";
  if (me.spectator || !started) return;
  myHand.forEach((c, i)=>{
    const img = document.createElement("img");
    img.src = cardImg(c);
    img.alt = "card";
    img.draggable = false;
    img.className = "card " + (isMyTurn && legal(c) ? "playable" : "unplayable");
    if (isMyTurn && legal(c)) {
      img.classList.add("clickable");
      img.addEventListener("click", () => socket.emit("playCard", { index: i }));
    }
    handDiv.appendChild(img);
  });
  setUNOEnabled();
}
function renderTimers(){
  if (!turnIndicator) return;
  if (countdownEndsAt && !started) turnIndicator.textContent = `Game starts in ${msToSec(countdownEndsAt - Date.now())}s`;
  else if (turnEndsAt && started)  turnIndicator.textContent = `Your turn ends in ${msToSec(turnEndsAt - Date.now())}s`;
  else turnIndicator.textContent = "—";
}
setInterval(renderTimers, 250);

// Socket lifecycle + hello
socket.on("connect", () => { ready = true; socket.emit("hello", { when: Date.now() }); });
socket.on("disconnect", () => { ready = false; });
socket.on("connect_error", (err) => {
  console.error("Socket connect_error:", err);
  const note = document.getElementById("sock-note");
  if (note) note.textContent = "Connecting… if Join seems unresponsive, wait a second and try again.";
});
socket.on("helloAck", (payload) => { console.log("helloAck from server:", payload); });

// Join: make globally callable for inline fallback
function doJoin(){
  const name = (nameInput && nameInput.value || "").trim();
  try { socket.emit("clientJoinClick", { at: Date.now(), name }); } catch {}
  if (!ready) {
    if (joinBtn) {
      const old = joinBtn.textContent;
      joinBtn.disabled = true; joinBtn.textContent = "Connecting…";
      const onceConnect = () => {
        socket.emit("join", name);
        joinBtn.disabled = false; joinBtn.textContent = old;
        socket.off("connect", onceConnect);
      };
      socket.on("connect", onceConnect);
      socket.connect();
    } else {
      socket.connect();
      socket.once("connect", () => socket.emit("join", name));
    }
    return;
  }
  socket.emit("join", name);
}
window.doJoin = doJoin;
joinBtn && joinBtn.addEventListener("click", doJoin);

// Server events
socket.on("me", (payload) => {
  me = payload || me;
  if (!me || !me.id) return;
  if (joinScreen) joinScreen.style.display = "none";
  if (gameScreen) gameScreen.style.display = "block";
});
socket.on("state", (s) => {
  started = !!s.started;
  countdownEndsAt = s.countdownEndsAt;
  turnEndsAt = s.turnEndsAt;
  current = s.current;
  direction = s.direction;
  color = s.color;
  top = s.top;
  isMyTurn = (current === me.id);

  socket.emit("getMyHand");

  renderPlayers(s.players, current);
  renderPiles();
  renderTimers();

  if (drawPile) {
    if (isMyTurn && !me.spectator) drawPile.classList.add("clickable");
    else drawPile.classList.remove("clickable");
  }
});
socket.on("handSnapshot", (hand) => { myHand = hand || []; renderHand(); });
socket.on("myHand", (hand) => { myHand = hand || []; renderHand(); });
socket.on("announce", (text) => {
  if (!chatLog) return;
  const div = document.createElement("div");
  div.textContent = text; chatLog.appendChild(div); chatLog.scrollTop = chatLog.scrollHeight;
});
socket.on("chat", ({from, msg}) => {
  if (!chatLog) return;
  const div = document.createElement("div");
  div.innerHTML = `<strong>${from}:</strong> ${msg}`;
  chatLog.appendChild(div); chatLog.scrollTop = chatLog.scrollHeight;
});
socket.on("playSound", (name) => playSound(name));
socket.on("chooseColor", () => { if (wildButtons) wildButtons.style.display = "flex"; });

// UI events
drawPile && drawPile.addEventListener("click", () => {
  if (isMyTurn && !me.spectator) socket.emit("drawCard");
});
unoBtn && unoBtn.addEventListener("click", () => socket.emit("callUno"));
wildButtons && wildButtons.addEventListener("click", (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  wildButtons.style.display = "none";
  socket.emit("colorChosen", { color: btn.getAttribute("data-color") });
});
chatSend && chatSend.addEventListener("click", () => {
  const msg = (chatInput && chatInput.value || "").trim();
  if (msg) socket.emit("chat", msg);
  if (chatInput) chatInput.value = "";
});
chatInput && chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") chatSend.click(); });

// Periodic hand sync (cheap)
setInterval(()=>socket.emit("getMyHand"), 2000);
