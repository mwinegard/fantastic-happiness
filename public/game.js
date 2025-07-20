const socket = io();
let playerId, currentLobby;

const loginSection = document.getElementById("login");
const gameSection = document.getElementById("game");
const nameInput = document.getElementById("name");
const lobbyInput = document.getElementById("lobby");
const joinBtn = document.getElementById("join");
const handDiv = document.getElementById("hand");
const discardImg = document.getElementById("discard");
const drawBtn = document.getElementById("draw-btn");
const leaveBtn = document.getElementById("leave-btn");
const wildButtons = document.getElementById("wild-buttons");
const chatInput = document.getElementById("chat-input");
const chatBtn = document.getElementById("chat-btn");
const chatBox = document.getElementById("chat-box");
const unoButton = document.getElementById("uno-btn");

joinBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  const lobby = lobbyInput.value.trim();
  if (!name || !lobby) return;

  playerId = socket.id;
  currentLobby = lobby;
  socket.emit("join", { name, lobby });
  loginSection.style.display = "none";
  gameSection.style.display = "block";
});

socket.on("state", state => {
  handDiv.innerHTML = "";

  const hand = state.hands[playerId] || [];
  if (!state.hasStarted) {
    for (let i = 0; i < 7; i++) {
      const img = document.createElement("img");
      img.src = "/assets/cards/back.png";
      img.className = "card disabled";
      handDiv.appendChild(img);
    }
  } else {
    hand.forEach(card => {
      const img = document.createElement("img");
      img.src = `/assets/cards/${card}.png`;
      img.className = "card";

      const isRainbow = card === "wild_rainbow";
      const hasColors = ["red", "green", "blue", "yellow"].every(color =>
        hand.some(c => c.startsWith(color))
      );

      if (isRainbow && !hasColors) {
        img.classList.add("disabled");
        return;
      }

      img.addEventListener("click", () => {
        if (state.currentTurn !== playerId || !state.hasStarted) return;

        if (card.startsWith("wild")) {
          wildButtons.style.display = "flex";
          wildButtons.querySelectorAll("button").forEach(btn => {
            btn.onclick = () => {
              wildButtons.style.display = "none";
              socket.emit("playCard", {
                lobby: currentLobby,
                card,
                chosenColor: btn.dataset.color
              });
              playSound("wild");
            };
          });
        } else {
          socket.emit("playCard", { lobby: currentLobby, card });

          if (card.includes("draw")) playSound("draw");
          else if (card.includes("skip")) playSound("skip");
          else if (card.includes("reverse")) playSound("reverse");
          else if (card.startsWith("wild_")) playSound("special");
          else playSound("number");
        }
      });

      handDiv.appendChild(img);
    });
  }

  const discard = state.discardPile[state.discardPile.length - 1];
  discardImg.src = discard ? `/assets/cards/${discard}.png` : "";
});

drawBtn.addEventListener("click", () => {
  socket.emit("drawCard", { lobby: currentLobby });
});

leaveBtn.addEventListener("click", () => {
  location.reload();
});

chatBtn.addEventListener("click", () => {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit("chat", { message: msg });
  chatInput.value = "";
});

socket.on("chat", ({ from, message }) => {
  const div = document.createElement("div");
  div.textContent = `${from}: ${message}`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
});

unoButton.addEventListener("click", () => {
  socket.emit("uno", { lobby: currentLobby });
  playSound("uno");
});

function playSound(type) {
  const audio = new Audio(`/assets/sounds/${type}.mp3`);
  audio.play();
}

// leaderboard modal logic
const leaderboardBtnList = document.querySelectorAll("#leaderboard-toggle");
const leaderboardModal = document.getElementById("leaderboard-modal");
const leaderboardClose = document.getElementById("leaderboard-close");

leaderboardBtnList.forEach(btn => {
  btn.addEventListener("click", () => {
    leaderboardModal.style.display = "flex";
    loadLeaderboard();
  });
});

leaderboardClose.addEventListener("click", () => {
  leaderboardModal.style.display = "none";
});

function loadLeaderboard() {
  fetch('/scores')
    .then(res => res.json())
    .then(data => {
      const container = document.getElementById("leaderboard-container");
      if (!data.length) {
        container.innerHTML = "<p>No scores yet.</p>";
        return;
      }

      const headers = ["Name", "Wins", "Score"];
      const rows = data.map(row => `
        <tr>
          <td>${row.name}</td>
          <td>${row.wins || 0}</td>
          <td>${row.score || 0}</td>
        </tr>
      `).join("");

      container.innerHTML = `
        <table>
          <thead>
            <tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    });
}
