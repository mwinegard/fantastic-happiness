const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const io = new Server(server);
const PORT = process.env.PORT || 3000;

let lobbies = {};
const scoresFile = path.join(__dirname, "scores.json");

app.use(express.static("public"));
app.get("/scores.json", (_, res) => res.sendFile(scoresFile));

function loadScores() {
  try { return JSON.parse(fs.readFileSync(scoresFile)); } catch { return {}; }
}
function saveScores(data) {
  fs.writeFileSync(scoresFile, JSON.stringify(data, null, 2));
}
function updateScore(name, points) {
  const scores = loadScores();
  scores[name] = (scores[name] || 0) + points;
  saveScores(scores);
}

io.on("connection", (socket) => {
  socket.on("joinLobby", ({ name, lobby }) => {
    if (!lobbies[lobby]) {
      lobbies[lobby] = { id: lobby, players: [], started: false, topCard: null };
    }
    const game = lobbies[lobby];
    if (game.players.length >= 10) {
      socket.emit("lobbyFull");
      return;
    }
    socket.lobbyId = lobby;
    const player = { id: socket.id, name, hand: [], score: 0 };
    game.players.push(player);
    io.to(lobby).emit("chat", { sender: "SUE", message: `${name} joined the game.` });
    socket.join(lobby);
    io.to(lobby).emit("updateState", game);
  });

  socket.on("chat", ({ sender, message, lobby }) => {
    io.to(lobby).emit("chat", { sender, message });
  });

  socket.on("playCard", ({ name, lobby, index }) => {
    const game = lobbies[lobby];
    const player = game.players.find(p => p.name === name);
    const card = player.hand.splice(index, 1)[0];
    game.topCard = card;
    if (player.hand.length === 0) {
      let points = 0;
      for (const p of game.players) {
        if (p.id !== player.id) {
          for (let c of p.hand) {
            if (c.includes("draw4") || c.includes("wild")) points += 50;
            else if (c.includes("draw") || c.includes("reverse") || c.includes("skip")) points += 20;
            else {
              const val = parseInt(c.split("_")[1]);
              points += isNaN(val) ? 0 : val;
            }
          }
        }
      }
      updateScore(name, points);
      io.to(lobby).emit("chat", { sender: "SUE", message: `🎉 ${name} is the Champion! +${points} points!` });
      delete lobbies[lobby];
    } else {
      io.to(lobby).emit("updateState", game);
    }
  });
});

server.listen(PORT, () => console.log("Server running on port", PORT));
