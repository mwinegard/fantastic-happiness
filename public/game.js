const socket = io();
let myId = null;
let isMyTurn = false;
let muted = false;

const handDiv = document.getElementById("player-hand");
const discardPile = document.getElementById("discard-pile");
const drawPile = document.getElementById("draw-pile");
const playerList = document.getElementById("player-list");
const chatLog = document.getElementById("chat-log");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const joinForm = document.getElementById("join-form");
const gameScreen = document.getElementById("game-screen");
const nameInput = document.getElementById("name");
const unoButton = document.getElementById("uno-btn");
const muteBtn = document.getElementById("mute-toggle");

const sounds = {};
["draw", "skip", "reverse", "wild", "special", "number", "win", "lose", "start", "joined", "uno"].forEach(name => {
  const audio = new Audio(`/assets/sounds/${name}.mp3`);
  audio.volume = 0.6;
  sounds[name] = audio;
});

function playSound(name) {
  if (muted) return;
  const sound = sounds[name];
  if (sound) sound.play().catch(() => {});
}

muteBtn.addEventListener("click", () => {
  muted = !muted;
  muteBtn.textContent = muted ? "🔇 Sound Off" : "🔊 Sound On";
});

// Wild color picker
const wildButtons = document.createElement("div");
wildButtons.id = "wild-buttons";
["red", "blue", "green", "yellow"].forEach(color => {
  const btn = document.createElement("button");
  btn.textContent = color.toUpperCase();
  btn.style.backgroundColor = color;
  btn.onclick = () => {
    socket.emit("chooseColor", { color });
    wildButtons.style.display = "none";
  };
  wildButtons.appendChild(btn);
});
document.body.appendChild(wildButtons);
wildButtons.style.display = "none";

// Turn countdown timer
let countdownInterval;
const turnIndicator = document.createElement("div");
turnIndicator.id = "turn-indicator";
document.body.appendChild(turnIndicator);

function startCountdown(seconds = 60) {
  let remaining = seconds;
  clearInterval(countdownInterval);
  turnIndicator.textContent = `⏳ ${remaining}s`;
  countdownInterval = setInterval(() => {
    remaining--;
    turnIndicator.textContent = `⏳ ${remaining}s`;
    if (remaining <= 0) clearInterval(countdownInterval);
  }, 1000);
}

joinForm.addEventListener("submit", e => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (name) {
    socket.emit("join", { name });
  }
});

socket.on("joinDenied", msg => {
  alert(msg || "You can't join right now.");
});

socket.on("joined", ({ id, name }) => {
  myId = id;
  joinForm.style.display = "none";
  gameScreen.style.display = "block";
});

socket.on("state", state => {
  isMyTurn = state.turn === myId;
  handDiv.innerHTML = "";
  playerList.innerHTML = "";

  state.players.forEach(player => {
    const div = document.createElement("div");
    div.textContent = `${player.name} (${player.handSize}) ${player.isSpectator ? "👀" : ""}`;
    if (player.handSize === 1) div.style.color = "red";
    playerList.appendChild(div);
  });

  discardPile.innerHTML = "";
  if (state.discardTop) {
    const img = document.createElement("img");
    img.src = `/assets/cards/${state.discardTop}.png`;
    img.className = "card";
    discardPile.appendChild(img);
  }

  if (isMyTurn) startCountdown();

  const hand = state.players.find(p => p.id === myId);
  if (!hand) return;

  const cards = state.deckSize ? 7 : 0;
  for (let i = 0; i < cards; i++) {
    const card = document.createElement("img");
    card.className = "card";
    card.src = `/assets/cards/back.png`;
    handDiv.appendChild(card);
  }
});

socket.on("chat", ({ from, message }) => {
  const msg = document.createElement("div");
  msg.innerHTML = `<strong>${from}:</strong> ${message}`;
  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
});

chatSend.addEventListener("click", () => {
  const msg = chatInput.value.trim();
  if (msg) {
    socket.emit("chat", msg);
    chatInput.value = "";
  }
});

drawPile.addEventListener("click", () => {
  if (isMyTurn) socket.emit("drawCard");
});

unoButton.addEventListener("click", () => {
  socket.emit("callUno");
});
