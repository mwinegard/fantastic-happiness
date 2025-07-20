# UNO Multiplayer Game (Render Ready)

A fully featured UNO-style multiplayer game with:

- 🎴 Custom special cards (wild_boss, recycle, shopping, etc.)
- 💬 Chat and sound
- 🏆 Persistent leaderboard with `/scores.json`
- ⏱ Turn timeout and game auto-start
- 📦 Deployable on Render or any Node host

## 🚀 Deploy on Render

1. Push this project to GitHub.
2. Go to [https://render.com](https://render.com) > New Web Service.
3. Set:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Add a disk to persist `/opt/render/project/src/scores.json` (optional)
4. Done! Your game will auto-launch.

## Local Development

```bash
npm install
npm start
```

Visit http://localhost:3000 to play.

---
Have fun! 🎉