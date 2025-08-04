const socket = io();
let myId = null;
let currentHand = [];
let isMyTurn = false;

const handDiv = document.getElementById("player-hand");
const discardPile = document.getElementById("discard-pile");
const drawButton = document.getElementById("draw-button");
const playerList = document.getElementById("player-list");
const chatLog = document.getElementById("chat-log");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const joinForm = document.getElementById("join-form");
const gameScreen = document.getElementById("game-screen");
const joinScreen = document.getElementById("join-screen");

const sounds = {
  start: new Audio("/assets/sounds/start.mp3"),
  joined: new Audio("/assets/sounds/joined.mp3"),
  draw: new Audio("/assets/sounds/draw.mp3"),
  number: new Audio("/assets/sounds/number.mp3"),
  skip: new Audio("/assets/sounds/skip.mp3"),
  reverse: new Audio("/assets/sounds/reverse.mp3"),
  wild: new Audio("/assets/sounds/wild.mp3"),
  special: new Audio("/assets/sounds/special.mp3"),
  win: new Audio("/assets/sounds/win.mp3"),
  lose: new Audio("/assets/sounds/lose.mp3"),
  uno: new Audio("/assets/sounds/uno.mp3")
};

function playSound(name) {
  const sound = sounds[name];
  if (sound) {
    sound.currentTime = 0;
    sound.play().catch(() => {});
  }
}

socket.on("playSound", (name) => {
  playSound(name);
});

joinForm.addEventListener("submit", e => {
  e.preventDefault();
  const name = document.getElementById("name").value.trim();
  const lobby = document.getElementById("lobby").value.trim();
  if (name && lobby) {
    socket.emit("join", { name, lobby });
  }
});

socket.on("joinDenied", msg => {
  alert(msg || "You can't join a game in progress.");
});

socket.on("state", state => {
  if (!myId) myId = socket.id;
  const me = state.players.find(p => p.id === myId);
  isMyTurn = state.turn === myId;
  currentHand = me ? me.hand : [];

  joinScreen.style.display = "none";
  gameScreen.style.display = "block";

  // Show players
  playerList.innerHTML = "";
  state.players.forEach(p => {
    const li = document.createElement("li");
    li.textContent = `${p.name} - ${p.hand.length} cards - ${p.score || 0} pts${p.id === state.turn ? " 🔁" : ""}`;
    playerList.appendChild(li);
  });

  // Show discard pile
  discardPile.innerHTML = "";
  const card = document.createElement("img");
  let imgName = state.discardTop;
  if (imgName.includes("wild")) {
    const parts = imgName.split("_");
    if (parts.length > 2) imgName = `${parts[1]}_${parts[2]}`;
  }
  card.src = `/assets/cards/${imgName}.png`;
  card.alt = imgName;
  card.classList.add("card");
  discardPile.appendChild(card);

  // Show your hand
  renderHand();
});

function renderHand() {
  handDiv.innerHTML = "";
  currentHand.forEach(card => {
    const img = document.createElement("img");
    let srcCard = card;
    if (card.includes("wild") && card.split("_").length > 2) {
      const parts = card.split("_");
      srcCard = `${parts[1]}_${parts[2]}`;
    }
    img.src = `/assets/cards/${srcCard}.png`;
    img.alt = card;
    img.classList.add("card");
    img.addEventListener("click", () => playCard(card));
    handDiv.appendChild(img);
  });
}

chatSend.addEventListener("click", () => {
  const msg = chatInput.value.trim();
  if (msg) {
    socket.emit("chat", msg);
    chatInput.value = "";
  }
});

socket.on("chat", msg => {
  const div = document.createElement("div");
  div.textContent = `[${msg.from}]: ${msg.message}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});

// Draw pile as clickable image
drawButton.addEventListener("click", () => {
  if (isMyTurn) socket.emit("drawCard");
});

// Handle playing a card from hand
function playCard(card) {
  if (!isMyTurn) return;
  if (card.startsWith("wild")) {
    const chosenColor = prompt("Choose a color: red, blue, green, yellow");
    if (["red", "blue", "green", "yellow"].includes(chosenColor)) {
      socket.emit("playCard", { card, chosenColor });
    } else {
      alert("Invalid color");
    }
  } else {
    socket.emit("playCard", { card });
  }
}
