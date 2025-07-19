const socket = io();
let hand = [];
let lobbyId = sessionStorage.getItem('lobbyId');
let playerName = sessionStorage.getItem('playerName');

function joinLobby(lobbyId, name) {
  socket.emit('joinLobby', { lobbyId, name });
}

joinLobby(lobbyId, playerName);

socket.on('yourHand', cards => {
  hand = cards;
  renderHand();
});

socket.on('updateGame', state => {
  const current = state.players.find(p => p.id === state.currentPlayer);
  document.getElementById('turn-info').innerText = `Current Turn: ${current?.name || "Waiting..."}`;
  renderTablePile(state.tablePile);
  renderOpponents(state.players, state.currentPlayer);
});

socket.on('chatUpdate', ({ id, msg }) => {
  const log = document.getElementById('chatLog');
  if (log) {
    const p = document.createElement('p');
    p.textContent = msg;
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
  }
});

function renderHand() {
  const container = document.getElementById('player-hand');
  container.innerHTML = '';
  hand.forEach(card => {
    const img = document.createElement('img');
    img.src = `assets/cards/${card}`;
    img.style.height = '100px';
    img.style.margin = '4px';
    img.style.cursor = 'pointer';
    img.onclick = () => playCard(card);
    container.appendChild(img);
  });
}

function renderTablePile(pile) {
  const container = document.getElementById('table-pile');
  container.innerHTML = '';
  if (pile.length) {
    const card = pile[pile.length - 1];
    const img = document.createElement('img');
    img.src = `assets/cards/${card}`;
    img.style.height = '120px';
    container.appendChild(img);
  }
}

function renderOpponents(players, currentPlayerId) {
  const container = document.getElementById('opponent-hands');
  container.innerHTML = '';
  players.forEach(p => {
    if (p.id === socket.id) return; // skip self
    const div = document.createElement('div');
    div.style.margin = '10px';
    div.innerHTML = `<strong>${p.name}</strong><br/>`;
    for (let i = 0; i < p.handCount; i++) {
      const img = document.createElement('img');
      img.src = `assets/cards/back.png`;
      img.style.height = '60px';
      img.style.margin = '2px';
      div.appendChild(img);
    }
    container.appendChild(div);
  });
}

function playCard(card) {
  let chosenColor = null;
  if (card.includes('wild')) {
    chosenColor = prompt('Choose color: red, blue, green, yellow');
  }
  socket.emit('playCard', { card, chosenColor });
}

function drawCard() {
  socket.emit('drawCard');
}

function sendChat() {
  const input = document.getElementById('chatInput');
  if (input && input.value.trim()) {
    socket.emit('chatMessage', input.value.trim());
    input.value = '';
  }
}
