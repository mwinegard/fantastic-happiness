const socket = io();

const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name");
const lobbyInput = document.getElementById("lobby");
const gameDiv = document.getElementById("game");
const handDiv = document.getElementById("player-hand");
const drawPile = document.getElementById("draw-pile");
const discardPile = document.getElementById("discard-pile");
const unoButton = document.getElementById("uno-btn");
const wildButtons = document.getElementById("wild-buttons");
const chatBox = document.getElementById("chat-box");
const chatSend = document.getElementById("chat-send");
const chatLog = document.getElementById("chat-log");
const playerList = document.getElementById("player-list");
const turnIndicator = document.getElementById("turn-indicator");
const leaveBtn = document.getElementById("leave-btn");

let currentLobby = "";

const sounds = {
  draw: new Audio("/assets/sounds/draw.mp3"),
  skip: new Audio("/assets/sounds/skip.mp3"),
  reverse: new Audio("/assets/sounds/reverse.mp3"),
  wild: new Audio("/assets/sounds/wild.mp3"),
  number: new Audio("/assets/sounds/number.mp3"),
  win: new Audio("/assets/sounds/win.mp3"),
  lose: new Audio("/assets/sounds/lose.mp3"),
  start: new Audio("/assets/sounds/start.mp3"),
  joined: new Audio("/assets/sounds/joined.mp3"),
  uno: new Audio("/assets/sounds/uno.mp3"),
  special: new Audio("/assets/sounds/special.mp3")
};

function playSound(name) {
  const sound = sounds[name];
  if (sound) sound.play().catch(() => {});
}

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const lobby = lobbyInput.value.trim().toLowerCase();
  if (name && lobby) {
    currentLobby = lobby;
    socket.emit("join", { name, lobby });
  }
});

chatSend.addEventListener("click", sendMessage);
chatBox.addEventListener("keypress", (e) => {
  if (e.key === "Enter") sendMessage();
});

function sendMessage() {
  const msg = chatBox.value.trim();
  if (msg) {
    socket.emit("chat", { message: msg });
    chatBox.value = "";
  }
}

leaveBtn.addEventListener("click", () => {
  location.reload();
});

socket.on("chat", ({ from, message }) => {
  const entry = document.createElement("div");
  entry.innerHTML = `<strong>${from}:</strong> ${message}`;
  chatLog.appendChild(entry);
  chatLog.scrollTop = chatLog.scrollHeight;
});

socket.on("state", (state) => {
  document.getElementById("lobby-form").style.display = "none";
  gameDiv.style.display = "flex";
  document.getElementById("lobby-name-display").innerText = currentLobby;

  const playerId = socket.id;
  const hand = state.hands[playerId] || [];

  // Turn indicator
  if (state.currentTurn) {
    turnIndicator.style.display = "block";
    turnIndicator.innerText = state.currentTurn === playerId
      ? "It is your turn."
      : `It is ${state.players.find(p => p.id === state.currentTurn)?.name}'s turn.`;
  } else {
    turnIndicator.style.display = "none";
  }

  // Player list
  playerList.innerHTML = "";
  state.players.forEach(p => {
    const mark = p.id === socket.id ? "👉 " : "";
    const li = document.createElement("li");
    li.innerText = `${mark}${p.name} 🃏 ${p.handSize} (${p.score})`;
    playerList.appendChild(li);
  });

  // Player hand
  handDiv.innerHTML = "";
  hand.forEach(card => {
    const img = document.createElement("img");
    img.src = `/assets/cards/${card}.png`;
    img.className = "card";
    img.addEventListener("click", () => {
      if (state.currentTurn !== playerId) return;

      if (card.startsWith("wild")) {
        wildButtons.style.display = "flex";
        wildButtons.querySelectorAll("button").forEach(btn => {
          btn.onclick = () => {
            wildButtons.style.display = "none";
            socket.emit("playCard", {
              lobby: currentLobby,
              card,
              chosenColor: btn.dataset.color
            });
            playSound("wild");
          };
        });
      } else {
        socket.emit("playCard", { lobby: currentLobby, card });
        if (card.includes("draw")) playSound("draw");
        else if (card.includes("skip")) playSound("skip");
        else if (card.includes("reverse")) playSound("reverse");
        else if (card.startsWith("wild_")) playSound("special");
        else playSound("number");
      }
    });
    handDiv.appendChild(img);
  });

  // UNO button
  unoButton.style.display = hand.length === 2 ? "block" : "none";

  // Discard pile
  discardPile.innerHTML = "";
  if (state.discardPile?.length) {
    const topCard = state.discardPile[state.discardPile.length - 1];
    const topImg = document.createElement("img");
    topImg.src = `/assets/cards/${topCard}.png`;
    topImg.className = "card";
    discardPile.appendChild(topImg);
  }

  // Draw pile
  drawPile.innerHTML = "";
  const drawImg = document.createElement("img");
  drawImg.src = "/assets/cards/back.png";
  drawImg.className = "card stack";
  drawImg.addEventListener("click", () => {
    if (state.currentTurn === playerId) {
      socket.emit("drawCard", { lobby: currentLobby });
      playSound("draw");
    }
  });
  drawPile.appendChild(drawImg);
});

// Leaderboard modal logic
const leaderboardModal = document.getElementById("leaderboard-modal");
const leaderboardToggle = document.getElementById("leaderboard-toggle");
const leaderboardClose = document.getElementById("leaderboard-close");
const leaderboardContainer = document.getElementById("leaderboard-container");

let leaderboardData = [];
let currentSort = { column: null, asc: true };

leaderboardToggle.onclick = () => {
  leaderboardModal.style.display = "flex";
  loadLeaderboard();
};

leaderboardClose.onclick = () => {
  leaderboardModal.style.display = "none";
};

window.onclick = (e) => {
  if (e.target === leaderboardModal) {
    leaderboardModal.style.display = "none";
  }
};

function loadLeaderboard() {
  fetch('/scores')
    .then(res => res.json())
    .then(data => {
      leaderboardData = data;
      renderLeaderboard();
    });
}

function renderLeaderboard() {
  if (!leaderboardData.length) {
    leaderboardContainer.innerHTML = "<p>No scores yet.</p>";
    return;
  }

  const headers = [
    { key: "name", label: "Name" },
    { key: "wins", label: "Wins" },
    { key: "score", label: "Score" }
  ];

  const headerRow = headers.map(h => {
    let cls = "";
    if (currentSort.column === h.key) {
      cls = currentSort.asc ? "sorted-asc" : "sorted-desc";
    }
    return `<th class="${cls}" onclick="sortByLeaderboard('${h.key}')">${h.label}</th>`;
  }).join("");

  const rows = leaderboardData.map(score => `
    <tr>
      <td>${score.name}</td>
      <td>${score.wins || 0}</td>
      <td>${score.score || 0}</td>
    </tr>
  `).join("");

  leaderboardContainer.innerHTML = `
    <table>
      <thead><tr>${headerRow}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

window.sortByLeaderboard = function (column) {
  if (currentSort.column === column) {
    currentSort.asc = !currentSort.asc;
  } else {
    currentSort.column = column;
    currentSort.asc = true;
  }

  leaderboardData.sort((a, b) => {
    const valA = a[column] || 0;
    const valB = b[column] || 0;
    return currentSort.asc ? valA - valB : valB - valA;
  });

  renderLeaderboard();
};
