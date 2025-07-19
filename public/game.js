const socket = io();

let isMyTurn = false;
let myName = "";
let lobbyId = "";
let turnTimer;
let chosenWildColor = null;

document.getElementById("joinBtn").onclick = () => {
  myName = document.getElementById("nameInput").value.trim();
  lobbyId = document.getElementById("lobbyInput").value.trim();
  if (!myName || !lobbyId) return alert("Name and Lobby required");
  localStorage.setItem("name", myName);
  localStorage.setItem("lobby", lobbyId);
  socket.emit("joinLobby", { name: myName, lobbyId });
};

document.getElementById("send-chat").onclick = () => {
  const msg = document.getElementById("chat-input").value.trim();
  if (msg) {
    const div = document.createElement("div");
    div.textContent = `${myName}: ${msg}`;
    document.getElementById("chat-messages").appendChild(div);
    document.getElementById("chat-input").value = "";
  }
};

document.getElementById("leaveBtn").onclick = () => {
  socket.emit("leaveGame");
  window.location.reload();
};

document.getElementById("draw-pile").onclick = () => {
  if (isMyTurn) {
    socket.emit("drawCard");
    clearInterval(turnTimer);
  }
};

socket.on("gameOver", ({ message }) => {
  alert(message);
  window.location.reload();
});

socket.on("gameState", ({ hand, table, others, isMyTurn: turn, currentPlayer, lastWildColor }) => {
  isMyTurn = turn;
  updateTable(table, lastWildColor);
  updateHand(hand);
  updateOpponents(others, currentPlayer);
  resetTimer();
});

function updateTable(table, wildColor) {
  const top = table[table.length - 1];
  document.getElementById("discard").src = `assets/cards/${top}`;
  const wc = document.getElementById("wild-color");
  wc.innerHTML = "";
  if (wildColor) {
    const dot = document.createElement("span");
    dot.textContent = wildColor.toUpperCase();
    dot.style.background = wildColor;
    dot.style.color = "#fff";
    dot.style.padding = "5px 10px";
    dot.style.marginLeft = "10px";
    dot.style.borderRadius = "5px";
    wc.append("Color:", dot);
  }
}

function updateHand(hand) {
  const container = document.getElementById("hand-container");
  container.innerHTML = "";
  hand.forEach(card => {
    const img = document.createElement("img");
    img.src = `assets/cards/${card}`;
    img.className = "card";
    img.onclick = () => {
      if (!isMyTurn) return;

      if (card.includes("wild")) {
        const color = prompt("Choose color: red, blue, green, yellow");
        if (!["red", "blue", "green", "yellow"].includes(color)) {
          alert("Invalid color");
          return;
        }
        chosenWildColor = color;
        socket.emit("playCard", { card, chosenColor: color });
      } else {
        socket.emit("playCard", { card });
      }

      clearInterval(turnTimer);
    };
    container.appendChild(img);
  });
}

function updateOpponents(others, currentPlayer) {
  const list = document.getElementById("opponents");
  list.innerHTML = "";
  others.forEach(p => {
    const div = document.createElement("div");
    div.className = "opponent";

    const isTurn = p.name === currentPlayer;
    const emoji = isTurn ? "👉" : "🧍";
    const line = `${emoji} ${p.name} 🃏 ${p.count} (${p.score})`;

    div.textContent = line;
    list.appendChild(div);
  });
}

function resetTimer() {
  clearInterval(turnTimer);
  if (isMyTurn) {
    let seconds = 60;
    turnTimer = setInterval(() => {
      if (seconds <= 0) {
        clearInterval(turnTimer);
        socket.emit("drawCard");
        return;
      }
      document.title = `⏱️ ${seconds--}s - Your Turn`;
    }, 1000);
  } else {
    document.title = "Fantastic UNO";
  }
}

// Auto-fill previous name/lobby if available
window.onload = () => {
  const savedName = localStorage.getItem("name");
  const savedLobby = localStorage.getItem("lobby");
  if (savedName) document.getElementById("nameInput").value = savedName;
  if (savedLobby) document.getElementById("lobbyInput").value = savedLobby;
};
