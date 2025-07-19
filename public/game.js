const socket = io();

const joinForm = document.getElementById("join-form");
const playerNameInput = document.getElementById("player-name");
const lobbyIdInput = document.getElementById("lobby-id");
const handContainer = document.getElementById("hand-container");
const discardPile = document.getElementById("discard-pile");
const drawStack = document.getElementById("draw-stack");
const opponentsContainer = document.getElementById("opponents-container");
const wildColorIndicator = document.getElementById("wild-color-indicator");

let isMyTurn = false;

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = playerNameInput.value.trim();
  const lobbyId = lobbyIdInput.value.trim();
  if (name && lobbyId) {
    socket.emit("joinLobby", { name, lobbyId });
  }
});

drawStack.addEventListener("click", () => {
  if (isMyTurn) {
    socket.emit("drawCard");
  }
});

socket.on("gameState", (state) => {
  document.getElementById("lobby-screen").style.display = "none";
  document.getElementById("game-container").style.display = "block";
  isMyTurn = state.isMyTurn;

  // Render discard
  discardPile.innerHTML = `<img src="assets/cards/${state.table[state.table.length - 1]}" class="card" />`;

  // Show current wild color
  wildColorIndicator.innerHTML = state.lastWildColor
    ? `🎨 ${state.lastWildColor.toUpperCase()}`
    : "";

  // Render hand
  handContainer.innerHTML = "";
  state.hand.forEach((card) => {
    const img = document.createElement("img");
    img.src = `assets/cards/${card}`;
    img.className = "card";
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

  // Render opponents
  opponentsContainer.innerHTML = "";
  state.others.forEach((opponent) => {
    const row = document.createElement("div");
    row.className = "opponent";

    row.innerText = `${state.currentPlayer === opponent.name ? "👉 " : ""}${opponent.name} 🃏 ${opponent.count} (${opponent.score})`;
    opponentsContainer.appendChild(row);
  });
});

socket.on("gameOver", ({ message }) => {
  alert(message);
  location.reload();
});

document.getElementById("leave-button").addEventListener("click", () => {
  socket.emit("leaveGame");
  location.reload();
});
