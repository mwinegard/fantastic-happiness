const socket = io();
let playerName = localStorage.getItem("unoPlayerName") || "";
let lobbyId = localStorage.getItem("unoLobbyId") || "";
let playerColor = "";

const COLORS = ["red", "blue", "green", "yellow"];

if (!playerName || !lobbyId) {
  playerName = prompt("Enter your name (max 20 chars, letters/numbers only):") || "";
  lobbyId = prompt("Enter lobby ID (no spaces):") || "";
  playerName = playerName.substring(0, 20).replace(/[^a-zA-Z0-9 ]/g, "");
  lobbyId = lobbyId.trim();
  playerColor = COLORS[Math.floor(Math.random() * COLORS.length)];

  localStorage.setItem("unoPlayerName", playerName);
  localStorage.setItem("unoLobbyId", lobbyId);
}

socket.emit("joinLobby", { name: playerName, lobbyId, color: playerColor });

const gameArea = document.getElementById("game");
const playerHand = document.getElementById("player-hand");
const discardPile = document.getElementById("discard-pile");
const drawPile = document.getElementById("draw-pile");
const playerList = document.getElementById("player-list");
const chatBox = document.getElementById("chat-box");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const message = chatInput.value.trim();
  if (message) {
    socket.emit("chat message", {
      lobbyId,
      name: playerName,
      color: playerColor,
      text: message
    });
    chatInput.value = "";
  }
});

drawPile.addEventListener("click", () => {
  socket.emit("drawCard");
});

socket.on("chat message", ({ name, color, text, isSystem }) => {
  const msg = document.createElement("div");
  msg.className = "chat-message";
  msg.innerHTML = `<strong style="color:${isSystem ? 'darkblue' : 'black'}">${name}:</strong> ${text}`;
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
});

socket.on("lobbyFull", () => {
  alert("This lobby is full. Please join another.");
});

socket.on("gameState", (state) => {
  playerHand.innerHTML = "";
  discardPile.innerHTML = "";
  drawPile.innerHTML = "";

  // Draw pile UI
  const drawStack = document.createElement("img");
  drawStack.src = "assets/cards/back.png";
  drawStack.className = "card stack";
  drawPile.appendChild(drawStack);

  // Discard pile UI
  const topCard = state.discardPile[state.discardPile.length - 1];
  if (topCard) {
    const cardEl = document.createElement("img");
    cardEl.src = `assets/cards/${topCard.color}_${topCard.value}.png`;
    cardEl.className = "card";
    discardPile.appendChild(cardEl);
  }

  // Player hand
  const me = state.players.find(p => p.name === playerName);
  if (me && me.hand) {
    me.hand.forEach(card => {
      const cardEl = document.createElement("img");
      cardEl.src = `assets/cards/${card.color}_${card.value}.png`;
      cardEl.className = "card";
      cardEl.addEventListener("click", () => {
        socket.emit("playCard", { card });
      });
      playerHand.appendChild(cardEl);
    });
  }

  // Player list
  playerList.innerHTML = "";
  state.players.forEach((p, idx) => {
    const li = document.createElement("li");
    const isTurn = state.currentPlayer === p.id;
    li.innerHTML = `${isTurn ? "👉 " : ""}<span style="color:${
      p.color || "black"
    }">${p.name}</span> 🃏 ${p.handCount} (${p.score})`;
    playerList.appendChild(li);
  });
});
