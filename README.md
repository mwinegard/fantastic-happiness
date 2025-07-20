# UNO Multiplayer Game

A custom UNO-style multiplayer card game with:

- Custom wild & action cards
- Leaderboard tracking with persistent scores
- Admin tools and sound testing
- Progressive Web App support
- Socket.io real-time game engine

## 🔧 Setup

```bash
npm install
npm start
```

Then open `http://localhost:3000` in your browser.

## 📁 Folder Structure

- `public/` - Client-side game UI
- `server.js` - Main server (Node.js + Express + Socket.io)
- `scores.json` - Auto-updated leaderboard storage
- `specialCards.js` - Custom server-side card effects

## 🧠 Game Features

- Auto-start on 2+ players
- Timeout handling & turn skipping
- UNO shout button
- Special cards (e.g. wild_boss, green_recycle, red_it)
- End of round winner scoring
- Final win at 500 points
- Persistent leaderboard (admin clear supported)

---

Have fun!