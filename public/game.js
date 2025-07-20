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
const leaveBtn = document.getElementById("leave-btn");
const lobbyNameDiv = document.getElementById("lobby-name");

// Sound effects
const sounds = {
  draw: new Audio("/sounds/draw.mp3"),
  skip: new Audio("/sounds/skip.mp3"),
  reverse: new Audio("/sounds/reverse.mp3"),
  wild: new Audio("/sounds/wild.mp3"),
  number: new Audio("/sounds/number.mp3"),
  win: new Audio("/sounds/win.mp3"),
  lose: new Audio("/sounds/lose.mp3"),
  start: new Audio("/sounds/start.mp3"),
  joined: new Audio("/sounds/joined.mp3"),
  uno: new Audio("/sounds/uno.mp3")
};

function playSound(type) {
  if (sounds[type]) {
    try { sounds[type].play(); } catch (e) {}
  }
}

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const lobby = lobbyInput.value.trim().toLowerCase();
  if (name && lobby) {
    socket.emit("join", { name, lobby });
    lobbyNameDiv.innerText = `Lobby: ${lobby}`;
  }
});

chatSend.addEventListener("click", sendMessage);
chatBox.addEventListener("keypress", (e) => {
  if (e.key === "Enter") sendMessage();
});

leaveBtn.addEventListener("click", () => {
  location.reload(); // Basic reset
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
  gameDiv.style.display = "flex";
  turnIndicator.style.display = "block";

  const playerId = socket.id;
  const hand = state.hands[playerId] || [];

  turnIndicator.innerText = state.currentTurn === playerId
    ? "It is your turn."
    : `It is ${state.players.find(p => p.id === state.currentTurn)?.name}'s turn.`;

  // Player list
  playerList.innerHTML = "";
  state.players.forEach(p => {
    const mark = p.id === socket.id ? "👉 " : "";
    const li = document.createElement("li");
    li.innerText = `${mark}${p.name} 🃏 ${p.handSize} (${p.score})`;
    playerList.appendChild(li);
  });

  // Hand
  handDiv.innerHTML = "";
  hand.forEach(card => {
    const img = document.createElement("img");
    img.src = `/assets/cards/${card}.png`;
    img.className = "card";
    img.addEventListener("click", () => {
      if (state.currentTurn !== playerId) return;

      if (card.startsWith("wild")) {
        const color = prompt("Choose a color (red, green, blue, yellow):");
        if (!["red", "blue", "green", "yellow"].includes(color)) return;
        socket.emit("playCard", { lobby: state.players[0].id, card, chosenColor: color });
        playSound("wild");
      } else {
        socket.emit("playCard", { lobby: state.players[0].id, card });
        if (card.includes("skip")) playSound("skip");
        else if (card.includes("reverse")) playSound("reverse");
        else if (card.includes("draw")) playSound("draw");
        else playSound("number");
      }
    });
    handDiv.appendChild(img);
  });

  // UNO button
  unoButton.style.display = hand.length === 2 ? "block" : "none";

  // Discard pile
  discardPile.innerHTML = "";
  const topCard = state.discardPile[state.discardPile.length - 1];
  if (topCard) {
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
      socket.emit("drawCard", { lobby: state.players[0].id });
      playSound("draw");
    }
  });
  drawPile.appendChild(drawImg);
});
