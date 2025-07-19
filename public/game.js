const socket = io();

const joinBtn = document.getElementById('joinBtn');
const chatInput = document.getElementById('chatInput');
const sendChat = document.getElementById('sendChat');

joinBtn.onclick = () => {
  const lobbyId = document.getElementById('lobbyId').value;
  const playerName = document.getElementById('playerName').value;
  if (lobbyId && playerName) {
    socket.emit('joinLobby', { lobbyId, playerName });
  }
};

socket.on('joinedLobby', ({ playerId }) => {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('game').style.display = 'block';
  document.getElementById('currentLobby').textContent = document.getElementById('lobbyId').value;
});

socket.on('updateLobby', ({ players }) => {
  const container = document.getElementById('players');
  container.innerHTML = '<h3>Players:</h3>';
  players.forEach(p => {
    container.innerHTML += `<div>${p.name}</div>`;
  });
});

sendChat.onclick = () => {
  const message = chatInput.value;
  const lobbyId = document.getElementById('lobbyId').value;
  if (message) {
    socket.emit('sendChat', { lobbyId, message });
    chatInput.value = '';
  }
};

socket.on('chatMessage', ({ sender, message }) => {
  const msgEl = document.createElement('div');
  msgEl.textContent = `${sender}: ${message}`;
  document.getElementById('messages').appendChild(msgEl);
});
