// public/specialCards.js

export const specialCardLogic = {
  // Wild Cards
  "wild_boss": (lobby, currentPlayerId, io) => {
    const message = `🎁 THE BOSS: ${lobby.players[currentPlayerId].name} receives a card from each player!`;
    io.to(lobby.id).emit("chat", { from: "SUE", message });
    Object.keys(lobby.players).forEach(pid => {
      if (pid !== currentPlayerId && lobby.hands[pid]?.length) {
        const givenCard = lobby.hands[pid].pop();
        lobby.hands[currentPlayerId].push(givenCard);
      }
    });
  },

  "wild_packyourbags": (lobby, currentPlayerId, io) => {
    const message = `🎒 PACK YOUR BAGS: All players switch hands randomly!`;
    io.to(lobby.id).emit("chat", { from: "SUE", message });
    const hands = Object.values(lobby.hands);
    const pids = Object.keys(lobby.hands);
    const shuffled = hands.sort(() => Math.random() - 0.5);
    pids.forEach((pid, idx) => {
      lobby.hands[pid] = shuffled[idx];
    });
  },

  "wild_rainbow": (lobby, currentPlayerId, io) => {
    const message = `🌈 RAINBOW: ${lobby.players[currentPlayerId].name} must discard one of each color or draw until they can!`;
    io.to(lobby.id).emit("chat", { from: "SUE", message });
    // Implement real discard logic later
  },

  "wild_relax": (lobby, currentPlayerId, io) => {
    const message = `🛀 RELAX: Draw card was blocked. Continue play.`;
    io.to(lobby.id).emit("chat", { from: "SUE", message });
    // Should be handled at draw prevention time
  },

  // Color-based Cards
  "blue_look": (lobby, currentPlayerId, io) => {
    const topFour = lobby.deck.splice(-4);
    io.to(lobby.id).emit("chat", {
      from: "SUE",
      message: `👁️ LOOK: Top 4 draw cards rearranged by ${lobby.players[currentPlayerId].name}`
    });
    // Add a prompt for ordering if UI needed
    lobby.deck.push(...topFour); // Put back for now
  },

  "blue_moon": (lobby, currentPlayerId, io) => {
    const message = `🌙 TO THE MOON: Card tossed to closest player. (Manual in physical game)`;
    io.to(lobby.id).emit("chat", { from: "SUE", message });
  },

  "green_happy": (lobby, currentPlayerId, io) => {
    const message = `😊 HAPPY activated: Chat monitored for rude words. Rude? button available!`;
    lobby.happyActive = true;
    io.to(lobby.id).emit("chat", { from: "SUE", message });
  },

  "green_recycle": (lobby, currentPlayerId, io) => {
    const message = `♻️ RECYCLE: All hands shuffled and redistributed.`;
    io.to(lobby.id).emit("chat", { from: "SUE", message });
    const allCards = Object.values(lobby.hands).flat();
    const shuffled = allCards.sort(() => Math.random() - 0.5);
    const pids = Object.keys(lobby.players);
    const handSize = Math.floor(shuffled.length / pids.length);
    pids.forEach((pid, i) => {
      lobby.hands[pid] = shuffled.splice(0, handSize);
    });
  },

  "red_noc": (lobby, currentPlayerId, io) => {
    const pids = Object.keys(lobby.players);
    const rand = pids[Math.floor(Math.random() * pids.length)];
    const message = `📩 NOC NOTICE: ${lobby.players[rand].name} receives 3 cards.`;
    io.to(lobby.id).emit("chat", { from: "SUE", message });
    lobby.hands[rand].push(...lobby.deck.splice(0, 3));
  },

  "red_it": (lobby, currentPlayerId, io) => {
    const pids = Object.keys(lobby.players);
    const curIdx = pids.indexOf(currentPlayerId);
    const nextId = pids[(curIdx + 1) % pids.length];
    const prevId = pids[(curIdx - 1 + pids.length) % pids.length];
    if (lobby.hands[prevId]?.length) {
      const idx = Math.floor(Math.random() * lobby.hands[prevId].length);
      const card = lobby.hands[prevId].splice(idx, 1)[0];
      lobby.hands[nextId].push(card);
      const message = `🎈 IT: Card floated from ${lobby.players[prevId].name} to ${lobby.players[nextId].name}`;
      io.to(lobby.id).emit("chat", { from: "SUE", message });
    }
  },

  "yellow_pinkypromise": (lobby, currentPlayerId, io) => {
    const pids = Object.keys(lobby.players).filter(id => id !== currentPlayerId);
    const other = pids[Math.floor(Math.random() * pids.length)];
    const cards = [...lobby.hands[currentPlayerId], ...lobby.hands[other]];
    const shuffled = cards.sort(() => Math.random() - 0.5);
    const size = Math.floor(shuffled.length / 2);
    lobby.hands[currentPlayerId] = shuffled.slice(0, size);
    lobby.hands[other] = shuffled.slice(size);
    const message = `💞 PINKY PROMISE: ${lobby.players[currentPlayerId].name} and ${lobby.players[other].name} reshuffled hands!`;
    io.to(lobby.id).emit("chat", { from: "SUE", message });
  },

  "yellow_shopping": (lobby, currentPlayerId, io) => {
    const pids = Object.keys(lobby.players).filter(id => id !== currentPlayerId);
    const target = pids[Math.floor(Math.random() * pids.length)];
    const message = `🛍️ SHOPPING: ${lobby.players[currentPlayerId].name} browsed ${lobby.players[target].name}'s hand.`;
    io.to(lobby.id).emit("chat", { from: "SUE", message });
    // Real UI swap logic would go here
  }
};
