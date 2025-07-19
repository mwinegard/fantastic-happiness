const socket = io();

let playerName = localStorage.getItem("uno_name");
let lobbyName = localStorage.getItem("uno_lobby");

const nameInput = document.getElementById("name");
const lobbyInput = document.getElementById("lobby");
const joinForm = document.getElementById("join-form");
const gameArea = document.getElementById("game");
const handContainer = document.getElementById("hand");
const pile = document.getElementById("pile");
const drawPile = document.getElementById("draw-pile");
const chatBox = document.getElementById("chat");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const playersList = document.getElementById("players");

function createCardElement(card) {
  const img = document.createElement("img");
  img.src = `assets/cards/${card.color}_${card.value}.png`;
  img.className = "card";
  img.dataset.color = card.color;
  img.dataset.value = card.value;
  img.onclick = () => playCard(card);
  return img;
}

function playCard(card) {
  if (card.color === "wild") {
    const chosenColor = prompt("Choose color: red, blue, green, yellow");
    if (!["red", "blue", "green", "yellow"].includes(chosenColor)) return;
    socket.emit("playCard", { lobby: lobbyName, card, chosenColor });
  } else {
    socket.emit("playCard", { lobby: lobbyName, card });
  }
}

function drawCard() {
  socket.emit("drawCard", { lobby: lobbyName });
}

function renderGame(state) {
  handContainer.innerHTML = "";
  state.hand.forEach(card => handContainer.appendChild(createCardElement(card)));

  pile.src = state.topCard ? `assets/cards/${state.topCard.color}_${state.topCard.value}.png` : "";
  pile.style.display = state.topCard ? "inline" : "none";

  drawPile.onclick = drawCard;

  playersList.innerHTML = "";
  state.players.forEach(player => {
    const row = document.createElement("div");
    row.textContent = `${state.currentTurn === player.id ? "👉 " : ""}${player.name} 🃏 ${player.handSize} (${player.score})`;
    row.style.color = player.color;
    playersList.appendChild(row);
  });
}

function postChatMessage(msg) {
  const msgEl = document.createElement("div");
  msgEl.innerHTML = `<strong style="color: ${msg.system ? '#001f3f' : '#000'}">${msg.sender}</strong>: ${msg.text}`;
  chatBox.appendChild(msgEl);
  chatBox.scrollTop = chatBox.scrollHeight;
}

socket.on("gameState", renderGame);
socket.on("chatMessage", postChatMessage);

socket.on("lobbyJoined", ({ playerName: name }) => {
  gameArea.style.display = "block";
  joinForm.style.display = "none";
});

socket.on("lobbyFull", () => {
  alert("Lobby is full. Try another lobby.");
});

joinForm.onsubmit = e => {
  e.preventDefault();
  playerName = nameInput.value.trim().substring(0, 20);
  lobbyName = lobbyInput.value.trim().substring(0, 20).toLowerCase();
  if (!playerName || !lobbyName) return;

  localStorage.setItem("uno_name", playerName);
  localStorage.setItem("uno_lobby", lobbyName);
  socket.emit("joinLobby", { name: playerName, lobby: lobbyName });
};

chatForm.onsubmit = e => {
  e.preventDefault();
  const msg = chatInput.value.trim();
  if (msg) {
    socket.emit("chat", { lobby: lobbyName, text: msg });
    chatInput.value = "";
  }
};

chatInput.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});
