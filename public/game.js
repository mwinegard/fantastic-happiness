const socket = io();

let playerName = localStorage.getItem("playerName") || "";
let lobbyId = localStorage.getItem("lobbyId") || "";
let selectedColor = null;

if (!playerName || !lobbyId) {
  playerName = prompt("Enter your name (max 20 chars):").slice(0, 20).replace(/[^a-zA-Z0-9 ]/g, "");
  lobbyId = prompt("Enter lobby name:").slice(0, 20).replace(/[^a-zA-Z0-9 ]/g, "");
  localStorage.setItem("playerName", playerName);
  localStorage.setItem("lobbyId", lobbyId);
}

socket.emit("joinLobby", { playerName, lobbyId });

// DOM refs
const chatBox = document.getElementById("chatBox");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const gameArea = document.getElementById("gameArea");
const handArea = document.getElementById("hand");
const pileCard = document.getElementById("pileCard");
const drawStack = document.getElementById("drawStack");
const opponentsList = document.getElementById("opponents");

sendBtn.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});

function sendMessage() {
  const msg = chatInput.value.trim();
  if (msg) {
    socket.emit("chatMessage", { lobbyId, sender: playerName, message: msg });
    chatInput.value = "";
  }
}

socket.on("chatMessage", ({ sender, message, system }) => {
  const entry = document.createElement("div");
  entry.innerHTML = `<strong style="color:${system ? 'navy' : 'black'}">${sender}:</strong> ${message}`;
  chatBox.appendChild(entry);
  chatBox.scrollTop = chatBox.scrollHeight;
});

socket.on("joinedLobby", () => {
  document.getElementById("lobby").style.display = "none";
  gameArea.style.display = "block";
});

socket.on("gameState", ({ players, pileTopCard, drawPileCount }) => {
  const player = players.find(p => p.name === playerName);
  if (!player) return;

  handArea.innerHTML = "";
  player.hand.forEach(card => {
    const img = document.createElement("img");
    img.src = `assets/cards/${card}`;
    img.className = "card";
    img.onclick = () => socket.emit("playCard", { lobbyId, playerName, card, selectedColor });
    handArea.appendChild(img);
  });

  // Update opponents
  opponentsList.innerHTML = players
    .filter(p => p.name !== playerName)
    .map(p => `<div>${p.name} 🃏 ${p.hand.length}</div>`)
    .join("");

  // Update pile
  if (pileTopCard) {
    pileCard.src = `assets/cards/${pileTopCard}`;
    pileCard.style.display = "block";
  } else {
    pileCard.style.display = "none";
  }

  // Update draw stack count
  drawStack.onclick = () => {
    socket.emit("drawCard", { lobbyId, playerName });
  };
});

// Wild color selector UI logic
socket.on("selectColor", () => {
  const color = prompt("Choose a color (red, green, blue, yellow):").toLowerCase();
  if (["red", "green", "blue", "yellow"].includes(color)) {
    selectedColor = color;
  } else {
    selectedColor = "red";
  }
});
