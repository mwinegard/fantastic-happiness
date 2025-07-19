const socket = io();

let playerName = "";
let lobbyId = "";

// JOIN FORM
document.getElementById("join-form").addEventListener("submit", e => {
  e.preventDefault();
  const name = document.getElementById("player-name").value.trim();
  const lobby = document.getElementById("lobby-id").value.trim();
  if (!name||!lobby) return alert("Name & lobby required");
  playerName = name;
  lobbyId = lobby;
  socket.emit("joinLobby", { name, lobby });
});

// CHAT RECEIVER
socket.on("chat", ({ sender, message }) => {
  const box = document.getElementById("chat-box");
  const p = document.createElement("p");
  const nameColor = sender==="SUE"?"navy":"black";
  p.innerHTML = `<strong style="color:${nameColor}">${sender}:</strong> ${message}`;
  box.appendChild(p);
  box.scrollTop = box.scrollHeight;
});

// STATE UPDATES
socket.on("updateState", state => {
  // on first state, show game
  if (!gameReady) {
    document.getElementById("join-screen").classList.add("hidden");
    document.getElementById("game-screen").classList.remove("hidden");
    document.getElementById("lobby-name").textContent = lobbyId;
    gameReady = true;
  }
  renderState(state);
});

// LOBBY FULL
socket.on("lobbyFull", () => {
  alert("Lobby full, choose another.");
  location.reload();
});

// LEAVE
document.getElementById("leave-btn").addEventListener("click", () => {
  socket.emit("leaveLobby", { name: playerName, lobby: lobbyId });
  location.reload();
});

// RENDER FLAGS
let gameReady = false;

// RENDER FUNCTIONS
function renderState(state) {
  updateTurn(state.currentPlayer);
  updateOpponents(state.players, state.currentPlayer);
  updateHand(state.players, state.currentPlayer);
  updateTopCard(state.topCard);
}

function updateTurn(current) {
  document.getElementById("current-turn").textContent = current||"";
}

function updateOpponents(players, current) {
  const c = document.getElementById("opponents");
  c.innerHTML="";
  players.forEach(p=>{
    if (p.name===playerName) return;
    const div = document.createElement("div");
    div.className="opponent";
    const flag = p.name===current?"👉 ":"";
    div.innerHTML = `${flag}${p.name} 🃏${p.cards.length} (${p.score})`;
    c.appendChild(div);
  });
}

function updateHand(players, current) {
  const you = players.find(p=>p.name===playerName);
  const h = you ? you.cards : [];
  const hc = document.getElementById("hand");
  hc.innerHTML="";
  h.forEach((card,i)=>{
    const img = document.createElement("img");
    img.src=`assets/cards/${card}.png`;
    img.className="card";
    img.onclick=()=>socket.emit("playCard", { name: playerName, lobby: lobbyId, index:i });
    hc.appendChild(img);
  });
}

function updateTopCard(top) {
  const t = document.getElementById("pile-top");
  if (top) {
    t.src=`assets/cards/${top}.png`;
    t.classList.remove("hidden");
  } else {
    t.classList.add("hidden");
  }
}

// DRAW CARD
document.getElementById("draw-stack").addEventListener("click", () => {
  socket.emit("drawCard", { name: playerName, lobby: lobbyId });
});

// CHAT SENDING
document.getElementById("chatForm").addEventListener("submit", e => {
  e.preventDefault();
  const inp = document.getElementById("chat-input");
  const msg = inp.value.trim();
  if (!msg) return;
  socket.emit("chat", { sender: playerName, message: msg, lobby: lobbyId });
  inp.value="";
});
