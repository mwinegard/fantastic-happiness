const socket = io();

let playerName = "";
let lobbyId = "";

document.getElementById("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("player-name").value.trim().slice(0, 20);
  const lobby = document.getElementById("lobby-id").value.trim().slice(0, 20);

  if (!name || !lobby) return;

  playerName = name;
  lobbyId = lobby;

  socket.emit("joinLobby", { name, lobby });

  document.getElementById("join-screen").classList.add("hidden");
  document.getElementById("game-screen").classList.remove("hidden");
  document.getElementById("lobby-name").textContent = lobby;
});

socket.on("lobbyFull", () => {
  alert("Lobby is full. Please try another lobby.");
  location.reload();
});

socket.on("chat", ({ sender, message }) => {
  const box = document.getElementById("chat-box");
  const p = document.createElement("p");
  const nameColor = sender === "SUE" ? "navy" : "black";
  const boldName = sender === "SUE" ? "SUE" : sender;
  p.innerHTML = `<strong style="color:${nameColor};">${boldName}</strong>: ${message}`;
  box.appendChild(p);
  box.scrollTop = box.scrollHeight;
});

socket.on("updateState", (state) => {
  updateTurn(state);
  updateOpponents(state);
  updateHand(state);
  updateTopCard(state);
  updateDrawStack(state);
});

socket.on("gameOver", ({ winner, points }) => {
  alert(`🎉 ${winner} is the Champion!\nThey scored ${points} points!`);
  location.reload();
});

document.getElementById("leave-btn").addEventListener("click", () => {
  socket.emit("leaveLobby", { name: playerName, lobby: lobbyId });
  location.reload();
});

function updateTurn(state) {
  const turn = state.currentPlayer || "";
  document.getElementById("current-turn").textContent = turn;
}

function updateOpponents(state) {
  const list = document.getElementById("opponents");
  list.innerHTML = "";

  state.players.forEach((player) => {
    const isCurrent = player.name === state.currentPlayer;
    const isSelf = player.name === playerName;
    const div = document.createElement("div");
    div.className = "opponent";

    if (!isSelf) {
      div.innerHTML = `
        <div class="name">${isCurrent ? "👉" : ""} ${player.name}</div>
        <div class="cards">🃏 ${player.cards.length}</div>
        <div class="score">(${player.score || 0})</div>
      `;
      list.appendChild(div);
    }
  });
}

function updateHand(state) {
  const player = state.players.find((p) => p.name === playerName);
  const hand = player?.cards || [];
  const handContainer = document.getElementById("hand");
  handContainer.innerHTML = "";

  hand.forEach((card, index) => {
    const img = document.createElement("img");
    img.src = `assets/cards/${card}.png`;
    img.alt = card;
    img.className = "card";
    img.addEventListener("click", () => {
      if (card.includes("wild")) {
        showColorPicker(index);
      } else {
        playCard(index, null);
      }
    });
    handContainer.appendChild(img);
  });
}

function updateTopCard(state) {
  const pile = document.getElementById("pile-top");
  if (state.topCard) {
    pile.src = `assets/cards/${state.topCard}.png`;
    pile.classList.remove("hidden");
  } else {
    pile.classList.add("hidden");
  }

  // Show color indicator for wild
  const wildColor = state.chosenColor;
  const indicator = document.getElementById("color-indicator");
  if (wildColor) {
    indicator.textContent = "⬤";
    indicator.style.color = wildColor;
    indicator.classList.remove("hidden");
  } else {
    indicator.classList.add("hidden");
  }
}

function updateDrawStack(state) {
  const drawStack = document.getElementById("draw-stack");
  drawStack.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const img = document.createElement("img");
    img.src = "assets/cards/back.png";
    img.className = "card-stack";
    drawStack.appendChild(img);
  }
}

function playCard(index, chosenColor = null) {
  socket.emit("playCard", {
    name: playerName,
    lobby: lobbyId,
    index,
    chosenColor,
  });
}

function showColorPicker(index) {
  const colorPicker = document.createElement("div");
  colorPicker.id = "color-picker";
  ["red", "blue", "green", "yellow"].forEach((color) => {
    const btn = document.createElement("button");
    btn.textContent = "⬤";
    btn.style.color = color;
    btn.addEventListener("click", () => {
      playCard(index, color);
      colorPicker.remove();
    });
    colorPicker.appendChild(btn);
  });
  document.body.appendChild(colorPicker);
}

document.getElementById("chatForm")?.addEventListener("submit", sendChat);
document.getElementById("chat-send")?.addEventListener("click", sendChat);
document.getElementById("chat-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat(e);
});

function sendChat(e) {
  if (e) e.preventDefault();
  const input = document.getElementById("chat-input");
  const msg = input.value.trim();
  if (msg) {
    socket.emit("chat", {
      sender: playerName,
      message: msg,
      lobby: lobbyId,
    });
    input.value = "";
  }
}
