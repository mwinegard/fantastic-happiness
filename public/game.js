const socket = io();

const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name");
const lobbyInput = document.getElementById("lobby");
const gameDiv = document.getElementById("game");
const handDiv = document.getElementById("player-hand");
const drawPile = document.getElementById("draw-pile");
const discardPile = document.getElementById("discard-pile");
const playerList = document.getElementById("player-list");
const chatBox = document.getElementById("chat-box");
const chatSend = document.getElementById("chat-send");
const chatLog = document.getElementById("chat-log");
const unoBtn = document.getElementById("uno-btn");

let declaredUno = false;
let currentPlayerId = null;

// 🔊 Audio map
const sounds = {};
["draw", "skip", "reverse", "wild", "number", "win", "lose", "start", "joined", "uno"].forEach(key => {
  const audio = new Audio(`/assets/audio/${key}.mp3`);
  audio.onerror = () => {}; // skip missing
  sounds[key] = audio;
});

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const lobby = lobbyInput.value.trim().toLowerCase();
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

unoBtn.addEventListener("click", () => {
  declaredUno = true;
  playSound("uno");
  const div = document.createElement("div");
  div.textContent = `You declared UNO!`;
  div.style.color = "green";
  chatLog.appendChild(div);
});

function playSound(name) {
  try {
    sounds[name]?.play();
  } catch (e) {}
}

socket.on("state", (state) => {
  document.getElementById("lobby-form").style.display = "none";
  gameDiv.style.display = "block";

  const playerId = socket.id;
  const hand = state.hands[playerId];
  currentPlayerId = state.currentTurn;

  // Show UNO button if 2 cards
  unoBtn.style.display = (hand.length === 2 && currentPlayerId === playerId) ? "inline-block" : "none";

  handDiv.innerHTML = "";
  hand.forEach(card => {
    const img = document.createElement("img");
    img.src = `/assets/cards/${card}.png`;
    img.className = "card";
    img.addEventListener("click", () => {
      if (currentPlayerId !== playerId) return;

      if (hand.length === 2 && !declaredUno) {
        alert("You must declare UNO before playing!");
        return;
      }

      if (card.startsWith("wild")) {
        const color = prompt("Choose a color: red, blue, green, yellow");
        if (color && ["red", "blue", "green", "yellow"].includes(color)) {
          socket.emit("playCard", { lobby: state.players[0].id, card, chosenColor: color });
          playSound("wild");
        }
      } else {
        socket.emit("playCard", { lobby: state.players[0].id, card });
        playSound(card.includes("draw") ? "draw" :
                  card.includes("reverse") ? "reverse" :
                  card.includes("skip") ? "skip" : "number");
      }

      declaredUno = false;
    });
    handDiv.appendChild(img);
  });

  discardPile.innerHTML = "";
  const topCard = state.discardPile[state.discardPile.length - 1];
  if (topCard) {
    const topImg = document.createElement("img");
    topImg.src = `/assets/cards/${topCard}.png`;
    topImg.className = "card";
    discardPile.appendChild(topImg);
  }

  drawPile.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const card = document.createElement("img");
    card.src = "/assets/cards/back.png";
    card.className = "card stack";
    card.style.marginLeft = `${i * 3}px`;
    if (i === 2) {
      card.addEventListener("click", () => {
        if (currentPlayerId === playerId) {
          socket.emit("drawCard", { lobby: state.players[0].id });
          playSound("draw");
        }
      });
      card.style.cursor = "pointer";
    }
    drawPile.appendChild(card);
  }

  playerList.innerHTML = "";
  state.players.forEach(p => {
    const li = document.createElement("li");
    const mark = p.id === playerId ? "👉 " : "";
    li.textContent = `${mark}${p.name} 🃏 ${p.handSize} (${p.score})`;
    if (p.id === state.currentTurn) {
      li.style.fontWeight = "bold";
      li.style.color = "orange";
    }
    playerList.appendChild(li);
  });
});

socket.on("chat", ({ from, message }) => {
  const div = document.createElement("div");
  div.textContent = `${from}: ${message}`;
  div.style.fontWeight = from === "SUE" ? "bold" : "normal";
  div.style.color = from === "SUE" ? "#001f3f" : "black";
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;

  if (message.toLowerCase().includes("joined")) playSound("joined");
  if (message.toLowerCase().includes("win")) playSound("win");
  if (message.toLowerCase().includes("lose")) playSound("lose");
  if (message.toLowerCase().includes("started")) playSound("start");
});
