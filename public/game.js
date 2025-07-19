const socket = io();

let playerName = "";

socket.on("assignedName", (name) => {
  playerName = name;
  document.getElementById("player-name-display").textContent = name;
  document.getElementById("join-screen").classList.add("hidden");
  document.getElementById("game-screen").classList.remove("hidden");
});

socket.on("lobbyFull", () => {
  alert("Lobby is full. Please try again later.");
});

socket.on("chat", ({ sender, message }) => {
  const chatBox = document.getElementById("chat-box");
  const p = document.createElement("p");
  p.innerHTML = `<strong>${sender}:</strong> ${message}`;
  chatBox.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
});

socket.on("updateState", (state) => {
  const turn = state.currentPlayer;
  document.getElementById("current-turn").textContent = turn;

  const hand = state.players.find(p => p.name === playerName)?.cards || [];
  const handContainer = document.getElementById("hand");
  handContainer.innerHTML = "";
  hand.forEach((card, index) => {
    const img = document.createElement("img");
    img.src = `assets/cards/${card}.png`;
    img.alt = card;
    img.addEventListener("click", () => socket.emit("playCard", { index }));
    handContainer.appendChild(img);
  });

  const pile = document.getElementById("pile-top");
  if (state.topCard) {
    pile.src = `assets/cards/${state.topCard}.png`;
    pile.classList.remove("hidden");
  }
});

document.getElementById("draw-stack").addEventListener("click", () => {
  socket.emit("drawCard");
});

document.getElementById("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("chat-input");
  const msg = input.value.trim();
  if (msg) {
    socket.emit("chat", { sender: playerName, message: msg });
    input.value = "";
  }
});
