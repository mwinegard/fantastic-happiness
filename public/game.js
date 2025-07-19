const socket = io();

const lobbyForm = document.getElementById("lobby-form");
const gameContainer = document.getElementById("game");
const chatBox = document.getElementById("chat-box");
const chatInput = document.getElementById("chat-input");
const chatForm = document.getElementById("chat-form");
const playerHand = document.getElementById("player-hand");
const playerList = document.getElementById("player-list");
const drawPile = document.getElementById("draw-pile");
const discardPile = document.getElementById("discard-pile");

let playerId = null;

lobbyForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("name").value.trim();
  const lobby = document.getElementById("lobby").value.trim();
  if (!name || !lobby) return;
  socket.emit("join", { playerName: name, lobbyId: lobby });
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const msg = chatInput.value.trim();
  if (msg) {
    socket.emit("chat", msg);
    chatInput.value = "";
  }
});

socket.on("connect", () => {
  playerId = socket.id;
});

socket.on("state", (state) => {
  lobbyForm.style.display = "none";
  gameContainer.style.display = "block";

  renderGame(state);
});

socket.on("chat", ({ sender, message }) => {
  const div = document.createElement("div");
  div.textContent = `${sender}: ${message}`;
  div.classList.add("chat-message");
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
});

function renderGame(state) {
  playerList.innerHTML = "";
  state.players.forEach((p) => {
    const li = document.createElement("li");
    const turnEmoji = p.id === state.currentTurnId ? "👉 " : "";
    li.textContent = `${turnEmoji}${p.name} 🃏 ${p.hand} (${p.score})`;
    playerList.appendChild(li);
  });

  discardPile.innerHTML = "";
  if (state.topCard) {
    const img = document.createElement("img");
    img.src = `assets/cards/${state.topCard}.png`;
    img.classList.add("card", "stack");
    discardPile.appendChild(img);
  }

  drawPile.innerHTML = "";
  const backImg = document.createElement("img");
  backImg.src = "assets/cards/back.png";
  backImg.classList.add("card", "stack");
  drawPile.appendChild(backImg);
}
