const socket = io();
let myName = '';
let lobbyId = '';
let hand = [];
let myColor = '';
let isMyTurn = false;

// DOM elements
const joinScreen = document.getElementById("joinScreen");
const gameScreen = document.getElementById("gameScreen");
const joinForm = document.getElementById("joinForm");
const playerInput = document.getElementById("playerName");
const lobbyInput = document.getElementById("lobbyId");
const gameInfo = document.getElementById("gameInfo");
const playerList = document.getElementById("playerList");
const handArea = document.getElementById("handArea");
const pileTopCard = document.getElementById("pileTopCard");
const drawDeck = document.getElementById("drawDeck");
const chatBox = document.getElementById("chatBox");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  myName = playerInput.value.trim();
  lobbyId = lobbyInput.value.trim();
  if (myName && lobbyId) {
    socket.emit("joinLobby", { name: myName, lobbyId });
  }
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const msg = chatInput.value.trim();
  if (msg) {
    socket.emit("chatMessage", { lobbyId, name: myName, text: msg });
    chatInput.value = "";
  }
});

drawDeck.addEventListener("click", () => {
  if (isMyTurn) {
    socket.emit("drawCard", { lobbyId, name: myName });
  }
});

function renderHand() {
  handArea.innerHTML = "";
  hand.forEach((card, index) => {
    const img = document.createElement("img");
    img.src = `assets/cards/${card}.png`;
    img.classList.add("card");
    img.addEventListener("click", () => {
      if (isMyTurn) {
        socket.emit("playCard", { lobbyId, name: myName, card });
      }
    });
    handArea.appendChild(img);
  });
}

function renderPlayers(players, currentTurn) {
  playerList.innerHTML = "";
  players.forEach(p => {
    const li = document.createElement("li");
    const turnEmoji = currentTurn === p.name ? "🎯 " : "";
    const scoreText = p.score !== undefined ? ` (${p.score})` : "";
    li.innerHTML = `${turnEmoji}<strong style="color:${p.color}">${p.name}</strong> 🃏${p.handCount}${scoreText}`;
    playerList.appendChild(li);
  });
}

function addChatMessage(from, text, system = false) {
  const div = document.createElement("div");
  if (system) {
    div.innerHTML = `<strong style="color:navy">SUE:</strong> ${text}`;
  } else {
    div.innerHTML = `<strong style="color:${from === myName ? myColor : '#000'}">${from}:</strong> ${text}`;
  }
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// SOCKET EVENTS

socket.on("lobbyJoined", (data) => {
  joinScreen.classList.add("hidden");
  gameScreen.classList.remove("hidden");
  myColor = data.color;
  addChatMessage("SUE", `Welcome ${myName}! Waiting for other players...`, true);
});

socket.on("gameState", (state) => {
  if (!state.players || !state.deck) return;

  const me = state.players.find(p => p.name === myName);
  if (!me) return;

  hand = me.hand;
  isMyTurn = state.currentTurn === myName;
  gameInfo.textContent = isMyTurn ? "Your turn!" : `Waiting for ${state.currentTurn}...`;

  renderHand();
  renderPlayers(state.players, state.currentTurn);

  // update pile
  if (state.pileTopCard) {
    pileTopCard.src = `assets/cards/${state.pileTopCard}.png`;
    pileTopCard.classList.remove("hidden");
  } else {
    pileTopCard.classList.add("hidden");
  }
});

socket.on("chatMessage", ({ from, text }) => {
  addChatMessage(from, text, from === "SUE");
});

socket.on("errorMessage", (msg) => {
  alert(msg);
});
