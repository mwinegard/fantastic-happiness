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
const muteBtn = document.getElementById("mute-toggle");
const lobbyTitle = document.getElementById("lobby-name-display");
const countdownTimer = document.getElementById("countdown-timer");

let currentLobby = "";
let muted = false;
let countdownInterval = null;

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
  if (muted) return;
  const sound = sounds[name];
  if (sound) sound.play().catch(() => {});
}

if (muteBtn) {
  muteBtn.addEventListener("click", () => {
    muted = !muted;
    muteBtn.textContent = muted ? "🔇 Sound Off" : "🔊 Sound On";
  });
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

  if (from === "SUE" && message.includes("Game will start in")) {
    startCountdown(30);
  }
});

socket.on("state", (state) => {
  document.getElementById("lobby-form").style.display = "none";
  gameDiv.style.display = "flex";
  lobbyTitle.innerText = currentLobby;

  const playerId = socket.id;
  const hand = state.hands[playerId] || [];

  if (state.currentTurn) {
    turnIndicator.style.display = "block";
    turnIndicator.innerText = state.currentTurn === playerId
      ? "It is your turn."
      : `It is ${state.players.find(p => p.id === state.currentTurn)?.name}'s turn.`;
  } else {
    turnIndicator.style.display = "none";
  }

  playerList.innerHTML = "";
  state.players.forEach(p => {
    const li = document.createElement("li");
    const isYou = p.id === playerId;
    li.innerText = `${isYou ? "👉 " : ""}${p.name} 🏅 ${p.handSize} (${p.score || 0})`;
    playerList.appendChild(li);
  });

  handDiv.innerHTML = "";

  if (!state.hasStarted) {
    renderBackCards(7);
    return;
  }

  stopCountdown();

  hand.forEach(card => {
    const img = document.createElement("img");
    img.src = `/assets/cards/${card}.png`;
    img.className = "card";

    const isRainbow = card === "wild_rainbow";
    const hasColors = ["red", "green", "blue", "yellow"].every(color =>
      hand.some(c => c.startsWith(color))
    );

    if (isRainbow && !hasColors) {
      img.classList.add("disabled");
      return;
    }

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

  unoButton.style.display = hand.length === 2 ? "block" : "none";

  discardPile.innerHTML = "";
  if (state.discardPile?.length) {
    const topCard = state.discardPile[state.discardPile.length - 1];
    const topImg = document.createElement("img");
    topImg.src = `/assets/cards/${topCard}.png`;
    topImg.className = "card";
    discardPile.appendChild(topImg);
  }

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

function renderBackCards(count) {
  handDiv.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const back = document.createElement("img");
    back.src = "/assets/cards/back.png";
    back.className = "card";
    handDiv.appendChild(back);
  }
}

function startCountdown(seconds) {
  let remaining = seconds;
  countdownTimer.style.display = "block";
  countdownTimer.textContent = `Starting in ${remaining}s`;

  clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    remaining--;
    countdownTimer.textContent = `Starting in ${remaining}s`;
    if (remaining <= 0) stopCountdown();
  }, 1000);
}

function stopCountdown() {
  clearInterval(countdownInterval);
  countdownTimer.style.display = "none";
}
