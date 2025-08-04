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
  currentHand = me ? me.handSize : [];

  playerList.innerHTML = "";
  state.players.forEach(p => {
    const li = document.createElement("li");
    li.textContent = `${p.name} - ${p.handSize} cards - ${p.score || 0} pts${p.id === state.turn ? " 🔁" : ""}`;
    playerList.appendChild(li);
  });

  discardPile.innerHTML = "";
  const card = document.createElement("img");
  let imgName = state.discardTop;
  if (imgName.includes("wild")) {
    const parts = imgName.split("_");
    if (parts.length > 2) imgName = `${parts[1]}_${parts[2]}`; // strip prefix
  }
  card.src = `/assets/cards/${imgName}.png`;
  discardPile.appendChild(card);
});

socket.on("chat", msg => {
  const div = document.createElement("div");
  div.textContent = `[${msg.from}]: ${msg.message}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});

chatSend.addEventListener("click", () => {
  const msg = chatInput.value.trim();
  if (msg) {
    socket.emit("chat", msg);
    chatInput.value = "";
  }
});

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
