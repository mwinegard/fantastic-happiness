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
const wildIndicator = document.getElementById("wild-indicator");
const yourTurnLabel = document.getElementById("your-turn");

let playerId, currentLobby, currentState = {}, saidUNO = false;

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const lobby = lobbyInput.value.trim();
  if (name && lobby) {
    socket.emit("join", { name, lobby });
    currentLobby = lobby;
    playSound("joined");
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
  const wildColor = state.wildColor;

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

  wildIndicator.innerText = wildColor ? `Wild Color: ${wildColor.toUpperCase()}` : "";

  drawPile.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const drawImg = document.createElement("img");
    drawImg.src = "/assets/cards/back.png";
    drawImg.className = "card";
    drawImg.style.marginLeft = `${i * 3}px`;
    drawImg.style.position = "absolute";
    drawImg.style.top = `${i}px`;
    drawImg.style.left = `${i}px`;
    drawPile.appendChild(drawImg);
  }

  drawPile.onclick = () => {
    socket.emit("drawCard", { lobby: currentLobby });
    playSound("draw");
  };

  if (hand.length === 2 && state.currentTurn === playerId) {
    unoButton.style.display = "inline-block";
    saidUNO = false;
  } else {
    unoButton.style.display = "none";
  }

  scoreBoard.innerHTML = "Scores: " + state.players.map(p => `${p.name} (${p.score})`).join(" | ");
  opponentsDiv.innerHTML = "Players: " + state.players.map(p => {
    const pointer = p.id === state.currentTurn ? "👉" : "";
    return `${pointer} ${p.name} 🃏 ${p.handSize}`;
  }).join(" | ");

  yourTurnLabel.style.display = state.currentTurn === playerId ? "block" : "none";

  animateTimer();
  gameDiv.style.display = "block";
  document.getElementById("lobby-form").style.display = "none";
}

function tryPlayCard(card) {
  const type = card.includes("wild") ? "wild" : card.split("_")[1];
  if (type === "wild" || type === "draw4") {
    colorPicker.style.display = "block";
    colorPicker.querySelectorAll("button").forEach(btn => {
      btn.onclick = () => {
        colorPicker.style.display = "none";
        socket.emit("playCard", {
          lobby: currentLobby,
          card,
          chosenColor: btn.dataset.color,
          saidUNO
        });
        playSound("wild");
      };
    });
  } else {
    socket.emit("playCard", {
      lobby: currentLobby,
      card,
      saidUNO
    });

    if (["skip", "reverse", "draw"].some(a => card.includes(a))) {
      playSound(card.includes("reverse") ? "reverse" : "skip");
    } else {
      playSound("number");
    }
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

function playSound(id) {
  const el = document.getElementById("audio-" + id);
  if (el && el.play) {
    el.play().catch(() => {});
  }
}

socket.on("state", (state) => renderState(state));

socket.on("message", ({ from, text }) => {
  const msg = document.createElement("div");
  msg.className = "message";
  msg.innerHTML = `<strong>${from}:</strong> ${text}`;
  messageBox.appendChild(msg);
  messageBox.scrollTop = messageBox.scrollHeight;
});
