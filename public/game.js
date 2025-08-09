const socket = io();

// --- State
let me = { id:null, name:null, spectator:false };
let current = null;
let started = false;
let direction = 1;
let color = null;
let top = null;
let turnEndsAt = null;
let countdownEndsAt = null;
let myHand = [];
let isMyTurn = false;
let muted = false;

// --- Elements
const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name");
const joinScreen = document.getElementById("join-screen");
const gameScreen = document.getElementById("game-screen");

const playerList = document.getElementById("player-list");
const drawPile = document.getElementById("draw-pile");
const discardPile = document.getElementById("discard-pile");
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

// --- Sounds
const sounds = {};
["draw","skip","reverse","wild","special","number","win","lose","start","joined","uno"].forEach(n=>{
  const a = new Audio(`assets/sounds/${n}.mp3`);
  a.preload = "auto";
  sounds[n] = a;
});
function playSound(name){
  if (muted) return;
  const s = sounds[name];
  if (s) { s.currentTime = 0; s.play().catch(()=>{}); }
}
muteBtn.addEventListener("click", () => {
  muted = !muted;
  muteBtn.textContent = muted ? "🔇 Sound Off" : "🔊 Sound On";
});

// --- Helpers
function cardImg(card){
  if (!card) return "assets/cards/back.png";
  if (card.type === "wild") return "assets/cards/wild.png";
  if (card.type === "wild_draw4") return "assets/cards/wild_draw4.png";
  if (card.type === "number") return `assets/cards/${card.color}_${card.value}.png`;
  // action
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
function msToSec(ms){
  return Math.max(0, Math.ceil((ms)/1000));
}
function setUNOEnabled(){
  const mineCount = myHand.length;
  // Enable when at 2 cards (about to go to 1)
  unoBtn.disabled = !(mineCount === 2 && started && !me.spectator);
}

// --- UI Renders
function renderPlayers(list, currentId){
  playerList.innerHTML = "";
  list.forEach(p=>{
    const li = document.createElement("li");
    if (p.id === me.id) li.classList.add("me");
    if (p.id === currentId) li.classList.add("turn");
    li.innerHTML = `<span>${p.name}${p.spectator ? " (spectator)" : ""}</span><span>${p.spectator ? "—" : p.handCount}</span>`;
    playerList.appendChild(li);
  });
}

function renderPiles(){
  discardTop.src = cardImg(top);
  colorLabel.textContent = `Color: ${color ? color.toUpperCase() : "—"}`;
  dirLabel.textContent = `Direction: ${direction === 1 ? "→" : "←"}`;
}

function renderHand(){
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
      img.addEventListener("click", () => {
        socket.emit("playCard", { index: i });
      });
    }
    handDiv.appendChild(img);
  });

  setUNOEnabled();
}

function renderTimers(){
  if (countdownEndsAt && !started) {
    const secs = msToSec(countdownEndsAt - Date.now());
    turnIndicator.textContent = `Game starts in ${secs}s`;
  } else if (turnEndsAt && started) {
    const secs = msToSec(turnEndsAt - Date.now());
    turnIndicator.textContent = `Your turn ends in ${secs}s`;
  } else {
    turnIndicator.textContent = "—";
  }
}

setInterval(renderTimers, 250);

// --- Socket events
socket.on("me", (payload) => {
  me = payload;
  joinScreen.style.display = "none";
  gameScreen.style.display = "block";
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

  // Server doesn't send entire hand for all (privacy). It sends counts only.
  // We maintain myHand via deltas: ask server for hand when I become active.
  // For simplicity here, server lets client request my hand snapshot:
  socket.emit("getMyHand"); // lightweight ask; server responds below

  renderPlayers(s.players, current);
  renderPiles();
  renderTimers();

  // Draw pile clickable only if it's my turn and I'm active
  if (isMyTurn && !me.spectator) drawPile.classList.add("clickable");
  else drawPile.classList.remove("clickable");
});

socket.on("myHand", (hand) => {
  myHand = hand;
  renderHand();
});

socket.on("announce", (text) => {
  const div = document.createElement("div");
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});

socket.on("chat", ({from, msg}) => {
  const div = document.createElement("div");
  div.innerHTML = `<strong>${from}:</strong> ${msg}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});

socket.on("playSound", (name) => playSound(name));

socket.on("chooseColor", () => {
  wildButtons.style.display = "flex";
});

// --- UI events
joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  socket.emit("join", nameInput.value);
});

drawPile.addEventListener("click", () => {
  if (isMyTurn && !me.spectator) socket.emit("drawCard");
});

unoBtn.addEventListener("click", () => {
  socket.emit("callUno");
});

wildButtons.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  wildButtons.style.display = "none";
  const selected = btn.getAttribute("data-color");
  socket.emit("colorChosen", { color: selected });
});

chatSend.addEventListener("click", () => {
  const msg = chatInput.value.trim();
  if (msg) socket.emit("chat", msg);
  chatInput.value = "";
});
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") chatSend.click();
});

// Ask server for my hand periodically to keep in sync (cheap)
setInterval(()=>socket.emit("getMyHand"), 2000);

// Simple request/response handler for my hand
socket.on("connect", ()=>{
  // Register handler only once
  if (!socket._myHandHook) {
    socket._myHandHook = true;
    socket.on("handSnapshot", (hand) => {
      myHand = hand || [];
      renderHand();
    });
  }
});

// Request => Response
socket.on("connect", ()=>{
  socket.emit("getMyHand");
});
socket.on("handSnapshot", (hand) => {
  myHand = hand || [];
  renderHand();
});
