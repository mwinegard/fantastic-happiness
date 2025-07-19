const socket = io();
let playerName = "";
let lobbyId = "";

const joinScreen = document.getElementById("join-screen");
const gameScreen = document.getElementById("game-screen");
const playerNameInput = document.getElementById("playerName");
const lobbyInput = document.getElementById("lobbyId");
const joinButton = document.getElementById("joinButton");
const leaveButton = document.getElementById("leaveBtn");
const playerInfo = document.getElementById("playerInfo");

const chatLog = document.getElementById("chat-log");
const chatInput = document.getElementById("chatInput");
const chatSend = document.getElementById("chatSend");

const handContainer = document.getElementById("hand");
const pileCard = document.getElementById("pile-card");
const drawStack = document.getElementById("draw-stack");

// 👉 Join Game
joinButton.addEventListener("click", () => {
  playerName = playerNameInput.value.trim();
  lobbyId = lobbyInput.value.trim();

  if (!playerName || !lobbyId) return alert("Please enter a name and lobby code.");

  socket.emit("joinLobby", { playerName, lobbyId });
});

// 👉 On successful join
socket.on("joinedLobby", (state) => {
  joinScreen.style.display = "none";
  gameScreen.style.display = "block";
  playerInfo.innerText = `👤 ${playerName} | Lobby: ${lobbyId}`;
  renderState(state);
});

// 👉 Update game state
socket.on("gameState", (state) => {
  renderState(state);
});

// 👉 Receive chat
socket.on("chatMessage", ({ sender, message, system }) => {
  const msg = document.createElement("div");
  msg.innerHTML = `<strong style="color:${system ? '#003f5c' : '#000'}">${sender}:</strong> ${message}`;
  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
});

// 👉 Send chat
chatSend.addEventListener("click", sendChat);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

function sendChat() {
  const message = chatInput.value.trim();
  if (!message) return;
  socket.emit("chatMessage", { lobbyId, sender: playerName, message });
  chatInput.value = "";
}

// 👉 Leave
leaveButton.addEventListener("click", () => {
  socket.emit("leaveLobby", { lobbyId, playerName });
  location.reload();
});

// 👉 Render cards & pile (placeholder)
function renderState(state) {
  handContainer.innerHTML = "";
  const player = state.players.find(p => p.name === playerName);
  if (player) {
    player.hand.forEach(card => {
      const img = document.createElement("img");
      img.src = `assets/cards/${card}`;
      handContainer.appendChild(img);
    });
  }

  if (state.pileTopCard) {
    pileCard.src = `assets/cards/${state.pileTopCard}`;
  }

  if (state.drawPileCount > 0) {
    drawStack.style.display = "inline";
  } else {
    drawStack.style.display = "none";
  }
}
