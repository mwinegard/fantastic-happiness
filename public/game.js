const socket = io();
let myName = '';
let lobbyId = '';

document.getElementById('joinBtn').addEventListener('click', () => {
  const name = document.getElementById('nameInput').value.trim().substring(0, 20);
  const lobby = document.getElementById('lobbyInput').value.trim();
  if (!name || !lobby || /[^a-zA-Z0-9]/.test(name)) return alert('Enter valid name and lobby');

  myName = name;
  lobbyId = lobby;

  localStorage.setItem('unoName', name);
  localStorage.setItem('unoLobby', lobby);

  document.getElementById('lobby-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('hidden');

  socket.emit('joinLobby', { name, lobbyId });
});

document.getElementById('draw-pile').addEventListener('click', () => {
  socket.emit('drawCard');
});

document.getElementById('leaveBtn').addEventListener('click', () => {
  socket.emit('leaveGame');
  location.reload();
});

socket.on('gameState', state => {
  const handDiv = document.getElementById('hand');
  const discardImg = document.getElementById('discard');
  const opponentsDiv = document.getElementById('opponents');
  const wildColorDiv = document.getElementById('wild-color');

  const discardTop = state.table[state.table.length - 1];
  discardImg.src = `cards/${discardTop}`;

  wildColorDiv.innerHTML = state.lastWildColor
    ? `Color chosen: <span class="wild-dot ${state.lastWildColor}"></span>`
    : '';

  handDiv.innerHTML = '';
  state.hand.forEach(card => {
    const img = document.createElement('img');
    img.src = `cards/${card}`;
    img.classList.add('card');
    img.addEventListener('click', () => {
      if (card.includes('wild')) {
        showWildColorChoice(card);
      } else {
        socket.emit('playCard', { card });
      }
    });
    handDiv.appendChild(img);
  });

  opponentsDiv.innerHTML = '';
  state.others.forEach(op => {
    const isTurn = op.name === state.currentPlayer;
    const row = document.createElement('div');
    row.classList.add('opponent');
    row.innerHTML = `
      ${isTurn ? '👉' : ''} ${op.name} 🃏 ${op.count} (${op.score})
    `;
    opponentsDiv.appendChild(row);
  });

  if (state.isMyTurn) {
    startTurnTimer();
  } else {
    stopTurnTimer();
  }
});

socket.on('gameOver', ({ message }) => {
  alert(message);
  location.reload();
});

function showWildColorChoice(card) {
  const choice = prompt("Choose a color: red, blue, green, yellow");
  const valid = ['red', 'blue', 'green', 'yellow'];
  if (!valid.includes(choice)) {
    alert('Invalid color');
    return;
  }
  socket.emit('playCard', { card, chosenColor: choice });
}

let turnTimeout;
function startTurnTimer() {
  clearTimeout(turnTimeout);
  turnTimeout = setTimeout(() => {
    socket.emit('drawCard');
  }, 60000);
}

function stopTurnTimer() {
  clearTimeout(turnTimeout);
}

window.addEventListener('load', () => {
  const savedName = localStorage.getItem('unoName');
  const savedLobby = localStorage.getItem('unoLobby');
  if (savedName) document.getElementById('nameInput').value = savedName;
  if (savedLobby) document.getElementById('lobbyInput').value = savedLobby;
});
