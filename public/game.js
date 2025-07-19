const socket = io();

const joinForm = document.getElementById("join-form");
const playerNameInput = document.getElementById("player-name");
const lobbyIdInput = document.getElementById("lobby-id");
const handContainer = document.getElementById("hand-container");
const discardPile = document.getElementById("discard-pile");
const drawStack = document.getElementById("draw-stack");
const opponentsContainer = document.getElementById("opponents-container");
const wildColorIndicator = document.getElementById("wild-color-indicator");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatMessages = document.getElementById("chat-messages");

let isMyTurn = false;

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = playerNameInput.value.trim();
  const lobbyId = lobbyIdInput.value.trim();
  if (name && lobbyId) {
    socket.emit("joinLobby", { name, lobbyId });
  }
});

socket.on("gameState", (state) => {
  if (!state || !state.hand || !state.table || !state.table.length) {
    console.error("Incomplete game state");
    return;
  }

  document.getElementById("lobby-screen").style.display = "none";
  document.getElementById("game-container").style.display = "block";
  isMyTurn = state.isMyTurn;

  // Discard pile
  discardPile.innerHTML = "";
  const topCard = document.createElement("img");
  topCard.src = `assets/cards/${state.table[state.table.length - 1]}`;
  topCard.className = "card";
  topCard.onerror = () => topCard.src = "assets/cards/back.png";
  discardPile.appendChild(topCard);

  // Wild color display
  wildColorIndicator.innerHTML = state.lastWildColor
    ? `🎨 ${state.lastWildColor.toUpperCase()}`
    : "";

  // Player hand
  handContainer.innerHTML = "";
  state.hand.forEach((card) => {
    const img = document.createElement("img");
    img.src = `assets/cards/${card}`;
    img.className = "card";
    img.onerror = () => (img.src = "assets/cards/back.png");
    img.onclick = () => {
      if (!isMyTurn) return;
      if (card.startsWith("wild")) {
        const chosenColor = prompt("Choose a color: red, green, blue, yellow");
        if (["red", "green", "blue", "yellow"].includes(chosenColor)) {
          socket.emit("playCard", { card, chosenColor });
        }
      } else {
        socket.emit("playCard", { card });
      }
    };
    handContainer.appendChild(img);
  });

  // Opponents
  opponentsContainer.innerHTML = "";
  state.others.forEach((opponent) => {
    const row = document.createElement("div");
    row.className = "opponent";
    const turnIcon = state.currentPlayer === opponent.name ? "👉 " : "";
    row.innerText = `${turnIcon}${opponent.name} 🃏 ${opponent.count} (${opponent.score})`;
    opponentsContainer.appendChild(row);
  });
});

drawStack.addEventListener("click", () => {
  if (isMyTurn) socket.emit("drawCard");
});

document.getElementById("leave-button").addEventListener("click", () => {
  socket.emit("leaveGame");
  location.reload();
});

// Chat
chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const msg = chatInput.value.trim();
  if (msg) {
    socket.emit("chat", msg);
    chatInput.value = "";
  }
});

socket.on("chat", ({ name, message }) => {
  const entry = document.createElement("div");
  entry.textContent = `${name}: ${message}`;
  chatMessages.appendChild(entry);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});
