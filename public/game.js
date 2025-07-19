const socket = io();
let playerId = null;
let currentPlayerId = null;
let lobbyId = '';
let playerHand = [];

const joinBtn = document.getElementById('joinBtn');
const chatInput = document.getElementById('chatInput');
const sendChat = document.getElementById('sendChat');
const unoBtn = document.getElementById('unoBtn');

joinBtn.onclick = () => {
  lobbyId = document.getElementById('lobbyId').value;
  const playerName = document.getElementById('playerName').value;
  if (lobbyId && playerName) {
    socket.emit('joinLobby', { lobbyId, playerName });
  }
};

socket.on('joinedLobby', ({ playerId: id }) => {
  playerId = id;
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('game').style.display = 'block';
  document.getElementById('currentLobby').textContent = lobbyId;
});

socket.on('updateLobby', data => {
  const container = document.getElementById('players');
  container.innerHTML = '<h3>Players:</h3>';
  data.players.forEach(p => {
    container.innerHTML += `<div>${p.name} (${p.hand.length} cards, ${p.score} pts)</div>`;
  });
});

socket.on('gameState', ({ pile, players, currentPlayer }) => {
  currentPlayerId = currentPlayer;
  playerHand = players.find(p => p.id === playerId)?.hand || [];

  const playerList = document.getElementById('players');
  playerList.innerHTML = '<h3>Players:</h3>';
  players.forEach(p => {
    const mark = p.id === currentPlayer ? '🟢' : '';
    playerList.innerHTML += `<div>${p.name} (${p.handSize} cards, ${p.score} pts) ${mark}</div>`;
  });

  // Timer UI
  clearInterval(window.timerInterval);
  if (playerId === currentPlayer) {
    let sec = 60;
    window.timerInterval = setInterval(() => {
      document.getElementById('topCard').textContent = `Your Turn - ${sec--}s`;
      if (sec < 0) clearInterval(window.timerInterval);
    }, 1000);
  }

  // Render top card
  const top = pile[pile.length - 1];
  const topEl = document.getElementById('topCard');
  topEl.textContent = top.value;
  topEl.className = `card ${top.color}`;

  // Render hand
  const handEl = document.getElementById('hand');
  handEl.innerHTML = '';
  playerHand.forEach(card => {
    const d = document.createElement('div');
    d.className = `card ${card.color}`;
    d.textContent = card.value;
    d.onclick = () => {
      if (card.color === 'black') {
        const c = prompt('Choose color: red, green, blue, yellow');
        if (['red','green','blue','yellow'].includes(c)) {
          socket.emit('playCard', { lobbyId, playerId, card, chosenColor: c });
        }
      } else {
        socket.emit('playCard', { lobbyId, playerId, card });
      }
    };
    handEl.appendChild(d);
  });

  // UNO button
  unoBtn.style.display = (playerHand.length === 2 && playerId === currentPlayer) ? 'block' : 'none';
});

unoBtn.onclick = () => {
  socket.emit('callUno', { lobbyId, playerId });
  unoBtn.style.display = 'none';
};

socket.on('chatMessage', ({ sender, message }) => {
  const msgEl = document.createElement('div');
  msgEl.textContent = `${sender}: ${message}`;
  document.getElementById('messages').appendChild(msgEl);
});

sendChat.onclick = () => {
  const m = chatInput.value;
  if (m) {
    socket.emit('sendChat', { lobbyId, message: m });
    chatInput.value = '';
  }
};

socket.on('gameOver', ({ winner, roundPoints, totalScore }) => {
  alert(`🏆 ${winner} wins! +${roundPoints} pts. Total: ${totalScore} pts`);
  playerHand = [];
});
