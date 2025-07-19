const socket = io();

let playerName = "";
let lobbyId = "";

document.getElementById("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("player-name");
  const lobbyInput = document.getElementById("lobby-id");
  const name = nameInput.value.trim();
  const lobby = lobbyInput.value.trim();

  if (!name || !lobby) return;

  playerName = name;
  lobbyId = lobby;

  socket.emit("joinLobby", { name, lobby });

  document.getElementById("join-screen").classList.add("hidden");
  document.getElementById("game-screen").classList.remove("hidden");
  document.getElementById("lobby-name").textContent = lobby;
});

socket.on("lobbyFull", () => {
  alert("Lobby is full. Please try another lobby.");
  location.reload();
});

socket.on("chat", ({ sender, message }) => {
  const box = document.getElementById("chat-box");
  const p = document.createElement("p");
  const displayName = sender === "SUE" ? `<strong style="color:navy;">${sender}</strong>` : `<strong>${sender}</strong>`;
  p.innerHTML = `${displayName}: ${message}`;
  box.appendChild(p);
  box.scrollTop = box.scrollHeight;
});

socket.on("updateState", (state) => {
  updateTurn(state);
  updateOpponents(state);
  updateHand(state);
  updateTopCard(state);
});

document.getElementById("leave-btn").addEventListener("click", () => {
  socket.emit("leaveLobby", { name: playerName, lobby: lobbyId });
  location.reload();
});

function updateTurn(state) {
  const turn = state.currentPlayer || "";
  document.getElementById("current-turn").textContent = turn;
}

function updateOpponents(state) {
  const list = document.getElementById("opponents");
  list.innerHTML = "";

  state.players.forEach((player) => {
    if (player.name === playerName) return;
    const div = document.createElement("div");
    div.className = "opponent";
    div.innerHTML = `
      <div class="name">${player.name}</div>
      <div class="cards">🃏 ${player.cards.length}</div>
      <div class="score">(${player.score || 0})</div>
    `;
    list.appendChild(div);
  });
}

function updateHand(state) {
  const hand = state.players.find((p) => p.name === playerName)?.cards || [];
  const handContainer = document.getElementById("hand");
  handContainer.innerHTML = "";

  hand.forEach((card, index) => {
    const img = document.createElement("img");
    img.src = `assets/cards/${card}.png`;
    img.alt = card;
    img.addEventListener("click", () => playCard(index));
    handContainer.appendChild(img);
  });
}

function updateTopCard(state) {
  const pile = document.getElementById("pile-top");
  if (state.topCard) {
    pile.src = `assets/cards/${state.topCard}.png`;
    pile.classList.remove("hidden");
  }
}

document.getElementById("draw-stack").addEventListener("click", () => {
  socket.emit("drawCard", { name: playerName, lobby: lobbyId });
});

function playCard(index) {
  socket.emit("playCard", { name: playerName, lobby: lobbyId, index });
}

document.getElementById("chatForm")?.addEventListener("submit", sendChat);
document.getElementById("chat-send")?.addEventListener("click", sendChat);
document.getElementById("chat-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat(e);
});

function sendChat(e) {
  if (e) e.preventDefault();
  const input = document.getElementById("chat-input");
  const msg = input.value.trim();
  if (msg) {
    socket.emit("chat", { sender: playerName, message: msg, lobby: lobbyId });
    input.value = "";
  }
}
