let hand = [];
let table = [];
let others = [];
let isMyTurn = false;
let lastWildColor = null;
let socket;

if (!sessionStorage.getItem("lobbyId") || !sessionStorage.getItem("playerName")) {
  document.getElementById("join-modal").style.display = "flex";
  document.getElementById("join-form").addEventListener("submit", function (e) {
    e.preventDefault();
    const lobby = document.getElementById("lobby-input").value.trim();
    const name = document.getElementById("name-input").value.trim();
    if (lobby && name.match(/^[a-zA-Z0-9 ]{1,20}$/)) {
      sessionStorage.setItem("lobbyId", lobby);
      sessionStorage.setItem("playerName", name);
      location.reload();
    } else {
      alert("Invalid name. Use only letters, numbers, and spaces (max 20 chars).");
    }
  });
} else {
  const lobbyId = sessionStorage.getItem("lobbyId");
  const playerName = sessionStorage.getItem("playerName");
  socket = io();

  socket.emit("joinLobby", { lobbyId, name: playerName });

  socket.on("gameState", state => {
    hand = state.hand;
    table = state.table;
    others = state.others;
    isMyTurn = state.isMyTurn;
    lastWildColor = state.lastWildColor || null;
    render(state);
  });

  function render(state) {
    document.getElementById("turn-info").innerText = `Current Turn: ${state.currentPlayer}`;

    const tableEl = document.getElementById("table-pile");
    const handEl = document.getElementById("player-hand");
    const othersEl = document.getElementById("opponent-hands");
    const colorIndicator = document.getElementById("wild-color-indicator");

    // Update wild color indicator
    if (lastWildColor) {
      const colorMap = { red: "#e74c3c", yellow: "#f1c40f", green: "#2ecc71", blue: "#3498db" };
      colorIndicator.style.backgroundColor = colorMap[lastWildColor] || "transparent";
    } else {
      colorIndicator.style.backgroundColor = "transparent";
    }

    // Table
    tableEl.innerHTML = "";
    if (table.length > 0) {
      const card = table[table.length - 1];
      const img = document.createElement("img");
      img.src = `assets/cards/${card}`;
      img.style.height = "120px";
      tableEl.appendChild(img);
    }

    // Hand
    handEl.innerHTML = "";
    hand.forEach(card => {
      const img = document.createElement("img");
      img.src = `assets/cards/${card}`;
      img.style.height = "100px";
      img.style.margin = "4px";
      img.style.cursor = isMyTurn ? "pointer" : "not-allowed";
      img.onclick = () => {
        if (!isMyTurn) return;

        if (card.startsWith("wild")) {
          const dropdown = document.createElement("select");
          ["red", "yellow", "green", "blue"].forEach(color => {
            const opt = document.createElement("option");
            opt.value = color;
            opt.text = color.charAt(0).toUpperCase() + color.slice(1);
            dropdown.appendChild(opt);
          });

          dropdown.onchange = () => {
            const chosenColor = dropdown.value;
            socket.emit("playCard", { card, chosenColor });
            dropdown.remove();
          };

          img.after(dropdown);
        } else {
          socket.emit("playCard", { card });
        }
      };
      handEl.appendChild(img);
    });

    // Opponents + Scores
    othersEl.innerHTML = "";
    others.forEach(op => {
      const isTurn = op.name === state.currentPlayer;
      const turnEmoji = isTurn ? "👉 " : "";
      const row = document.createElement("div");
      row.classList.add("opponent-row");
      row.innerText = `${turnEmoji}${op.name} 🃏 ${op.count} (${op.score || 0})`;
      othersEl.appendChild(row);
    });
  }

  window.drawCard = () => {
    if (isMyTurn) socket.emit("drawCard");
  };

  window.leaveGame = () => {
    socket.emit("leaveGame");
    sessionStorage.clear();
    window.location.reload();
  };
}
