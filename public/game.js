const socket = io();
let playerId, currentPlayerId, lobbyId = '';
let playerHand = [];

const joinBtn = document.getElementById('joinBtn');
const unoBtn = document.getElementById('unoBtn');
const chatInput = document.getElementById('chatInput');
const sendChat = document.getElementById('sendChat');

joinBtn.onclick = () => {
  lobbyId = document.getElementById('lobbyId').value.trim();
  const name = document.getElementById('playerName').value.trim();
  if (lobbyId && name) socket.emit('joinLobby', { lobbyId, playerName: name });
};

socket.on('joinedLobby', ({ playerId: id }) => {
  playerId = id;
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('game').style.display = 'block';
  document.getElementById('currentLobby').textContent = lobbyId;
  console.log('✅ Joined as', id);
});

socket.on('gameState', data => {
  console.log('🏷️ gameState:', data);
  currentPlayerId = data.currentPlayer;
  const me = data.players.find(p => p.id === playerId);
  if (me) playerHand = me.hand;

  const playersEl = document.getElementById('players');
  playersEl.innerHTML = '<h3>Players:</h3>';
  data.players.forEach(p => {
    playersEl.innerHTML += `<div>${p.name} (${p.handSize} cards, ${p.score} pts) ${p.id === currentPlayerId ? '🟢' : ''}</div>`;
  });

  clearInterval(window.timerInterval);
  if (playerId === currentPlayerId) {
    let sec = 60;
    window.timerInterval = setInterval(() => {
      document.getElementById('topCard').textContent = `Your Turn - ${sec--}s`;
      if (sec < 0) clearInterval(window.timerInterval);
    }, 1000);
  }

  const top = data.pile[data.pile.length - 1];
  const topEl = document.getElementById('topCard');
  topEl.textContent = top.value;
  topEl.className = `card ${top.color}`;

  const handEl = document.getElementById('hand');
  handEl.innerHTML = '';
  playerHand.forEach(card => {
    const el = document.createElement('div');
    el.className = `card ${card.color}`;
    el.textContent = card.value;
    el.onclick = () => {
      const payload = { lobbyId, playerId, card };
      if (card.color === 'black') {
        const chosen = prompt('Choose color: red, green, blue, yellow').trim();
        if (['red','green','blue','yellow'].includes(chosen)) payload.chosenColor = chosen;
        else return;
      }
      socket.emit('playCard', payload);
    };
    handEl.appendChild(el);
  });

  unoBtn.style.display = (playerHand.length === 2 && playerId === currentPlayerId) ? 'block' : 'none';
});

unoBtn.onclick = () => {
  socket.emit('callUno', { lobbyId, playerId });
  unoBtn.style.display = 'none';
};

socket.on('chatMessage', ({ sender, message }) => {
  const el = document.createElement('div');
  el.textContent = `${sender}: ${message}`;
  document.getElementById('messages').appendChild(el);
});

sendChat.onclick = () => {
  const m = chatInput.value.trim();
  if (m) {
    socket.emit('sendChat', { lobbyId, message: m });
    chatInput.value = '';
  }
};

socket.on('gameOver', ({ winner, roundPoints, totalScore }) => {
  alert(`🏆 ${winner} wins! +${roundPoints} pts (Total: ${totalScore})`);
});
