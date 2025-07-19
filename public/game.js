const socket = io();

const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name");
const lobbyInput = document.getElementById("lobby");
const gameDiv = document.getElementById("game");
const handDiv = document.getElementById("player-hand");
const drawPile = document.getElementById("draw-pile");
const discardPile = document.getElementById("discard-pile");

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const lobby = lobbyInput.value.trim();
  if (name && lobby) {
    socket.emit("join", { name, lobby });
  }
});

socket.on("state", (state) => {
  document.getElementById("lobby-form").style.display = "none";
  gameDiv.style.display = "block";

  const playerId = socket.id;
  const hand = state.hands[playerId];

  handDiv.innerHTML = "";
  hand.forEach(card => {
    const img = document.createElement("img");
    img.src = `/assets/cards/${card}.png`;
    img.className = "card";
    img.addEventListener("click", () => {
      socket.emit("playCard", { lobby: state.players[0].id, card });
    });
    handDiv.appendChild(img);
  });

  discardPile.innerHTML = "";
  const topCard = state.discardPile[state.discardPile.length - 1];
  const topImg = document.createElement("img");
  topImg.src = `/assets/cards/${topCard}.png`;
  discardPile.appendChild(topImg);

  drawPile.innerHTML = "";
  const drawImg = document.createElement("img");
  drawImg.src = "/assets/cards/back.png";
  drawImg.className = "card";
  drawImg.addEventListener("click", () => {
    socket.emit("drawCard", { lobby: state.players[0].id });
  });
  drawPile.appendChild(drawImg);
});
