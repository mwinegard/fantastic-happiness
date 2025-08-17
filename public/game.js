// public/game.js
(function () {
  const socket = io();

  // ---------- DOM ----------
  const joinScreen = document.getElementById("join-screen");
  const gameScreen = document.getElementById("game-screen");

  const nameInput = document.getElementById("name");
  const lobbyInput = document.getElementById("lobby");
  const joinBtn = document.getElementById("joinbtn");

  const drawPile = document.getElementById("draw-pile");
  const discardTop = document.getElementById("discard-top");
  const colorBadge = document.getElementById("color-badge");
  const playerList = document.getElementById("player-list");
  const handDiv = document.getElementById("player-hand");
  const turnIndicator = document.getElementById("turn-indicator");

  const chatLog = document.getElementById("chat-log");
  const chatInput = document.getElementById("chat-input");
  const chatSend = document.getElementById("chat-send");

  const unoBtn = document.getElementById("uno-btn");
  const relaxBtn = document.getElementById("relax-btn");
  const muteBtn = document.getElementById("mute-toggle");

  const leaderboardDiv = document.getElementById("leaderboard");

  // ---------- Persisted ----------
  try {
    nameInput.value = localStorage.getItem("uno_name") || "";
    lobbyInput.value = localStorage.getItem("uno_lobby") || "default";
  } catch {}

  // ---------- Sounds (lightweight; inherits default button look) ----------
  const sounds = {
    draw: safeAudio("assets/sounds/draw.mp3"),
    skip: safeAudio("assets/sounds/skip.mp3"),
    reverse: safeAudio("assets/sounds/reverse.mp3"),
    wild: safeAudio("assets/sounds/wild.mp3"),
    win: safeAudio("assets/sounds/win.mp3"),
    joined: safeAudio("assets/sounds/joined.mp3"),
    uno: safeAudio("assets/sounds/uno.mp3"),
  };
  let muted = false;
  function safeAudio(src) {
    const a = new Audio();
    a.src = src;
    return a;
  }
  function playSound(name) {
    if (muted) return;
    const a = sounds[name];
    if (!a) return;
    try { a.currentTime = 0; a.play(); } catch {}
  }
  if (muteBtn) {
    muteBtn.onclick = () => {
      muted = !muted;
      muteBtn.textContent = muted ? "🔇 Sound Off" : "🔊 Sound On";
    };
  }

  // ---------- State ----------
  let me = { id: null, name: null, lobby: null, spectator: true };
  let state = {
    started: false,
    countdownEndsAt: null,
    turnEndsAt: null,
    color: null,
    value: null,
    current: null,
    direction: 1,
    top: null,
    penalty: null,
    players: [],
  };

  // NOTE: Hands are server-authoritative and not mirrored here.
  // We leave visual hand rendering minimal to preserve look & feel.

  // ---------- Join ----------
  function doJoin() {
    const name = nameInput.value.trim() || "Player";
    const lobby = (lobbyInput.value.trim() || "default").slice(0, 24);
    try {
      localStorage.setItem("uno_name", name);
      localStorage.setItem("uno_lobby", lobby);
    } catch {}
    socket.emit("join", { name, lobby });
  }
  joinBtn.onclick = doJoin;
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });
  lobbyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });

  // ---------- Socket events ----------
  socket.on("me", (m) => {
    me = m || me;
    joinScreen.style.display = "none";
    gameScreen.style.display = "block";
    playSound("joined");
  });

  socket.on("announce", (text) => {
    appendLog(text);
    // sound cues
    if (/Round Winner/i.test(text)) playSound("win");
    if (/called UNO/i.test(text)) playSound("uno");
    if (/Skip/i.test(text)) playSound("skip");
    if (/reversed/i.test(text)) playSound("reverse");
    if (/Color →/i.test(text)) playSound("wild");
    if (/drew 1 card/i.test(text) || /drew \d+ \(stack ended\)/i.test(text)) playSound("draw");
  });

  socket.on("warn", (msg) => {
    appendLog(String(msg || "⚠️").replace(/^/, "⚠️ "));
  });

  socket.on("chat", ({ fromName, text }) => {
    const d = document.createElement("div");
    d.textContent = `${fromName}: ${text}`;
    chatLog.appendChild(d);
    chatLog.scrollTop = chatLog.scrollHeight;
  });

  socket.on("state", (s) => {
    state = s || state;
    render();
  });

  // ------ COLOR selection (for all wild specials; server calls this AFTER the effect) ------
  socket.on("chooseColor", () => {
    const c = (prompt("Pick a color (red, blue, green, yellow):", "") || "").trim().toLowerCase();
    socket.emit("colorChosen", { color: c });
  });

  // ------ SPECIAL prompts (client inputs; server authoritative) ------
  // LOOK (top 4 order)
  socket.on("lookTop", ({ cards }) => {
    // cards: [{i,color,type,value}]
    const list = (cards || []).map(c => `${c.i}:${c.color} ${c.type}${c.value != null ? " " + c.value : ""}`).join(", ");
    const def = (cards || []).map(c => c.i).join(",");
    const ans = prompt(`Reorder TOP cards by indices (comma separated).\nTop-most is LAST in list.\nAvailable: ${list}`, def);
    const order = String(ans || "").split(",").map(x => Number(x.trim())).filter(Number.isInteger);
    socket.emit("lookTopOrder", { order });
  });

  // SHOPPING (target -> give two -> take one)
  socket.on("shoppingChooseTarget", ({ targets }) => {
    // targets: [{sid,name}]
    const label = (targets || []).map(t => `${t.sid}:${t.name}`).join(", ");
    const sid = prompt(`Pick target SID for Shopping:\n${label}`, (targets && targets[0] && targets[0].sid) || "");
    socket.emit("shoppingTargetChosen", { sid });
  });
  socket.on("shoppingPickGive", ({ hand }) => {
    // hand: my hand snapshot [{i,color,type,value}]
    const label = (hand || []).map(h => `${h.i}:${h.color} ${h.type}${h.value != null ? " " + h.value : ""}`).join(", ");
    const ans = prompt(`Pick TWO indices from your hand to GIVE (comma separated):\n${label}`, "");
    const parts = String(ans || "").split(",").map(x => Number(x.trim()));
    const [idx1, idx2] = parts;
    socket.emit("shoppingGiveChosen", { idx1, idx2 });
  });
  socket.on("shoppingPickTake", ({ hand }) => {
    // hand: target's hand snapshot
    const label = (hand || []).map(h => `${h.i}:${h.color} ${h.type}${h.value != null ? " " + h.value : ""}`).join(", ");
    const ans = prompt(`Pick ONE index from target's hand to TAKE:\n${label}`, "");
    const idx = Number(ans);
    socket.emit("shoppingTakeChosen", { idx });
  });

  // RECYCLE pick (if you later expose options; currently server redistributes globally)
  socket.on("recyclePick", ({ cards }) => {
    // For your current server implementation, this is not used (global redistribute).
    // Left here for compatibility if you ever switch to a "choose from discard" variant.
    const label = (cards || []).map(c => `${c.idx}:${c.color} ${c.type}${c.value != null ? " " + c.value : ""}`).join(", ");
    const def = (cards && cards[cards.length - 1] && cards[cards.length - 1].idx) || 0;
    const ans = prompt(`Pick one card from discard to take back:\n${label}`, def);
    socket.emit("recycleChosen", { idx: Number(ans) });
  });

  // PINKY PROMISE target
  socket.on("promiseChooseTarget", ({ targets }) => {
    const label = (targets || []).map(t => `${t.sid}:${t.name}`).join(", ");
    const sid = prompt(`Pick target SID for Pinky Promise:\n${label}`, (targets && targets[0] && targets[0].sid) || "");
    socket.emit("promiseTargetChosen", { sid });
  });

  // IT target (seat-relative is server-side; this is here if you ever expose manual override)
  socket.on("itChooseTarget", ({ targets }) => {
    const label = (targets || []).map(t => `${t.sid}:${t.name}`).join(", ");
    const sid = prompt(`Pick IT target (optional flow):\n${label}`, (targets && targets[0] && targets[0].sid) || "");
    socket.emit("itTargetChosen", { sid });
  });

  // RAINBOW picks (indices of 1 card per color)
  socket.on("rainbowPick", ({ hand }) => {
    const label = (hand || []).map(h => `${h.i}:${h.color} ${h.type}${h.value != null ? " " + h.value : ""}`).join(", ");
    const ans = prompt(
      `Pick indices for one of each color (comma separated; order doesn't matter):\n${label}`,
      ""
    );
    const indices = String(ans || "")
      .split(",")
      .map(x => Number(x.trim()))
      .filter(Number.isInteger);
    socket.emit("rainbowChosen", { indices });
  });

  // ---------- UI Actions ----------
  drawPile.onclick = () => socket.emit("drawCard");
  unoBtn.onclick = () => socket.emit("callUno");
  relaxBtn.onclick = () => socket.emit("playRelaxRequested");

  chatSend.onclick = sendChat;
  chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

  function sendChat() {
    const txt = chatInput.value.trim();
    if (!txt) return;
    socket.emit("chat", { text: txt });
    chatInput.value = "";
  }

  // ---------- Render ----------
  function render() {
    const { started, countdownEndsAt, turnEndsAt, color, current, top, players, penalty } = state;

    // color + top card
    colorBadge.textContent = color ? color.toUpperCase() : "—";
    discardTop.src = top ? `assets/cards/${top.img}` : "assets/cards/back.png";
    drawPile.src = "assets/cards/back.png";

    // timer / turn indicator
    if (!started && countdownEndsAt) {
      turnIndicator.textContent = `Game starts in ${secs(countdownEndsAt - Date.now())}s`;
    } else if (started && turnEndsAt) {
      const mine = current === me.id;
      const t = secs(turnEndsAt - Date.now());
      turnIndicator.textContent = mine ? `Your move: ${t}s` : `Waiting…`;
    } else {
      turnIndicator.textContent = "—";
    }

    // players list
    playerList.innerHTML = "";
    (players || []).forEach((p) => {
      const row = document.createElement("div");
      row.className = "row";
      const s = document.createElement("span");
      s.textContent = p.name + (p.sid === current ? " ←" : "");
      const m = document.createElement("span");
      m.textContent = p.spectator ? "👀" : "";
      row.appendChild(s);
      row.appendChild(m);
      playerList.appendChild(row);
    });

    // hand area is intentionally minimal (no card sprites for hands to preserve current UX)
    handDiv.innerHTML = ""; // keep empty / reserved

    // button enables (server is authoritative; client just hints)
    const myTurn = started && current === me.id;
    unoBtn.disabled = !myTurn; // server enforces real UNO rule
    const penaltyActive = !!penalty;
    relaxBtn.disabled = !(started && (myTurn || penaltyActive));

    // leaderboard
    refreshLeaderboard();
  }

  // ---------- Helpers ----------
  function appendLog(text) {
    const d = document.createElement("div");
    d.textContent = String(text || "");
    chatLog.appendChild(d);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function secs(ms) {
    return Math.max(0, Math.ceil((+ms || 0) / 1000));
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }

  // ---------- Leaderboard ----------
  let lastLeaderboardAt = 0;
  async function refreshLeaderboard(force = false) {
    const now = Date.now();
    if (!force && now - lastLeaderboardAt < 3000) return;
    lastLeaderboardAt = now;
    try {
      const res = await fetch("/leaderboard", { cache: "no-store" });
      const data = await res.json();
      leaderboardDiv.innerHTML = renderLeaderboard(data || []);
    } catch {
      // ignore
    }
  }
  function renderLeaderboard(rows) {
    const cells = (r) =>
      `<tr><td>${escapeHtml(r.name)}</td><td>${Number(r.wins || 0)}</td><td>${Number(r.points || 0)}</td></tr>`;
    return `<table><thead><tr><th>Name</th><th>Wins</th><th>Points</th></tr></thead><tbody>${rows
      .map(cells)
      .join("")}</tbody></table>`;
  }

  // warm initial leaderboard
  refreshLeaderboard(true);
})();
