const socket = io();

let playerId = null;
let currentPlayerId = null;
let lobbyId = '';
let playerHand = [];

document.getElementById('joinBtn').onclick = () => {
  lobbyId = document.getElementById('lobbyId').value;
  const playerName = document.getElementById('playerName').value;
  if (lobbyId && playerName) {
    socket.emit('joinLobby', { lobbyId, playerName });
  }
};

socket.on('joinedLobby', (data) => {
  playerId = data.playerId;
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('game').style.display = 'block';
  document.getElementById('currentLobby').textContent = lobbyId;
});

socket.on('updateLobby', ({ players }) => {
  const container = document.getElementById('players');
  container.innerHTML = '<h3>Players:</h3>';
  players.forEach(p => {
    container.innerHTML += `<div>${p.name}</div>`;
  });
});

socket.on('gameState', ({ pile, players, currentPlayer }) => {
  currentPlayerId = currentPlayer;

  // Render players
  const playerList = document.getElementById('players');
  playerList.innerHTML = `<h3>Players:</h3>`;
  players.forEach(p => {
    const isTurn = p.id === currentPlayer ? '🟢' : '';
    playerList.innerHTML += `<div>${p.name} (${p.handSize} cards) ${isTurn}</div>`;
  });

  // Render top card
  const top = pile[pile.length - 1];
  const topEl = document.getElementById('topCard');
  topEl.textContent = `${top.color.toUpperCase()} ${top.value}`;
  topEl.style.color = top.color === 'black' ? 'purple' : top.color;

  // Render hand
  const handEl = document.getElementById('hand');
  handEl.innerHTML = '';
  playerHand.forEach((card, index) => {
    const cardBtn = document.createElement('button');
    cardBtn.textContent = `${card.color.toUpperCase()} ${card.value}`;
    cardBtn.style.margin = '5px';
    cardBtn.style.backgroundColor = card.color === 'black' ? '#444' : card.color;
    cardBtn.onclick = () => {
      socket.emit('playCard', { lobbyId, playerId, card });
    };
    handEl.appendChild(cardBtn);
  });
});

socket.on('gameOver', ({ winner }) => {
  alert(`🎉 ${winner} has won the game!`);
});

socket.on('chatMessage', ({ sender, message }) => {
  const msgEl = document.createElement('div');
  msgEl.textContent = `${sender}: ${message}`;
  document.getElementById('messages').appendChild(msgEl);
});

document.getElementById('sendChat').onclick = () => {
  const message = document.getElementById('chatInput').value;
  if (message) {
    socket.emit('sendChat', { lobbyId, message });
    document.getElementById('chatInput').value = '';
  }
};
