const socket = io();

const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name");
const lobbyInput = document.getElementById("lobby");
const gameDiv = document.getElementById("game");
const handDiv = document.getElementById("player-hand");
const drawPile = document.getElementById("draw-pile");
const discardPile = document.getElementById("discard-pile");
const wildColorIndicator = document.getElementById("wild-color-indicator");
const unoButton = document.getElementById("uno-button");
const scoreboard = document.getElementById("scoreboard");
const timerBar = document.getElementById("timer-bar");
const wildSelector = document.getElementById("wild-selector");

let currentPlayerId = null;
let currentLobby = null;
let currentHand = [];
let saidUNO = false;
let wildChosen = null;

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const lobby = lobbyInput.value.trim();
  if (name && lobby) {
    currentLobby = lobby;
    socket.emit("join", { name, lobby });
  }
});

unoButton.addEventListener("click", () => {
  saidUNO = true;
  unoButton.style.display = "none";
});

socket.on("state", (state) => {
  document.getElementById("lobby-form").style.display = "none";
  gameDiv.style.display = "block";

  currentPlayerId = socket.id;
  const hand = state.hands[currentPlayerId] || [];
  currentHand = hand;

  handDiv.innerHTML = "";
  hand.forEach(card => {
    const img = document.createElement("img");
    img.src = `/assets/cards/${card}.png`;
    img.className = "card";
    img.addEventListener("click", () => {
      if (card.startsWith("wild")) {
        wildSelector.style.display = "block";
        wildChosen = null;
        [...wildSelector.querySelectorAll("button")].forEach(btn => {
          btn.onclick = () => {
            wildChosen = btn.dataset.color;
            wildSelector.style.display = "none";
            playCard(card, wildChosen);
          };
        });
      } else {
        playCard(card, null);
      }
    });
    handDiv.appendChild(img);
  });

  discardPile.innerHTML = "";
  const topCard = state.discardPile[state.discardPile.length - 1];
  const topImg = document.createElement("img");
  topImg.src = `/assets/cards/${topCard}.png`;
  topImg.className = "card played";
  discardPile.appendChild(topImg);

  drawPile.innerHTML = "";
  const drawImg = document.createElement("img");
  drawImg.src = "/assets/cards/back.png";
  drawImg.className = "card";
  drawImg.addEventListener("click", () => {
    socket.emit("drawCard", { lobby: currentLobby });
  });
  drawPile.appendChild(drawImg);

  wildColorIndicator.textContent = state.chosenColor
    ? {
        red: "🔴", green: "🟢", blue: "🔵", yellow: "🟡"
      }[state.chosenColor] || "🎨"
    : "🎨";

  updateTurnInfo(state);
  updateScoreboard(state);

  unoButton.style.display = (hand.length === 2) ? "block" : "none";
});

function playCard(card, color) {
  socket.emit("playCard", {
    lobby: currentLobby,
    card: card,
    chosenColor: color,
    saidUNO: saidUNO
  });
  saidUNO = false;
  unoButton.style.display = "none";
}

function updateTurnInfo(state) {
  const turnDiv = document.getElementById("your-turn");
  if (state.currentTurn === currentPlayerId) {
    turnDiv.textContent = "👉 Your turn!";
    startTimerBar(60);
  } else {
    const player = state.players.find(p => p.id === state.currentTurn);
    turnDiv.textContent = `Waiting for ${player?.name || "someone"}...`;
    stopTimerBar();
  }
}

function updateScoreboard(state) {
  scoreboard.innerHTML = "";
  state.players.forEach(p => {
    const div = document.createElement("div");
    div.innerHTML = `${p.id === state.currentTurn ? '👉 ' : ''}${p.name} 🃏 ${p.handSize} (${p.score || 0})`;
    if (p.id === state.currentTurn) div.classList.add("current");
    scoreboard.appendChild(div);
  });
}

let timerInterval = null;

function startTimerBar(seconds) {
  let total = seconds;
  clearInterval(timerInterval);
  let width = 100;
  timerBar.style.width = width + "%";
  timerInterval = setInterval(() => {
    width -= (100 / total);
    if (width <= 0) {
      clearInterval(timerInterval);
      timerBar.style.width = "0%";
    } else {
      timerBar.style.width = width + "%";
    }
  }, 1000);
}

function stopTimerBar() {
  clearInterval(timerInterval);
  timerBar.style.width = "0%";
}
