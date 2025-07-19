const socket = io();

const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name");
const lobbyInput = document.getElementById("lobby");
const gameDiv = document.getElementById("game");
const handDiv = document.getElementById("player-hand");
const drawPile = document.getElementById("draw-pile");
const discardPile = document.getElementById("discard-pile");

const chatBox = document.getElementById("chat-box");
const chatSend = document.getElementById("chat-send");
const chatLog = document.getElementById("chat-log");

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const lobby = lobbyInput.value.trim();
  if (name && lobby) {
    socket.emit("join", { name, lobby });
  }
});

chatSend.addEventListener("click", sendMessage);
chatBox.addEventListener("keypress", (e) => {
  if (e.key === "Enter") sendMessage();
});

function sendMessage() {
  const text = chatBox.value.trim();
  if (text) {
    socket.emit("chat", { message: text });
    chatBox.value = "";
  }
}

socket.on("state", (state) => {
  document.getElementById("lobby-form").style.display = "none";
  gameDiv.style.display = "block";

  const playerId = socket.id;
  const hand = state.hands[playerId];

  handDiv.innerHTML = "";
  hand.forEach(card => {
    const img = document.createElement("img");
    img.src = `/assets/cards/${card}.png`;
    img.className = "card";
    img.addEventListener("click", () => {
      if (card.startsWith("wild")) {
        const color = prompt("Choose a color: red, blue, green, yellow");
        socket.emit("playCard", { lobby: state.players[0].id, card, chosenColor: color });
      } else {
        socket.emit("playCard", { lobby: state.players[0].id, card });
      }
    });
    handDiv.appendChild(img);
  });

  discardPile.innerHTML = "";
  const topCard = state.discardPile[state.discardPile.length - 1];
  const topImg = document.createElement("img");
  topImg.src = `/assets/cards/${topCard}.png`;
  topImg.className = "card";
  discardPile.appendChild(topImg);

  drawPile.innerHTML = "";
  const drawImg = document.createElement("img");
  drawImg.src = "/assets/cards/back.png";
  drawImg.className = "card";
  drawImg.addEventListener("click", () => {
    socket.emit("drawCard", { lobby: state.players[0].id });
  });
  drawPile.appendChild(drawImg);

  // 🧍 Players list
  const playerList = document.getElementById("player-list");
  playerList.innerHTML = "";
  state.players.forEach(p => {
    const li = document.createElement("li");
    const mark = p.id === socket.id ? "👉 " : "";
    li.innerText = `${mark}${p.name} 🃏 ${p.handSize} (${p.score})`;
    playerList.appendChild(li);
  });
});

socket.on("chat", ({ from, message }) => {
  const div = document.createElement("div");
  div.textContent = `${from}: ${message}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});
