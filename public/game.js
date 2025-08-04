const socket = io();
let myId = null;
let myHand = [];
let isMyTurn = false;

const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name");
const joinScreen = document.getElementById("join-screen");
const gameScreen = document.getElementById("game-screen");
const playerList = document.getElementById("player-list");
const discardPile = document.getElementById("discard-pile");
const drawPile = document.getElementById("draw-pile");
const handDiv = document.getElementById("player-hand");
const chatLog = document.getElementById("chat-log");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const unoBtn = document.getElementById("uno-btn");

const sounds = {
  draw: new Audio("/assets/sounds/draw.mp3"),
  skip: new Audio("/assets/sounds/skip.mp3"),
  reverse: new Audio("/assets/sounds/reverse.mp3"),
  wild: new Audio("/assets/sounds/wild.mp3"),
  special: new Audio("/assets/sounds/special.mp3"),
  number: new Audio("/assets/sounds/number.mp3"),
  win: new Audio("/assets/sounds/win.mp3"),
  lose: new Audio("/assets/sounds/lose.mp3"),
  start: new Audio("/assets/sounds/start.mp3"),
  joined: new Audio("/assets/sounds/joined.mp3"),
  uno: new Audio("/assets/sounds/uno.mp3"),
};

let muted = false;
const muteBtn = document.getElementById("mute-toggle");
if (muteBtn) {
  muteBtn.addEventListener("click", () => {
    muted = !muted;
    muteBtn.textContent = muted ? "🔇 Sound Off" : "🔊 Sound On";
  });
}

function playSound(name) {
  if (muted) return;
  const sound = sounds[name];
  if (sound) sound.play().catch(() => {});
}

joinForm.addEventListener("submit", e => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (name) {
    socket.emit("join", { name });
  }
});

socket.on("joinDenied", msg => alert(msg || "Name in use or error."));

socket.on("state", state => {
  myId = socket.id;
  const me = state.players.find(p => p.id === myId);
  if (me) {
    joinScreen.style.display = "none";
    gameScreen.style.display = "block";
    isMyTurn = me.isTurn;
  }

  playerList.innerHTML = "";
  state.players.forEach(p => {
    const item = document.createElement("li");
    item.textContent = `${p.name} (${p.handSize}) ${p.isTurn ? "🎯" : ""}`;
    playerList.appendChild(item);
  });

  discardPile.innerHTML = "";
  const topCard = document.createElement("img");
  topCard.src = `/assets/cards/${state.discardTop}.png`;
  topCard.className = "card";
  discardPile.appendChild(topCard);

  drawPile.innerHTML = "";
  const backCard = document.createElement("img");
  backCard.src = "/assets/cards/back.png";
  backCard.className = "card draw-pile";
  backCard.addEventListener("click", () => {
    if (isMyTurn) socket.emit("drawCard");
  });
  drawPile.appendChild(backCard);
});

socket.on("yourHand", hand => {
  myHand = hand;
  renderHand();
});

socket.on("chat", ({ from, message }) => {
  const msgDiv = document.createElement("div");
  msgDiv.textContent = `[${from}]: ${message}`;
  chatLog.appendChild(msgDiv);
  chatLog.scrollTop = chatLog.scrollHeight;
});

chatSend.addEventListener("click", () => {
  const msg = chatInput.value.trim();
  if (msg) {
    socket.emit("chat", msg);
    chatInput.value = "";
  }
});

unoBtn.addEventListener("click", () => {
  socket.emit("callUNO");
});

socket.on("sound", name => {
  playSound(name);
});

function renderHand() {
  handDiv.innerHTML = "";
  myHand.forEach(card => {
    const cardImg = document.createElement("img");
    cardImg.src = `/assets/cards/${card}.png`;
    cardImg.className = "card";
    cardImg.addEventListener("click", () => {
      if (!isMyTurn) return;
      if (card.includes("wild")) {
        const color = prompt("Choose a color (red, blue, green, yellow):");
        if (["red", "blue", "green", "yellow"].includes(color)) {
          socket.emit("playCard", { card, chosenColor: color });
        }
      } else {
        socket.emit("playCard", { card });
      }
    });
    handDiv.appendChild(cardImg);
  });
}
