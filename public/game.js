// public/game.js
const socket = io();
let myId = null;
let myLobby = null;
let myHand = [];
let chosenWild = null;
let saidUNO = false;
let timerInterval;

// DOM Elements
const nameInput = document.getElementById("name");
const lobbyInput = document.getElementById("lobby");
const joinForm = document.getElementById("join-form");
const gameDiv = document.getElementById("game");

const handDiv = document.getElementById("player-hand");
const drawPile = document.getElementById("draw-pile");
const discardPile = document.getElementById("discard-pile");

const turnLabel = document.getElementById("your-turn");
const scoreboard = document.getElementById("scoreboard");

const unoButton = document.getElementById("uno-button");
const wildSelector = document.getElementById("wild-selector");
const wildColorIndicator = document.getElementById("wild-color-indicator");

const msgDiv = document.getElementById("messages");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const timerBar = document.getElementById("timer-bar");

// JOIN
joinForm.addEventListener("submit", e => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const lobby = lobbyInput.value.trim();
  if (!name || !lobby) return;
  myId = socket.id;
  myLobby = lobby;
  socket.emit("join", { name, lobby });
  joinForm.parentElement.style.display = "none";
  gameDiv.style.display = "block";
});

// CHAT
chatSend.onclick = sendMessage;
chatInput.onkeydown = e => { if (e.key === "Enter") sendMessage(); };
function sendMessage() {
  const text = chatInput.value.trim();
  if (text) {
    socket.emit("chat", { lobby: myLobby, text });
    chatInput.value = "";
  }
}

// WILD COLOR SELECTOR
wildSelector.querySelectorAll("button").forEach(btn => {
  btn.onclick = () => {
    chosenWild = btn.dataset.color;
    socket.emit("playCard", {
      lobby: myLobby,
      card: wildSelector.dataset.card,
      chosenColor: chosenWild,
      saidUNO
    });
    wildSelector.style.display = "none";
    unoButton.style.display = "none";
    saidUNO = false;
  };
});

// UNO BUTTON
unoButton.onclick = () => {
  saidUNO = true;
  unoButton.disabled = true;
  unoButton.innerText = "✔️ UNO!";
  setTimeout(() => {
    unoButton.style.display = "none";
    unoButton.disabled = false;
    unoButton.innerText = "🚨 UNO!";
  }, 1500);
};

// GAME STATE
socket.on("state", state => {
  const player = state.players.find(p => p.id === socket.id);
  if (!player) return;

  myHand = state.hands[socket.id] || [];
  const topCard = state.topCard;

  // Current turn highlight
  turnLabel.textContent = state.currentTurn === socket.id ? "Your Turn!" : "Waiting...";

  // Wild color indicator
  const color = state.chosenColor;
  wildColorIndicator.textContent = color ? emojiFromColor(color) : "🎨";

  // UNO button logic
  if (state.currentTurn === socket.id && myHand.length === 1) {
    unoButton.style.display = "block";
  } else {
    unoButton.style.display = "none";
    saidUNO = false;
  }

  // Timer animation
  resetTimer();

  // Scoreboard
  scoreboard.innerHTML = state.players.map(p =>
    `<div class="${state.currentTurn === p.id ? "current" : ""}">
      ${p.id === socket.id ? "👉 " : ""}${p.name} 🃏 ${p.handSize} (${p.score})
    </div>`
  ).join("");

  // Hand
  handDiv.innerHTML = "";
  myHand.forEach(card => {
    const img = document.createElement("img");
    img.src = `assets/cards/${card}.png`;
    img.className = "card";
    if (state.currentTurn === socket.id) {
      img.onclick = () => {
        if (card.startsWith("wild")) {
          wildSelector.style.display = "block";
          wildSelector.dataset.card = card;
        } else {
          socket.emit("playCard", { lobby: myLobby, card, saidUNO });
          unoButton.style.display = "none";
          saidUNO = false;
        }
      };
    }
    img.classList.add("drawn");
    handDiv.appendChild(img);
  });

  // Discard
  discardPile.innerHTML = "";
  if (topCard) {
    const topImg = document.createElement("img");
    topImg.src = `assets/cards/${topCard}.png`;
    topImg.className = "card played";
    discardPile.appendChild(topImg);
  }

  // Draw
  drawPile.innerHTML = "";
  const drawImg = document.createElement("img");
  drawImg.src = "assets/cards/back.png";
  drawImg.className = "card";
  if (state.currentTurn === socket.id) {
    drawImg.onclick = () => {
      socket.emit("drawCard", { lobby: myLobby });
      unoButton.style.display = "none";
      saidUNO = false;
    };
  }
  drawPile.appendChild(drawImg);
});

// CHAT
socket.on("message", ({ from, text }) => {
  const msg = document.createElement("div");
  msg.innerHTML = `<strong>${from}</strong>: ${text}`;
  msgDiv.appendChild(msg);
  msgDiv.scrollTop = msgDiv.scrollHeight;
});

// HELPERS
function emojiFromColor(color) {
  return {
    red: "🔴", green: "🟢", blue: "🔵", yellow: "🟡"
  }[color] || "🎨";
}

function resetTimer() {
  clearInterval(timerInterval);
  timerBar.style.width = "100%";
  let timeLeft = 60;
  timerInterval = setInterval(() => {
    timeLeft--;
    timerBar.style.width = `${(timeLeft / 60) * 100}%`;
    if (timeLeft <= 0) clearInterval(timerInterval);
  }, 1000);
}
