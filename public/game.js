const socket = io();
let myId = null;
let myName = "";
let isMyTurn = false;
let muted = false;

const handDiv = document.getElementById("player-hand");
const discardPile = document.getElementById("discard-pile");
const drawPile = document.getElementById("draw-pile");
const playerList = document.getElementById("player-list");
const chatLog = document.getElementById("chat-log");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name");
const gameScreen = document.getElementById("game-screen");
const joinScreen = document.getElementById("join-screen");
const unoBtn = document.getElementById("uno-btn");
const muteBtn = document.getElementById("mute-toggle");

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

function playSound(name) {
  if (muted) return;
  const sound = sounds[name];
  if (sound) sound.play().catch(() => {});
}

muteBtn.addEventListener("click", () => {
  muted = !muted;
  muteBtn.textContent = muted ? "🔇 Sound Off" : "🔊 Sound On";
});

joinForm.addEventListener("submit", e => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (name) {
    socket.emit("join", name);
    myName = name;
  }
});

socket.on("joinDenied", msg => {
  alert(msg || "Name already in use.");
});

socket.on("joined", ({ id, name }) => {
  myId = id;
  joinScreen.style.display = "none";
  gameScreen.style.display = "block";
});

socket.on("state", state => {
  const me = state.players.find(p => p.id === myId);
  isMyTurn = state.turn === myId;

  playerList.innerHTML = "";
  state.players.forEach(p => {
    const li = document.createElement("li");
    li.textContent = `${p.name} - ${p.handSize} cards${p.id === state.turn ? " 🎯" : ""}`;
    playerList.appendChild(li);
  });

  discardPile.innerHTML = "";
  if (state.discardTop) {
    const topCard = document.createElement("img");
    const imgName = state.discardTop.replace(/^.*?_/, "");
    topCard.src = `/assets/cards/${imgName}.png`;
    topCard.classList.add("card");
    discardPile.appendChild(topCard);
  }
});

socket.on("chat", msg => {
  const div = document.createElement("div");
  div.textContent = `[${msg.from}]: ${msg.message}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});

socket.on("sound", name => {
  playSound(name);
});

chatSend.addEventListener("click", () => {
  const msg = chatInput.value.trim();
  if (msg) {
    socket.emit("chat", msg);
    chatInput.value = "";
  }
});

unoBtn.addEventListener("click", () => {
  socket.emit("uno");
});

function renderHand(cards) {
  handDiv.innerHTML = "";
  cards.forEach(card => {
    const img = document.createElement("img");
    const base = card.includes("wild") && card.split("_").length > 2
      ? `${card.split("_")[1]}_${card.split("_")[2]}`
      : card;
    img.src = `/assets/cards/${base}.png`;
    img.classList.add("card");
    img.addEventListener("click", () => playCard(card));
    if (isMyTurn) handDiv.appendChild(img);
  });
}

function playCard(card) {
  if (!isMyTurn) return;
  if (card.startsWith("wild")) {
    const chosenColor = prompt("Choose a color: red, blue, green, yellow");
    if (["red", "blue", "green", "yellow"].includes(chosenColor)) {
      socket.emit("playCard", { card, chosenColor });
    } else {
      alert("Invalid color.");
    }
  } else {
    socket.emit("playCard", { card });
  }
}

drawPile.addEventListener("click", () => {
  if (isMyTurn) socket.emit("drawCard");
});

socket.on("hand", cards => {
  renderHand(cards);
});
