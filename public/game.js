const socket = io();

let myHand = [];
let myName = sessionStorage.getItem('playerName');
let myLobby = sessionStorage.getItem('lobbyId');

function joinLobby() {
  socket.emit('joinLobby', {
    lobbyId: myLobby,
    name: myName
  });
}

joinLobby();

socket.on('gameState', (state) => {
  renderHand(state.hand);
  renderTable(state.table);
  renderOpponents(state.others);
  document.getElementById('turn-info').innerText = `Current Turn: ${state.currentPlayer}${state.isMyTurn ? " (You!)" : ""}`;
  renderChat(state.chat);
});

socket.on('chatUpdate', ({ sender, msg }) => {
  addToChat(`${sender}: ${msg}`);
});

socket.on('gameOver', ({ winner }) => {
  alert(`Game Over! Winner: ${winner}`);
  window.location.reload();
});

function renderHand(hand) {
  const el = document.getElementById('player-hand');
  el.innerHTML = '';
  hand.forEach(card => {
    const img = document.createElement('img');
    img.src = `assets/cards/${card}`;
    img.style.height = '80px';
    img.style.margin = '2px';
    img.onclick = () => {
      playCard(card);
    };
    el.appendChild(img);
  });
}
function renderTable(table) {
  const el = document.getElementById('table-pile');
  el.innerHTML = '';
  if (table.length) {
    const top = table[table.length - 1];
    const img = document.createElement('img');
    img.src = `assets/cards/${top}`;
    img.style.height = '120px';
    el.appendChild(img);
  }
}
function renderOpponents(others) {
  const el = document.getElementById('opponent-hands');
  el.innerHTML = '';
  others.forEach(player => {
    const div = document.createElement('div');
    div.innerHTML = `<b>${player.name}</b><br>`;
    for (let i = 0; i < player.count; i++) {
      const img = document.createElement('img');
      img.src = `assets/cards/back.png`;
      img.style.height = '50px';
      img.style.margin = '1px';
      div.appendChild(img);
    }
    el.appendChild(div);
  });
}
function playCard(card) {
  let chosenColor = null;
  if (card.startsWith("wild")) {
    chosenColor = prompt("Choose color: red, green, blue, yellow");
    if (!["red","green","blue","yellow"].includes(chosenColor)) return;
  }
  socket.emit("playCard", { card, chosenColor });
}
function drawCard() {
  socket.emit("drawCard");
}
function sendChat() {
  const input = document.getElementById('chatInput');
  if (input.value.trim()) {
    socket.emit('chatMessage', input.value.trim());
    input.value = '';
  }
}
function renderChat(chat) {
  const el = document.getElementById('chatLog');
  el.innerHTML = '';
  chat.forEach(entry => {
    const p = document.createElement('p');
    p.textContent = `${entry.sender}: ${entry.msg}`;
    el.appendChild(p);
  });
}
function addToChat(line) {
  const el = document.getElementById('chatLog');
  const p = document.createElement('p');
  p.textContent = line;
  el.appendChild(p);
  el.scrollTop = el.scrollHeight;
}
