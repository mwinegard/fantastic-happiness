const socket = io();

document.getElementById("join-btn").addEventListener("click", () => {
  const nameInput = document.getElementById("name-input").value.trim();
  const lobbyInput = document.getElementById("lobby-input").value.trim();

  if (!nameInput || !lobbyInput) {
    alert("Please enter both a name and lobby ID.");
    return;
  }

  localStorage.setItem("playerName", nameInput);
  localStorage.setItem("lobbyId", lobbyInput);

  socket.emit("joinLobby", {
    playerName: nameInput,
    lobbyId: lobbyInput
  });
});

// Receive game state and display game screen
socket.on("gameState", (state) => {
  if (!state || !state.players) return;

  document.getElementById("lobby-screen").style.display = "none";
  document.getElementById("game-container").style.display = "block";

  renderGameState(state);
});

function renderGameState(state) {
  const opponentList = document.getElementById("opponents");
  opponentList.innerHTML = "";

  const currentPlayerId = socket.id;

  state.players.forEach((player) => {
    if (player.id === currentPlayerId) return;

    const playerDiv = document.createElement("div");
    playerDiv.className = "opponent";
    const isTurn = state.currentTurn === player.id ? "👉 " : "";
    playerDiv.textContent = `${isTurn}${player.name} 🃏 ${player.handCount} (${player.score})`;
    opponentList.appendChild(playerDiv);
  });

  const handContainer = document.getElementById("hand");
  handContainer.innerHTML = "";
  if (state.hand) {
    state.hand.forEach((card) => {
      const cardImg = document.createElement("img");
      cardImg.src = `assets/cards/${card}`;
      cardImg.className = "card";
      handContainer.appendChild(cardImg);
    });
  }
}
