const socket = io();
let playerId, lobbyId;
let selectedColor = null;
let wildColor = null;
let hand = [];

document.getElementById("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("nameInput").value.trim();
  const lobby = document.getElementById("lobbyInput").value.trim();
  if (name && lobby) {
    lobbyId = lobby;
    socket.emit("joinLobby", { name, lobby });
  }
});

document.getElementById("sendBtn").addEventListener("click", sendChat);
document.getElementById("chatInput").addEventListener("keypress", (e) => {
  if (e.key === "Enter") sendChat();
});

function sendChat() {
  const input = document.getElementById("chatInput");
  const msg = input.value.trim();
  if (msg) {
    socket.emit("chatMessage", { text: msg });
    input.value = "";
  }
}

socket.on("playerInfo", (data) => {
  playerId = data.id;
});

socket.on("lobbyJoined", () => {
  document.getElementById("joinScreen").style.display = "none";
  document.getElementById("gameScreen").style.display = "block";
});

socket.on("updateGame", (state) => {
  renderGame(state);
});

socket.on("chatMessage", (msg) => {
  const chatBox = document.getElementById("chat");
  const msgDiv = document.createElement("div");
  msgDiv.innerHTML = `<strong style="color:${msg.color || 'black'}">${msg.from}:</strong> ${msg.text}`;
  chatBox.appendChild(msgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
});

function renderGame(state) {
  const gameArea = document.getElementById("gameArea");
  const handDiv = document.getElementById("hand");
  const discard = document.getElementById("discard");
  const opponents = document.getElementById("opponents");
  const turnInfo = document.getElementById("turnInfo");
  const drawStack = document.getElementById("drawStack");

  gameArea.style.display = "block";
  discard.innerHTML = "";
  opponents.innerHTML = "";
  handDiv.innerHTML = "";

  // Top card logic
  const topCard = state.topCard;
  if (topCard) {
    const card = document.createElement("img");
    card.src = `/assets/cards/${topCard.image}`;
    card.className = "card";
    discard.appendChild(card);
  }

  // Wild color indicator
  if (state.wildColor) {
    const dot = document.createElement("div");
    dot.className = "color-dot";
    dot.style.backgroundColor = state.wildColor;
    discard.appendChild(dot);
  }

  // Turn info
  const currentPlayer = state.players.find(p => p.id === state.currentTurn);
  turnInfo.textContent = currentPlayer ? `${currentPlayer.name}'s Turn` : "";

  // Player hand
  const current = state.players.find(p => p.id === playerId);
  if (current && current.hand) {
    current.hand.forEach(card => {
      const img = document.createElement("img");
      img.src = `/assets/cards/${card.image}`;
      img.className = "card";
      img.onclick = () => {
        if (card.value.startsWith("wild")) {
          showColorPicker((color) => {
            selectedColor = color;
            socket.emit("playCard", { card, color });
          });
        } else {
          socket.emit("playCard", { card });
        }
      };
      handDiv.appendChild(img);
    });
  }

  // Opponents and score list
  state.players.forEach(p => {
    if (p.id !== playerId) {
      const div = document.createElement("div");
      const turnEmoji = p.id === state.currentTurn ? "👉" : "";
      div.textContent = `${turnEmoji} ${p.name} 🃏 ${p.hand.length} (${p.score || 0})`;
      opponents.appendChild(div);
    }
  });

  // Draw stack
  drawStack.innerHTML = "";
  const drawCard = document.createElement("img");
  drawCard.src = "/assets/cards/back.png";
  drawCard.className = "card draw";
  drawCard.onclick = () => socket.emit("drawCard");
  drawStack.appendChild(drawCard);
}

function showColorPicker(callback) {
  const picker = document.createElement("div");
  picker.className = "color-picker";

  ["red", "blue", "green", "yellow"].forEach(color => {
    const btn = document.createElement("button");
    btn.style.backgroundColor = color;
    btn.className = "color-btn";
    btn.onclick = () => {
      document.body.removeChild(picker);
      callback(color);
    };
    picker.appendChild(btn);
  });

  document.body.appendChild(picker);
}
