// public/game.js
const socket = io();
let myId = null;
let myLobby = null;
let myHand = [];
let chosenWild = null;

// DOM Elements
const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name");
const lobbyInput = document.getElementById("lobby");
const gameDiv = document.getElementById("game");
const handDiv = document.getElementById("player-hand");
const drawPile = document.getElementById("draw-pile");
const discardPile = document.getElementById("discard-pile");
const turnLabel = document.getElementById("your-turn");
const wildSelector = document.getElementById("wild-selector");
const scoreboard = document.getElementById("scoreboard");
const msgDiv = document.getElementById("messages");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");

// JOIN GAME
joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const lobby = lobbyInput.value.trim();
  if (!name || !lobby) return;

  myId = socket.id;
  myLobby = lobby;
  socket.emit("join", { name, lobby });
  document.getElementById("lobby-form").style.display = "none";
  gameDiv.style.display = "block";
});

// CHAT
chatSend.onclick = sendMessage;
chatInput.onkeydown = (e) => { if (e.key === "Enter") sendMessage(); };

function sendMessage() {
  const text = chatInput.value.trim();
  if (text) {
    socket.emit("chat", { lobby: myLobby, text });
    chatInput.value = "";
  }
}

// WILD SELECT
wildSelector.querySelectorAll("button").forEach(btn => {
  btn.onclick = () => {
    chosenWild = btn.dataset.color;
    socket.emit("playCard", { lobby: myLobby, card: wildSelector.dataset.card, chosenColor: chosenWild });
    wildSelector.style.display = "none";
  };
});

// STATE UPDATE
socket.on("state", state => {
  const player = state.players.find(p => p.id === socket.id);
  if (!player) return;
  myHand = state.hands[socket.id] || [];

  // Render scoreboard
  scoreboard.innerHTML = state.players.map(p =>
    `${p.id === state.currentTurn ? "👉" : ""} ${p.name} 🃏 ${p.handSize} (${p.score})`).join("<br>");

  // Turn indicator
  turnLabel.textContent = state.currentTurn === socket.id ? "Your Turn!" : "Waiting...";

  // Render hand
  handDiv.innerHTML = "";
  myHand.forEach(card => {
    const img = document.createElement("img");
    img.src = `assets/cards/${card}.png`;
    img.className = "card";
    img.onclick = () => {
      if (!card.startsWith("wild")) {
        socket.emit("playCard", { lobby: myLobby, card });
      } else {
        wildSelector.style.display = "block";
        wildSelector.dataset.card = card;
      }
    };
    handDiv.appendChild(img);
  });

  // Discard pile
  discardPile.innerHTML = "";
  const topCard = state.topCard;
  if (topCard) {
    const img = document.createElement("img");
    img.src = `assets/cards/${topCard}.png`;
    img.className = "card";
    discardPile.appendChild(img);
  }

  // Draw pile
  drawPile.innerHTML = "";
  const back = document.createElement("img");
  back.src = "assets/cards/back.png";
  back.className = "card";
  back.onclick = () => socket.emit("drawCard", { lobby: myLobby });
  drawPile.appendChild(back);
});

// CHAT MESSAGES
socket.on("message", ({ from, text }) => {
  const msg = document.createElement("div");
  msg.innerHTML = `<strong>${from}</strong>: ${text}`;
  msgDiv.appendChild(msg);
  msgDiv.scrollTop = msgDiv.scrollHeight;
});
