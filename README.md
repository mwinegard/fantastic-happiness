AI generated UNO game to test the capabilities of ai coding.

⸻

🎉 Fantastic Happiness UNO

A browser-based multiplayer UNO-style card game with sound effects, special cards, a working chat, UNO declarations, and spectator support.

⸻

📦 Features
	•	✅ Multiplayer game with 2–10 players
	•	✅ Single default lobby — just enter your name
	•	✅ Game starts automatically after 30-second countdown
	•	✅ Late joiners (up to 10 total) are added mid-game
	•	✅ Spectator mode for player 11+
	•	✅ Fully functional chat and SUE turn announcements
	•	✅ Accurate UNO card rules
	•	✅ Special cards: wild_boss, green_recycle
	•	✅ Players must press UNO when down to 1 card or face penalty
	•	✅ Turn timer with auto-draw and 3-strike timeout removal
	•	✅ Audio effects for all game events
	•	✅ Admin panel to manually trigger sounds

⸻

🚀 Setup

✅ Requirements
	•	Node.js
	•	A server (e.g. Render, Replit, or localhost)

📂 Folder Structure

project-root/
│
├── public/
│   ├── index.html
│   ├── game.js
│   ├── admin.html
│   ├── style.css
│   └── assets/
│       ├── cards/
│       │   ├── red_0.png, blue_draw2.png, wild.png, etc.
│       │   └── back.png
│       └── sounds/
│           ├── draw.mp3
│           ├── skip.mp3
│           ├── reverse.mp3
│           ├── wild.mp3
│           ├── special.mp3
│           ├── number.mp3
│           ├── win.mp3
│           ├── lose.mp3
│           ├── start.mp3
│           ├── joined.mp3
│           └── uno.mp3
│
├── server.js
├── scores.json
└── package.json


⸻

🔊 Sound Guide

Event	File	Description
Draw card	draw.mp3	Played when a player draws a card
Skip card	skip.mp3	Played when a skip is played
Reverse card	reverse.mp3	Played when a reverse is played
Wild card	wild.mp3	Basic wild or wild_draw4 card played
Special wild	special.mp3	For wild_* cards excluding basic
Number card	number.mp3	For normal cards like red_6
Round win	win.mp3	When a player wins the round
Round loss	lose.mp3	Everyone else when round ends
Game start	start.mp3	When game officially begins
Player joined	joined.mp3	Played when a new player joins
UNO declared	uno.mp3	When a player hits the UNO button


⸻

🛠 Admin Tools

Open admin.html in the browser to manually trigger any sound. This is useful for testing sound effects across all clients.

⸻

💾 Persistence
	•	Game scores are stored in scores.json
	•	Format: { "PlayerName": { "wins": 2, "points": 140 } }

⸻

✅ To Start the Game

npm install
node server.js

Then open http://localhost:3000 (or your deployed domain)

⸻

