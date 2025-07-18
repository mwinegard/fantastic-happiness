
const socket = io();
let hand = [];

function joinLobby(lobbyId, name) {
  socket.emit('joinLobby', { lobbyId, name });
}

socket.on('yourHand', cards => {
  hand = cards;
  renderHand();
});

socket.on('updateGame', state => {
  document.getElementById('game-root').innerHTML = `
    <h2>Current Turn: ${state.players.find(p => p.id === state.currentPlayer)?.name}</h2>
    <div id="table-pile">${renderTableCard(state.tablePile)}</div>
    <h3>Your Hand</h3>
    <div id="hand">${renderHand()}</div>
    <button onclick="drawCard()">Draw</button>
    <div id="chat"><input id="chatInput" /><button onclick="sendChat()">Send</button></div>
    <div id="chatLog"></div>
  `;
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
  return hand.map(card => `
    <img src="assets/cards/${card}" style="height: 100px; cursor: pointer;" onclick="playCard('${card}')" />
  `).join('');
}

function renderTableCard(pile) {
  if (!pile || !pile.length) return '';
  const card = pile[pile.length - 1];
  return `<img src="assets/cards/${card}" style="height: 120px;" />`;
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

// Auto-join for demo
document.addEventListener('DOMContentLoaded', () => {
  const lobbyId = prompt("Enter lobby name/code:");
  const name = prompt("Enter your name (1–20 characters):");
  if (lobbyId && name) joinLobby(lobbyId, name);
});
