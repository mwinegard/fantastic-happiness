// public/game.js

const socket = io();

const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name");
const lobbyInput = document.getElementById("lobby");
const gameDiv = document.getElementById("game");
const handDiv = document.getElementById("player-hand");
const drawPile = document.getElementById("draw-pile");
const discardPile = document.getElementById("discard-pile");
const unoButton = document.getElementById("uno-btn");
const wildButtons = document.getElementById("wild-buttons");
const chatBox = document.getElementById("chat-box");
const chatSend = document.getElementById("chat-send");
const chatLog = document.getElementById("chat-log");
const playerList = document.getElementById("player-list");
const turnIndicator = document.getElementById("turn-indicator");
const leaveBtn = document.getElementById("leave-btn");
const muteBtn = document.getElementById("mute-toggle");
const lobbyNameDisplay = document.getElementById("lobby-name-display");

let currentLobby = "";
let muted = false;

const sounds = {
  draw: new Audio("/assets/sounds/draw.mp3"),
  skip: new Audio("/assets/sounds/skip.mp3"),
  reverse: new Audio("/assets/sounds/reverse.mp3"),
  wild: new Audio("/assets/sounds/wild.mp3"),
  number: new Audio("/assets/sounds/number.mp3"),
  win: new Audio("/assets/sounds/win.mp3"),
  lose: new Audio("/assets/sounds/lose.mp3"),
  start: new Audio("/assets/sounds/start.mp3"),
  joined: new Audio("/assets/sounds/joined.mp3"),
  uno: new Audio("/assets/sounds/uno.mp3"),
  special: new Audio("/assets/sounds/special.mp3")
};

function playSound(name) {
  if (muted) return;
  const sound = sounds[name];
  if (sound) sound.play().catch(() => {});
}

if (muteBtn) {
  muteBtn.addEventListener("click", () => {
    muted = !muted;
    muteBtn.textContent = muted ? "🔇 Sound Off" : "🔊 Sound On";
  });
}

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const lobby = lobbyInput.value.trim().toLowerCase();
  if (name && lobby) {
    currentLobby = lobby;
    socket.emit("join", { name, lobby });
    document.getElementById("lobby-form").style.display = "none";
    document.getElementById("game").style.display = "block";
    lobbyNameDisplay.textContent = lobby;
  }
});

chatSend.addEventListener("click", () => {
  const msg = chatBox.value.trim();
  if (msg) {
    socket.emit("chat", msg);
    chatBox.value = "";
  }
});

leaveBtn.addEventListener("click", () => {
  socket.emit("leave");
  window.location.reload();
});

socket.on("state", (state) => {
  renderGame(state);
});

socket.on("chat", (msg) => {
  const p = document.createElement("p");
  p.textContent = msg;
  chatLog.appendChild(p);
  chatLog.scrollTop = chatLog.scrollHeight;
});

function renderGame(state) {
  // Update hand, piles, turn, etc.
  const hand = state.hands?.[socket.id] || [];
  handDiv.innerHTML = "";
  hand.forEach(card => {
    const img = document.createElement("img");
    img.src = state.hasStarted ? `/assets/cards/${card}.png` : `/assets/cards/back.png`;
    img.className = "card";
    if (state.hasStarted) {
      img.addEventListener("click", () => {
        socket.emit("play", card);
      });
    }
    handDiv.appendChild(img);
  });

  discardPile.innerHTML = "";
  const top = state.discardPile?.[state.discardPile.length - 1];
  if (top) {
    const img = document.createElement("img");
    img.src = `/assets/cards/${top}.png`;
    img.className = "card";
    discardPile.appendChild(img);
  }

  drawPile.innerHTML = "";
  if (state.hasStarted) {
    const drawImg = document.createElement("img");
    drawImg.src = `/assets/cards/back.png`;
    drawImg.className = "card";
    drawImg.addEventListener("click", () => socket.emit("draw"));
    drawPile.appendChild(drawImg);
  }

  turnIndicator.style.display = "block";
  turnIndicator.textContent = socket.id === state.currentTurn ? "It's your turn!" : "Waiting for other players...";

  // Player list
  playerList.innerHTML = "";
  state.players.forEach(player => {
    const li = document.createElement("li");
    li.textContent = player.name;
    if (player.id === state.currentTurn) {
      li.classList.add("active");
    }
    playerList.appendChild(li);
  });

  unoButton.style.display = state.hands?.[socket.id]?.length === 2 ? "inline-block" : "none";
}

unoButton.addEventListener("click", () => {
  socket.emit("uno");
});

document.querySelectorAll(".wild-choice").forEach(btn => {
  btn.addEventListener("click", () => {
    socket.emit("chooseColor", btn.dataset.color);
    wildButtons.style.display = "none";
  });
});

socket.on("chooseColor", () => {
  wildButtons.style.display = "block";
});
