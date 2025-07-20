// /public/game.js

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
const colorSelector = document.getElementById("color-selector");

// Sounds
const sounds = {
  draw: new Audio("/assets/audio/draw.mp3"),
  skip: new Audio("/assets/audio/skip.mp3"),
  reverse: new Audio("/assets/audio/reverse.mp3"),
  wild: new Audio("/assets/audio/wild.mp3"),
  number: new Audio("/assets/audio/number.mp3"),
  win: new Audio("/assets/audio/win.mp3"),
  lose: new Audio("/assets/audio/lose.mp3"),
  start: new Audio("/assets/audio/start.mp3"),
  joined: new Audio("/assets/audio/joined.mp3"),
  uno: new Audio("/assets/audio/uno.mp3"),
  special: new Audio("/assets/audio/special.mp3")
};

function playSound(name) {
  const audio = sounds[name];
  if (audio) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  }
}

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
    socket.emit("chat", { message: msg });
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

  turnIndicator.innerText =
    state.currentTurn === playerId
      ? "It is your turn."
      : `It is ${state.players.find((p) => p.id === state.currentTurn)?.name}'s turn.`;
  turnIndicator.style.display = "block";

  // Player list
  playerList.innerHTML = "";
  state.players.forEach((p) => {
    const mark = p.id === socket.id ? "👉 " : "";
    const li = document.createElement("li");
    li.innerText = `${mark}${p.name} 🃏 ${p.handSize} (${p.score})`;
    playerList.appendChild(li);
  });

  // Hand display
  handDiv.innerHTML = "";
  hand.forEach((card) => {
    const img = document.createElement("img");
    img.src = `/assets/cards/${card}.png`;
    img.className = "card";
    img.addEventListener("click", () => {
      if (state.currentTurn !== playerId) return;

      if (card.startsWith("wild")) {
        showColorButtons(card, state.players[0].id);
      } else {
        socket.emit("playCard", { lobby: state.players[0].id, card });
        playSound(getSound(card));
      }
    });
    handDiv.appendChild(img);
  });

  // UNO button logic
  unoButton.style.display = hand.length === 2 ? "block" : "none";

  // Discard pile
  discardPile.innerHTML = "";
  if (state.discardPile && state.discardPile.length > 0) {
    const top = state.discardPile[state.discardPile.length - 1];
    const img = document.createElement("img");
    img.src = `/assets/cards/${top}.png`;
    img.className = "card";
    discardPile.appendChild(img);
  }

  // Draw pile
  drawPile.innerHTML = "";
  const back = document.createElement("img");
  back.src = "/assets/cards/back.png";
  back.className = "card stack";
  back.addEventListener("click", () => {
    if (state.currentTurn === playerId) {
      socket.emit("drawCard", { lobby: state.players[0].id });
      playSound("draw");
    }
  });
  drawPile.appendChild(back);
});

function showColorButtons(card, lobbyId) {
  colorSelector.innerHTML = "";
  colorSelector.style.display = "flex";

  ["red", "blue", "green", "yellow"].forEach((color) => {
    const btn = document.createElement("button");
    btn.innerText = color.toUpperCase();
    btn.style.backgroundColor = color;
    btn.style.color = "#fff";
    btn.className = "color-btn";
    btn.onclick = () => {
      socket.emit("playCard", {
        lobby: lobbyId,
        card: card,
        chosenColor: color
      });
      colorSelector.style.display = "none";
      playSound(card.startsWith("wild_") ? "special" : "wild");
    };
    colorSelector.appendChild(btn);
  });
}

function getSound(card) {
  if (card.includes("skip")) return "skip";
  if (card.includes("reverse")) return "reverse";
  if (card.includes("draw")) return "draw";
  if (card.startsWith("wild_")) return "special";
  if (card.startsWith("wild")) return "wild";
  if (/^\w+_\d/.test(card)) return "number";
  return "number";
}
