const socket = io();

const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name");
const lobbyInput = document.getElementById("lobby");
const gameDiv = document.getElementById("game");
const handDiv = document.getElementById("player-hand");
const drawPile = document.getElementById("draw-pile");
const discardPile = document.getElementById("discard-pile");
const unoButton = document.getElementById("uno-button");
const colorPicker = document.getElementById("wild-color-picker");
const timerBar = document.getElementById("timer-bar");
const scoreBoard = document.getElementById("scoreboard");
const messageBox = document.getElementById("messages");
const opponentsDiv = document.getElementById("opponents");

let playerId, currentState = {}, saidUNO = false;

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const lobby = lobbyInput.value.trim();
  if (name && lobby) {
    socket.emit("join", { name, lobby });
  }
});

unoButton.addEventListener("click", () => {
  saidUNO = true;
  unoButton.style.display = "none";
});

function renderState(state) {
  currentState = state;
  playerId = socket.id;
  const hand = state.hands[playerId] || [];
  const topCard = state.discardPile.at(-1);

  handDiv.innerHTML = "";
  hand.forEach(card => {
    const img = document.createElement("img");
    img.src = `/assets/cards/${card}.png`;
    img.className = "card";
    img.addEventListener("click", () => tryPlayCard(card));
    handDiv.appendChild(img);
  });

  discardPile.innerHTML = "";
  const topImg = document.createElement("img");
  topImg.src = `/assets/cards/${topCard}.png`;
  topImg.className = "card";
  discardPile.appendChild(topImg);

  drawPile.innerHTML = "";
  const drawImg = document.createElement("img");
  drawImg.src = "/assets/cards/back.png";
  drawImg.className = "card";
  drawImg.addEventListener("click", () => socket.emit("drawCard", { lobby: state.players[0].id }));
  drawPile.appendChild(drawImg);

  // Show UNO button if hand size = 2
  if (hand.length === 2 && state.currentTurn === playerId) {
    unoButton.style.display = "inline-block";
    saidUNO = false;
  } else {
    unoButton.style.display = "none";
  }

  // Render scoreboard
  scoreBoard.innerHTML = "Scores: " + state.players.map(p => `${p.name} (${p.score})`).join(" | ");

  // Opponents
  opponentsDiv.innerHTML = "Players: " + state.players.map(p => {
    const pointer = p.id === state.currentTurn ? "👉" : "";
    return `${pointer} ${p.name} 🃏 ${p.handSize}`;
  }).join(" | ");

  // Timer reset
  timerBar.style.width = "100%";
  animateTimer();

  gameDiv.style.display = "block";
  document.getElementById("lobby-form").style.display = "none";
}

function tryPlayCard(card) {
  const color = card.split("_")[0];
  if (color === "wild") {
    colorPicker.style.display = "block";
    colorPicker.querySelectorAll("button").forEach(btn => {
      btn.onclick = () => {
        colorPicker.style.display = "none";
        socket.emit("playCard", {
          lobby: currentState.players[0].id,
          card,
          chosenColor: btn.dataset.color,
          saidUNO
        });
      };
    });
  } else {
    socket.emit("playCard", {
      lobby: currentState.players[0].id,
      card,
      saidUNO
    });
  }
}

function animateTimer() {
  timerBar.style.transition = "none";
  timerBar.style.width = "100%";
  setTimeout(() => {
    timerBar.style.transition = "width 60s linear";
    timerBar.style.width = "0%";
  }, 50);
}

socket.on("state", (state) => {
  renderState(state);
});

socket.on("message", ({ from, text }) => {
  const msg = document.createElement("div");
  msg.innerHTML = `<strong>${from}:</strong> ${text}`;
  messageBox.appendChild(msg);
});
