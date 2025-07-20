// public/game.js

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
let currentHand = [];
let currentTurnId = null;

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
  currentTurnId = state.currentTurn;
  currentHand = state.hands[playerId] || [];

  // Turn indicator
  if (currentTurnId) {
    turnIndicator.style.display = "block";
    turnIndicator.innerText =
      currentTurnId === playerId
        ? "It is your turn."
        : `It is ${state.players.find(p => p.id === currentTurnId)?.name}'s turn.`;
  } else {
    turnIndicator.style.display = "none";
  }

  // Player list
  playerList.innerHTML = "";
  state.players.forEach(p => {
    const mark = p.id === playerId ? "👉 " : "";
    const li = document.createElement("li");
    li.innerText = `${mark}${p.name} 🃏 ${p.handSize} (${p.score})`;
    playerList.appendChild(li);
  });

  // Player hand
  handDiv.innerHTML = "";
  currentHand.forEach(card => {
    const img = document.createElement("img");
    img.src = `/assets/cards/${card}.png`;
    img.className = "card";

    const canPlay = canPlayCard(card, state.discardPile[state.discardPile.length - 1]);

    // rainbow logic block
    if (card === "wild_rainbow") {
      const hasAllColors = hasFourColors(currentHand);
      if (!hasAllColors) {
        img.style.opacity = "0.5";
        img.style.pointerEvents = "none";
      }
    }

    img.addEventListener("click", () => {
      if (state.currentTurn !== playerId) return;

      if (card.startsWith("wild") && card !== "wild_rainbow") {
        wildButtons.style.display = "flex";
        wildButtons.querySelectorAll("button").forEach(btn => {
          btn.onclick = () => {
            wildButtons.style.display = "none";
            socket.emit("playCard", {
              lobby: currentLobby,
              card,
              chosenColor: btn.dataset.color
            });
            playSound(card.startsWith("wild_") ? "special" : "wild");
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
  unoButton.style.display = currentHand.length === 2 ? "block" : "none";

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

function canPlayCard(card, topCard) {
  if (!topCard) return true;
  if (card === "wild_rainbow") return hasFourColors(currentHand);
  if (card.startsWith("wild")) return true;
  const topColor = topCard.split("_")[0];
  const cardColor = card.split("_")[0];
  return cardColor === topColor || topCard.startsWith(cardColor);
}

function hasFourColors(hand) {
  const required = ["red", "blue", "green", "yellow"];
  const colorsInHand = new Set(hand.map(c => c.split("_")[0]));
  return required.every(c => colorsInHand.has(c));
}
