let hand = [];
let table = [];
let others = [];
let isMyTurn = false;
let socket;

if (!sessionStorage.getItem("lobbyId") || !sessionStorage.getItem("playerName")) {
  document.getElementById("join-modal").style.display = "flex";
  document.getElementById("join-form").addEventListener("submit", function(e) {
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
    render(state);
  });

  function render(state) {
    document.getElementById("turn-info").innerText = `Current Turn: ${state.currentPlayer}`;

    const tableEl = document.getElementById("table-pile");
    const handEl = document.getElementById("player-hand");
    const othersEl = document.getElementById("opponent-hands");
    const scoresEl = document.getElementById("scoreboard");

    tableEl.innerHTML = "";
    if (table.length > 0) {
      const card = table[table.length - 1];
      const img = document.createElement("img");
      img.src = `assets/cards/${card}`;
      img.style.height = "120px";
      tableEl.appendChild(img);
    }

    handEl.innerHTML = "";
    hand.forEach(card => {
      const img = document.createElement("img");
      img.src = `assets/cards/${card}`;
      img.style.height = "100px";
      img.style.margin = "4px";
      img.style.cursor = isMyTurn ? "pointer" : "not-allowed";
      img.onclick = () => {
        if (isMyTurn) {
          let chosenColor = null;
          if (card.startsWith("wild")) {
            chosenColor = prompt("Choose a color: red, yellow, green, blue");
          }
          socket.emit("playCard", { card, chosenColor });
        }
      };
      handEl.appendChild(img);
    });

    othersEl.innerHTML = "";
    others.forEach(op => {
      const div = document.createElement("div");
      div.innerHTML = `<strong>${op.name}</strong><br/>`;
      for (let i = 0; i < op.count; i++) {
        const img = document.createElement("img");
        img.src = "assets/cards/back.png";
        img.style.height = "60px";
        img.style.margin = "2px";
        div.appendChild(img);
      }
      othersEl.appendChild(div);
    });

    scoresEl.innerHTML = "<h4>Scores</h4>";
    for (const [pid, score] of Object.entries(state.scores)) {
      const player = [state.currentPlayer, ...others.map(p => p.name)].find(n => n === pid) || "You";
      scoresEl.innerHTML += `<div>${player}: ${score}</div>`;
    }
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
