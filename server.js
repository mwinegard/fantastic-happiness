const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs-extra");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const LOBBIES = {};
const SCORES_FILE = path.join(__dirname, "scores.json");

// Load scores
let highScores = {};
if (fs.existsSync(SCORES_FILE)) {
  highScores = fs.readJsonSync(SCORES_FILE);
}

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// API for leaderboard
app.get("/api/leaderboard", (req, res) => {
  const sorted = Object.entries(highScores)
    .sort((a, b) => b[1] - a[1])
    .map(([name, score]) => ({ name, score }));
  res.json(sorted);
});

function saveScores() {
  fs.writeJsonSync(SCORES_FILE, highScores, { spaces: 2 });
}

function updatePlayerScore(name, scoreToAdd) {
  if (!highScores[name]) highScores[name] = 0;
  highScores[name] += scoreToAdd;
  saveScores();
}

io.on("connection", (socket) => {
  socket.on("updateScore", ({ playerName, score }) => {
    updatePlayerScore(playerName, score);
  });

  // Placeholder for full game logic to be added
});

server.listen(PORT, () => {
  console.log(`🎮 Server running on http://localhost:${PORT}`);
});
