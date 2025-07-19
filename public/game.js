const socket = io();
let playerId = null;
let selectedColor = null;
let turnTimer = null;

// Restore name/lobby from storage
window.onload = () => {
  const savedName = localStorage.getItem("playerName");
  const savedLobby = localStorage.getItem("lobbyId");

  if (savedName && savedLobby) {
    joinGame(savedName, savedLobby);
  }
};

// Handle join form submission
document.getElementById("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("name-input").value.trim();
  const lobby = document.getElementById("lobby-input").value.trim();

  if (!/^[a-zA-Z0-9 ]{1,20}$/.test(name)) {
    alert("Invalid name.");
    return;
  }

  if (!/^[a-zA-Z0-9]{1,20}$/.test(lobby)) {
    alert("Invalid lobby ID.");
    return;
  }

  localStorage.setItem("playerName", name);
  localStorage.setItem("lobbyId", lobby);

  joinGame(name, lobby);
});

function joinGame(name, lobby) {
  socket.emit("joinLobby", { playerName: name, lobbyId: lobby });
  document.getElementById("join-screen").style.display = "none";
  document.getElementById("game-container").style.display = "block";
}

// Game state received
socket.on("gameState", (state) => {
  playerId = socket.id;
  renderGame(state);
});

function renderGame(state) {
  const handContainer = document.getElementById("hand");
  const opponentsContainer = document.getElementById("opponents");
  const topCardImg = document.getElementById("top-card");
  const wildColorDisplay = document.getElementById("wild-color");

  handContainer.innerHTML = "";
  opponentsContainer.innerHTML = "";

  const currentPlayer = state.players.find(p => p.id === playerId);
  const isPlayerTurn = state.currentTurn === playerId;

  // Render hand
  if (currentPlayer && currentPlayer.hand) {
    currentPlayer.hand.forEach(card => {
      const img = document.createElement("img");
      img.src = `assets/cards/${card}`;
      img.className = "card";
      img.addEventListener("click", () => playCard(card));
      handContainer.appendChild(img);
    });
  }

  // Render top discard
  topCardImg.src = `assets/cards/${state.topCard}`;
  if (state.lastWildColor) {
    wildColorDisplay.style.display = "block";
    wildColorDisplay.textContent = `⬛ ${state.lastWildColor.toUpperCase()}`;
  } else {
    wildColorDisplay.style.display = "none";
  }

  // Render opponents with card count and score
  state.players.forEach(p => {
    if (p.id === playerId) return;
    const div = document.createElement("div");
    const isTurn = p.id === state.currentTurn ? "👉 " : "";
    div.textContent = `${isTurn}${p.name} 🃏 ${p.handCount} (${p.score})`;
    opponentsContainer.appendChild(div);
  });

  // Turn timer
  updateTimer(isPlayerTurn);
}

// Turn timer countdown
function updateTimer(active) {
  clearInterval(turnTimer);
  const timerText = document.getElementById("turn-countdown");
  let time = 60;
  timerText.textContent = time;

  if (active) {
    turnTimer = setInterval(() => {
      time--;
      timerText.textContent = time;
      if (time <= 0) {
        clearInterval(turnTimer);
        socket.emit("turnTimeout");
      }
    }, 1000);
  }
}

// Play card
function playCard(card) {
  if (card.includes("wild")) {
    showColorPicker(card);
  } else {
    socket.emit("playCard", { card });
  }
}

// Draw card
document.getElementById("draw-button").addEventListener("click", () => {
  socket.emit("drawCard");
});

// Leave game
document.getElementById("leave-game").addEventListener("click", () => {
  socket.emit("leaveGame");
  localStorage.clear();
  location.reload();
});

// Wild card color picker
function showColorPicker(card) {
  const picker = document.getElementById("wild-color-picker");
  picker.style.display = "block";
  document.getElementById("confirm-color").onclick = () => {
    const selected = document.getElementById("color-select").value;
    selectedColor = selected;
    picker.style.display = "none";
    socket.emit("playCard", { card, wildColor: selectedColor });
  };
}

// Chat
document.getElementById("chat-input").addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    socket.emit("chatMessage", e.target.value);
    e.target.value = "";
  }
});

socket.on("chatMessage", (msg) => {
  const log = document.getElementById("chat-log");
  const entry = document.createElement("div");
  entry.textContent = msg;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
});
