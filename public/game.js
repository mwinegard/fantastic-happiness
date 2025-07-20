const socket = io();

const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name");
const lobbyInput = document.getElementById("lobby");
const gameDiv = document.getElementById("game");
const handDiv = document.getElementById("player-hand");
const drawPile = document.getElementById("draw-pile");
const discardPile = document.getElementById("discard-pile");
const unoButton = document.getElementById("uno-btn");
const chatBox = document.getElementById("chat-box");
const chatSend = document.getElementById("chat-send");
const chatLog = document.getElementById("chat-log");
const playerList = document.getElementById("player-list");
const turnIndicator = document.getElementById("turn-indicator");
const wildColorButtons = document.getElementById("wild-color-buttons");

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const lobby = lobbyInput.value.trim().toLowerCase();
  if (name && lobby) {
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
    socket.emit("chat", msg);
    chatBox.value = "";
  }
}

socket.on("chat", ({ from, message }) => {
  const entry = document.createElement("div");
  entry.innerHTML = `<strong>${from}:</strong> ${message}`;
  chatLog.appendChild(entry);
  chatLog.scrollTop = chatLog.scrollHeight;
});

socket.on("state", (state) => {
  document.getElementById("lobby-form").style.display = "none";
  gameDiv.style.display = "block";

  const playerId = socket.id;
  const hand = state.hands[playerId] || [];

  turnIndicator.style.display = "block";
  turnIndicator.innerText = state.currentTurn === playerId
    ? "It is your turn."
    : `It is ${state.players.find(p => p.id === state.currentTurn)?.name}'s turn.`;

  playerList.innerHTML = "";
  state.players.forEach(p => {
    const mark = p.id === socket.id ? "👉 " : "";
    const li = document.createElement("li");
    li.innerText = `${mark}${p.name} 🃏 ${p.handSize} (${p.score})`;
    playerList.appendChild(li);
  });

  handDiv.innerHTML = "";
  hand.forEach(card => {
    const img = document.createElement("img");
    img.src = `/assets/cards/${card}.png`;
    img.className = "card";
    img.addEventListener("click", () => {
      if (state.currentTurn !== playerId) return;

      if (card.startsWith("wild")) {
        wildColorButtons.style.display = "flex";
        wildColorButtons.onclick = null;

        wildColorButtons.querySelectorAll("button").forEach(btn => {
          btn.onclick = () => {
            const color = btn.dataset.color;
            wildColorButtons.style.display = "none";
            socket.emit("playCard", { lobby: state.players[0].id, card, chosenColor: color });
          };
        });
      } else {
        socket.emit("playCard", { lobby: state.players[0].id, card });
      }
    });
    handDiv.appendChild(img);
  });

  if (hand.length === 2) {
    unoButton.style.display = "block";
  } else {
    unoButton.style.display = "none";
  }

  discardPile.innerHTML = "";
  const topCard = state.discardPile[state.discardPile.length - 1];
  const topImg = document.createElement("img");
  topImg.src = `/assets/cards/${topCard}.png`;
  topImg.className = "card";
  discardPile.appendChild(topImg);

  drawPile.innerHTML = "";
  const drawImg = document.createElement("img");
  drawImg.src = "/assets/cards/back.png";
  drawImg.className = "card stack";
  drawImg.addEventListener("click", () => {
    if (state.currentTurn === playerId) {
      socket.emit("drawCard", { lobby: state.players[0].id });
    }
  });
  drawPile.appendChild(drawImg);
});

// Audio handlers
socket.on("playSound", (sound) => {
  const audio = new Audio(`/assets/sfx/${sound}.mp3`);
  audio.play().catch(() => {});
});
