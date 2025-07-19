const socket = io();
let myName = "";
let currentTurn = "";
let turnTime = 60;
let timerInterval;

document.getElementById("join").onclick = () => {
  const name = document.getElementById("username").value.trim();
  const lobby = document.getElementById("lobby").value.trim();
  if (!name || !lobby) return;

  myName = name;
  socket.emit("joinLobby", { name, lobbyId: lobby });
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("game-screen").classList.remove("hidden");
};

document.getElementById("draw").onclick = () => {
  socket.emit("drawCard");
};

document.getElementById("leave").onclick = () => {
  socket.emit("leaveGame");
};

function startTimer() {
  clearInterval(timerInterval);
  turnTime = 60;
  updateTimer();

  timerInterval = setInterval(() => {
    turnTime--;
    updateTimer();
    if (turnTime <= 0) clearInterval(timerInterval);
  }, 1000);
}

function updateTimer() {
  document.getElementById("timer").innerText = `⏱ ${turnTime}s`;
}

function showVictory(msg) {
  alert(msg); // Or use SweetAlert/modal if preferred
}

socket.on("gameState", state => {
  const { hand, table, others, currentPlayer, isMyTurn, scores, lastWildColor } = state;
  currentTurn = currentPlayer;

  const discard = table[table.length - 1];
  document.getElementById("discard").src = `./${discard}`;

  // Wild color emoji
  const wcDiv = document.getElementById("wild-color");
  wcDiv.innerText = lastWildColor
    ? { red: "🔴", yellow: "🟡", green: "🟢", blue: "🔵" }[lastWildColor] || ""
    : "";

  // My hand
  const handDiv = document.getElementById("hand");
  handDiv.innerHTML = "";
  hand.forEach(card => {
    const img = document.createElement("img");
    img.src = `./${card}`;
    img.onclick = () => {
      const colorSelect = document.getElementById("wild-color-picker");
      const cardColor = card.split("_")[0];
      if (cardColor === "wild") {
        colorSelect.classList.remove("hidden");
        colorSelect.onchange = () => {
          const chosenColor = colorSelect.value;
          colorSelect.classList.add("hidden");
          socket.emit("playCard", { card, chosenColor });
        };
      } else {
        socket.emit("playCard", { card });
      }
    };
    handDiv.appendChild(img);
  });

  // Opponents
  const oppDiv = document.getElementById("opponents");
  oppDiv.innerHTML = others
    .map(p => {
      const turnEmoji = p.name === currentTurn ? "👉" : "";
      return `${turnEmoji} ${p.name} 🃏 ${p.count} (${p.score || 0})`;
    })
    .join("<br>");

  if (isMyTurn) startTimer();
});

socket.on("gameOver", ({ message }) => {
  alert(message || "Game over!");
  clearInterval(timerInterval);
  location.reload();
});
