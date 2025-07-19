const socket = io();

const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name");
const lobbyInput = document.getElementById("lobby");

const gameDiv = document.getElementById("game");
const handDiv = document.getElementById("player-hand");
const drawPile = document.getElementById("draw-pile");
const discardPile = document.getElementById("discard-pile");
const playerList = document.getElementById("player-list");

const chatLog = document.getElementById("chat-log");
const chatBox = document.getElementById("chat-box");
const chatSend = document.getElementById("chat-send");

const unoBtn = document.getElementById("uno-btn");
let hasDeclaredUno = false;

const sounds = [
  "draw", "skip", "reverse", "wild", "number", "win", "lose", "start", "joined", "uno"
];

const audio = {};
for (let key of sounds) {
  const path = `/assets/audio/${key}.mp3`;
  const el = new Audio(path);
  el.onerror = () => {}; // prevent crash if file missing
  audio[key] = el;
}

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const lobby = lobbyInput.value.trim().toLowerCase();
  if (name && lobby) {
    socket.emit("join", { name, lobby });
  }
});

chatSend.addEventListener("click", () => {
  const msg = chatBox.value.trim();
  if (msg) {
    socket.emit("chat", { message: msg });
    chatBox.value = "";
  }
});

chatBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter") chatSend.click();
});

unoBtn.addEventListener("click", () => {
  hasDeclaredUno = true;
  audio.uno?.play();
  appendChat("SUE", "UNO! declared.");
});

function appendChat(from, message) {
  const div = document.createElement("div");
  if (from === "SUE") {
    div.innerHTML = `<b style="color: navy;">${from}:</b> ${message}`;
  } else {
    const color = assignColor(from);
    div.innerHTML = `<b style="color:${color}">${from}:</b> ${message}`;
  }
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function assignColor(name) {
  const colors = ["red", "green", "blue", "orange"];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash += name.charCodeAt(i);
  return colors[hash % colors.length];
}

socket.on("chat", ({ from, message }) => {
  appendChat(from, message);
});

socket.on("state", (state) => {
  document.getElementById("lobby-form").style.display = "none";
  gameDiv.style.display = "flex";

  const playerId = socket.id;
  const hand = state.hands[playerId];
  const currentPlayerId = state.currentTurn;

  // Update player list
  playerList.innerHTML = "";
  state.players.forEach(p => {
    const mark = p.id === playerId ? "👉 " : "";
    const li = document.createElement("li");
    li.innerText = `${mark}${p.name} 🃏 ${p.handSize} (${p.score})`;
    playerList.appendChild(li);
  });

  // Render discard pile
  discardPile.innerHTML = "";
  const topCard = state.discardPile[state.discardPile.length - 1];
  const topImg = document.createElement("img");
  topImg.src = `/assets/cards/${topCard}.png`;
  topImg.className = "card";
  discardPile.appendChild(topImg);

  // Draw pile (stacked)
  drawPile.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const stack = document.createElement("img");
    stack.src = "/assets/cards/back.png";
    stack.className = "card stack";
    stack.style.marginLeft = `${i * 4}px`;
    stack.style.position = "absolute";
    stack.style.zIndex = 3 - i;
    drawPile.appendChild(stack);
  }

  drawPile.onclick = () => {
    if (playerId !== currentPlayerId) return;
    audio.draw?.play();
    socket.emit("drawCard", { lobby: state.players[0].id });
  };

  // Render hand
  handDiv.innerHTML = "";
  hand.forEach(card => {
    const img = document.createElement("img");
    img.src = `/assets/cards/${card}.png`;
    img.className = "card";
    img.addEventListener("click", () => {
      if (playerId !== currentPlayerId) return;
      const color = card.startsWith("wild")
        ? prompt("Choose color: red, green, blue, yellow")?.toLowerCase()
        : null;
      if (color && !["red", "green", "blue", "yellow"].includes(color)) return;
      const type = card.includes("wild") ? "wild" : card.includes("draw") ? "draw" : card.includes("skip") ? "skip" : card.includes("reverse") ? "reverse" : "number";
      audio[type]?.play();
      if (hand.length === 2 && !hasDeclaredUno) {
        alert("You must declare UNO before playing second-to-last card!");
        return;
      }
      socket.emit("playCard", {
        lobby: state.players[0].id,
        card,
        chosenColor: color || null
      });
    });
    handDiv.appendChild(img);
  });

  unoBtn.style.display = hand.length === 2 ? "inline-block" : "none";
});
