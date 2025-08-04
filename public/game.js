const socket = io();
let myId = null;
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
const gameScreen = document.getElementById("game-screen");
const nameInput = document.getElementById("name");
const unoButton = document.getElementById("uno-btn");
const muteBtn = document.getElementById("mute-toggle");

const sounds = {};
[
  "draw", "skip", "reverse", "wild", "special", "number",
  "win", "lose", "start", "joined", "uno"
].forEach(name => {
  const audio = new Audio(`/assets/sounds/${name}.mp3`);
  audio.volume = 0.6;
  sounds[name] = audio;
});

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
    socket.emit("join", { name });
  }
});

socket.on("joinDenied", msg => {
  alert(msg || "You can't join right now.");
});

socket.on("joined", id => {
  myId = id;
  joinForm.style.display = "none";
  gameScreen.style.display = "block";
});

socket.on("state", state => {
  if (!myId) return;
  const me = state.players.find(p => p.id === myId);
  isMyTurn = state.turn === myId;

  playerList.innerHTML = "";
  state.players.forEach(p => {
    const li = document.createElement("div");
    li.textContent = `${p.name} - ${p.handSize} cards - ${p.score || 0} pts${p.id === state.turn ? " 🔁" : ""}`;
    playerList.appendChild(li);
  });

  discardPile.innerHTML = "";
  if (state.discardTop) {
    const cardImg = document.createElement("img");
    let imgName = state.discardTop;
    if (imgName.includes("wild")) {
      const parts = imgName.split("_");
      if (parts.length > 2) imgName = `${parts[1]}_${parts[2]}`;
    }
    cardImg.src = `/assets/cards/${imgName}.png`;
    cardImg.className = "pile";
    discardPile.appendChild(cardImg);
  }

  handDiv.innerHTML = "";
  if (me && me.hand && me.hand.length > 0) {
    me.hand.forEach(card => {
      const img = document.createElement("img");
      img.src = `/assets/cards/${card}.png`;
      img.className = "card";
      img.onclick = () => tryPlayCard(card);
      handDiv.appendChild(img);
    });
  }
});

drawPile.addEventListener("click", () => {
  if (isMyTurn) socket.emit("drawCard");
});

chatSend.addEventListener("click", () => {
  const msg = chatInput.value.trim();
  if (msg) {
    socket.emit("chat", msg);
    chatInput.value = "";
  }
});

chatInput.addEventListener("keydown", e => {
  if (e.key === "Enter") chatSend.click();
});

socket.on("chat", ({ from, message }) => {
  const div = document.createElement("div");
  div.textContent = `[${from}]: ${message}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});

unoButton.addEventListener("click", () => {
  socket.emit("callUNO");
});

socket.on("playSound", name => {
  playSound(name);
});

function tryPlayCard(card) {
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
