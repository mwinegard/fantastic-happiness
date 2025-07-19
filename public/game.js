const socket = io();
let playerName = localStorage.getItem("playerName");
let lobbyId = localStorage.getItem("lobbyId");
let yourId = null;
let turnTimer = null;
let wildColorChoice = null;

document.getElementById("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  playerName = document.getElementById("nameInput").value.trim().substring(0, 20);
  lobbyId = document.getElementById("lobbyInput").value.trim().substring(0, 20);

  if (!playerName || !lobbyId || /[^a-zA-Z0-9_]/.test(playerName + lobbyId)) {
    alert("Only letters, numbers, and underscores allowed.");
    return;
  }

  localStorage.setItem("playerName", playerName);
  localStorage.setItem("lobbyId", lobbyId);

  document.getElementById("landing").style.display = "none";
  document.getElementById("game").style.display = "flex";

  socket.emit("joinLobby", { playerName, lobbyId });
});

socket.on("gameState", (data) => {
  yourId = socket.id;
  const isYourTurn = data.currentTurn === yourId;

  document.getElementById("turnBar").textContent = isYourTurn ? "Your Turn" : "";
  renderPlayers(data.players, data.currentTurn);
  renderTopCard(data.topCard, data.lastWildColor);
  renderHand(data.yourHand);

  if (isYourTurn) startTurnTimer();
  else clearInterval(turnTimer);
});

function renderPlayers(players, currentTurn) {
  const el = document.getElementById("opponents");
  el.innerHTML = "";
  players.forEach(p => {
    const div = document.createElement("div");
    div.className = "playerRow";
    if (p.id === currentTurn) div.innerHTML += "👉 ";
    div.innerHTML += `<span>${p.name}</span> 🃏${p.handCount} (${p.score})`;
    el.appendChild(div);
  });
}

function renderTopCard(card, wildColor) {
  const el = document.getElementById("discard");
  el.innerHTML = `<img src="assets/cards/${card}" class="top-card">`;
  if (wildColor) {
    const dot = document.createElement("div");
    dot.className = "wild-indicator";
    dot.style.background = wildColor;
    el.appendChild(dot);
  }
}

function renderHand(hand) {
  const el = document.getElementById("hand");
  el.innerHTML = "";
  hand.forEach(card => {
    const img = document.createElement("img");
    img.src = `assets/cards/${card}`;
    img.className = "hand-card";
    img.onclick = () => {
      if (card.startsWith("wild")) showWildColorPrompt(card);
      else playCard(card);
    };
    el.appendChild(img);
  });
}

function showWildColorPrompt(card) {
  const color = prompt("Pick a color: red, blue, green, yellow").toLowerCase();
  if (["red", "blue", "green", "yellow"].includes(color)) {
    wildColorChoice = color;
    playCard(card);
  } else {
    alert("Invalid color.");
  }
}

function playCard(card) {
  socket.emit("playCard", { card, wildColor: wildColorChoice });
  wildColorChoice = null;
}

document.getElementById("drawCard").addEventListener("click", () => {
  socket.emit("drawCard");
});

document.getElementById("leave").addEventListener("click", () => {
  socket.emit("leaveGame");
  location.reload();
});

document.getElementById("chatForm").addEventListener("submit", e => {
  e.preventDefault();
  const input = document.getElementById("chatInput");
  const msg = input.value.trim();
  if (msg) socket.emit("chatMessage", msg);
  input.value = "";
});

socket.on("chatMessage", ({ from, text, color }) => {
  const el = document.getElementById("chatLog");
  const msg = document.createElement("div");
  msg.innerHTML = `<strong style="color:${from === 'SUE' ? 'navy' : 'black'}">${from}</strong>: ${text}`;
  msg.style.color = "black";
  el.appendChild(msg);
  el.scrollTop = el.scrollHeight;
});

function startTurnTimer() {
  let seconds = 60;
  clearInterval(turnTimer);
  document.getElementById("turnBar").textContent = `Your Turn - 60s`;

  turnTimer = setInterval(() => {
    seconds--;
    document.getElementById("turnBar").textContent = `Your Turn - ${seconds}s`;
    if (seconds <= 0) {
      clearInterval(turnTimer);
      socket.emit("turnTimeout");
    }
  }, 1000);
}
