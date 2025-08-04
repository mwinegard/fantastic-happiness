# Fantastic Happiness UNO

A web-based multiplayer UNO-style game with special cards and persistent scores.

## 🔧 Getting Started

1. Install dependencies:
   ```bash
   npm install

   

🎮 Gameplay Overview
	•	Join a lobby by entering a name and lobby code.
	•	The game starts automatically when 2+ players join.
	•	Play UNO rules with added special cards and a live chat feature.
	•	Win by playing all your cards first.

🃏 Special Cards

In addition to regular UNO cards, the deck includes:
	•	wild_boss – Steal a card from every other player.
	•	green_recycle – Shuffle all hands and redistribute evenly.
	•	(Additional custom cards can be added similarly.)

🛠️ Game Rules and Logic
	•	Skip: Skips the next player.
	•	Reverse: Reverses turn order. In 2-player games, acts as Skip.
	•	Draw Two: Next player draws 2 and skips.
	•	Wild Draw Four: Next player draws 4 and skips. Player chooses color.
	•	Wild: Player chooses color.
	•	Wild special cards: May include unique effects like redistributing hands or stealing cards.

🔒 Mid-game Join Restrictions
	•	Players cannot join once the game has started. They must wait for the next round.

🔌 Disconnect Handling
	•	Disconnected players are removed.
	•	If only one player remains, they automatically win.
	•	Turn order is adjusted if the current player disconnects.

🏆 Leaderboard
	•	Persistent score tracking.
	•	Points are awarded based on remaining cards:
	•	Number cards: 10 pts
	•	Action cards: 20 pts
	•	Wilds & special cards: 50 pts

📁 Files
	•	server.js: Game server logic (Node + Socket.IO)
	•	public/: Frontend assets and HTML
	•	scores.json: Persistent score tracking
	•	assets/cards/: All card images
	•	assets/sounds/: (Optional) sound effects

💡 Tips
	•	All player actions (card play, draw, win) are synced live.
	•	The game supports mobile-friendly layout and chat.
	•	The admin panel (/admin.html) shows raw score data.

⸻

Enjoy and play responsibly! 🎉
