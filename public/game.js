// [public/game.js]

const socket = io();
const handDiv = document.getElementById("player-hand");
const drawPile = document.getElementById("draw-pile");
const discardPile = document.getElementById("discard-pile");
const playerList = document.getElementById("player-list");
const turnIndicator = document.getElementById("turn-indicator");
const unoButton = document.getElementById("uno-btn");
const wildButtons = document.getElementById("wild-color-buttons");
const chatLog = document.getElementById("chat-log");

const sounds = {
  special: new Audio("/assets/sounds/special.mp3")
};

socket.on("state", (state) => {
  const pid = socket.id;
  const hand = state.hands[pid] || [];

  turnIndicator.innerText = pid === state.currentTurn
    ? "It is your turn"
    : `Waiting for ${state.players.find(p => p.id === state.currentTurn)?.name}`;

  // Player list
  playerList.innerHTML = "";
  state.players.forEach(p => {
    const li = document.createElement("li");
    li.innerText = `${p.name} 🃏 ${p.handSize} (${p.score})`;
    playerList.appendChild(li);
  });

  // Player hand
  handDiv.innerHTML = "";
  hand.forEach(card => {
    const img = document.createElement("img");
    img.src = `/assets/cards/${card}.png`;
    img.className = "card";
    img.addEventListener("click", () => {
      const isSpecial = card.includes("moon") || card.includes("recycle") || card.includes("boss") || card.includes("noc") || card.includes("rainbow");
      if (isSpecial) sounds.special.play();

      if (card.startsWith("wild")) {
        wildButtons.style.display = "block";
        wildButtons.querySelectorAll("button").forEach(btn => {
          btn.onclick = () => {
            wildButtons.style.display = "none";
            socket.emit("playCard", {
              lobby: state.players[0].id,
              card,
              chosenColor: btn.dataset.color
            });
          };
        });
      } else {
        socket.emit("playCard", { lobby: state.players[0].id, card });
      }
    });
    handDiv.appendChild(img);
  });

  // Discard pile
  discardPile.innerHTML = "";
  const top = state.discardPile[state.discardPile.length - 1];
  const img = document.createElement("img");
  img.src = `/assets/cards/${top}.png`;
  img.className = "card";
  discardPile.appendChild(img);

  // Draw pile
  drawPile.innerHTML = "";
  const draw = document.createElement("img");
  draw.src = "/assets/cards/back.png";
  draw.className = "card stack";
  draw.addEventListener("click", () => {
    if (state.currentTurn === pid) {
      socket.emit("drawCard", { lobby: state.players[0].id });
    }
  });
  drawPile.appendChild(draw);
});

socket.on("chat", ({ from, message }) => {
  const div = document.createElement("div");
  div.innerHTML = `<strong>${from}:</strong> ${message}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});
