// public/game.js

const socket = io();
const audio = new Audio();

function playSound(name) {
  audio.src = `/sounds/${name}.mp3`;
  audio.play().catch(() => {});
}

const gameDiv = document.getElementById("game");
const handDiv = document.getElementById("player-hand");
const drawPile = document.getElementById("draw-pile");
const discardPile = document.getElementById("discard-pile");
const turnIndicator = document.getElementById("turn-indicator");
const unoButton = document.getElementById("uno-btn");
const colorButtons = document.getElementById("color-buttons");

const nameInput = document.getElementById("name");
const lobbyInput = document.getElementById("lobby");
document.getElementById("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const lobby = lobbyInput.value.trim().toLowerCase();
  if (name && lobby) {
    socket.emit("join", { name, lobby });
  }
});

socket.on("state", (state) => {
  gameDiv.style.display = "block";
  const playerId = socket.id;
  const hand = state.hands[playerId] || [];

  // turn
  turnIndicator.style.display = "block";
  turnIndicator.textContent = state.currentTurn === playerId
    ? "It's your turn."
    : `Waiting on ${state.players.find(p => p.id === state.currentTurn)?.name}`;

  // update hand
  handDiv.innerHTML = "";
  hand.forEach(card => {
    const img = document.createElement("img");
    img.src = `/assets/cards/${card}.png`;
    img.className = "card";
    img.onclick = () => {
      if (state.currentTurn !== playerId) return;

      if (card.startsWith("wild")) {
        showColorPicker(card, state);
      } else {
        socket.emit("playCard", { lobby: state.players[0].id, card });
        if (card.includes("draw") || card.includes("skip") || card.includes("reverse")) {
          playSound("special");
        } else {
          playSound("number");
        }
      }
    };
    handDiv.appendChild(img);
  });

  // discard
  discardPile.innerHTML = "";
  const topCard = state.discardPile.at(-1);
  if (topCard) {
    const img = document.createElement("img");
    img.src = `/assets/cards/${topCard}.png`;
    img.className = "card";
    discardPile.appendChild(img);
  }

  // draw
  drawPile.innerHTML = "";
  const drawImg = document.createElement("img");
  drawImg.src = "/assets/cards/back.png";
  drawImg.className = "card";
  drawImg.onclick = () => {
    if (state.currentTurn === playerId) {
      socket.emit("drawCard", { lobby: state.players[0].id });
      playSound("draw");
    }
  };
  drawPile.appendChild(drawImg);
});

function showColorPicker(card, state) {
  colorButtons.innerHTML = "";
  ["red", "blue", "green", "yellow"].forEach(color => {
    const btn = document.createElement("button");
    btn.textContent = color.toUpperCase();
    btn.style.backgroundColor = color;
    btn.onclick = () => {
      socket.emit("playCard", {
        lobby: state.players[0].id,
        card,
        chosenColor: color
      });
      colorButtons.innerHTML = "";
      playSound("wild");
    };
    colorButtons.appendChild(btn);
  });
}
