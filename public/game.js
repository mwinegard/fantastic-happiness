const socket = io();
let playerId = null;
let lobbyId = null;

// Join lobby and name setup
document.getElementById("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("playerName");
  const lobbyInput = document.getElementById("lobbyId");

  const name = nameInput.value.trim().slice(0, 20);
  const lobby = lobbyInput.value.trim().slice(0, 20);

  if (name && lobby && /^[a-zA-Z0-9]+$/.test(name + lobby)) {
    socket.emit("joinLobby", { name, lobbyId: lobby });
    lobbyId = lobby;
  }
});

// Receive player ID
socket.on("init", (id) => {
  playerId = id;
});

// Update game state
socket.on("gameState", (state) => {
  updateUI(state);
});

// Handle chat messages
socket.on("chatMessage", (msg) => {
  const chatBox = document.getElementById("chat");
  const newMsg = document.createElement("div");

  const sender = msg.from || "System";
  const color = msg.color || "black";

  newMsg.innerHTML = `<strong style="color:${color}">${sender}:</strong> ${msg.text}`;
  chatBox.appendChild(newMsg);
  chatBox.scrollTop = chatBox.scrollHeight;
});

// Send chat messages
document.getElementById("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("chatInput");
  const msg = input.value.trim();
  if (msg) {
    socket.emit("chatMessage", msg);
    input.value = "";
  }
});

// Update UI based on state
function updateUI(state) {
  // Example logic for updating cards and turns
  const gameArea = document.getElementById("gameArea");
  if (!state || !state.players) return;

  const currentPlayer = state.players.find((p) => p.id === playerId);
  const isMyTurn = state.turnId === playerId;

  document.getElementById("yourTurn").textContent = isMyTurn ? "🎯 Your turn!" : "⏳ Waiting...";

  // Render hand
  const handContainer = document.getElementById("hand");
  handContainer.innerHTML = "";
  currentPlayer.hand.forEach((card) => {
    const img = document.createElement("img");
    img.src = `/assets/cards/${card}.png`;
    img.alt = card;
    img.className = "card";
    img.onclick = () => {
      if (isMyTurn) {
        socket.emit("playCard", card);
      }
    };
    handContainer.appendChild(img);
  });

  // Render draw pile
  const drawStack = document.getElementById("drawStack");
  drawStack.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const img = document.createElement("img");
    img.src = "/assets/cards/back.png";
    img.className = "card back";
    img.style.marginLeft = `-${i * 3}px`;
    drawStack.appendChild(img);
  }

  drawStack.onclick = () => {
    if (isMyTurn) socket.emit("drawCard");
  };
}
