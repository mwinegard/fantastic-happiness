/*
  game.js — Fantastic Happiness UNO client
  FIX: setVisible() must NOT set display="" for #game-screen, because CSS has #game-screen{display:none;}
*/

(() => {
  const socket = io();

  // ---------------- DOM ----------------
  const joinScreen = document.getElementById("join-screen");
  const gameScreen = document.getElementById("game-screen");

  const nameInput = document.getElementById("name");
  const lobbyInput = document.getElementById("lobby");
  const joinBtn = document.getElementById("joinbtn");

  const discardTop = document.getElementById("discard-top");
  const drawPile = document.getElementById("draw-pile");
  const colorBadge = document.getElementById("color-badge");
  const turnIndicator = document.getElementById("turn-indicator");

  const playerList = document.getElementById("player-list");
  const handRoot = document.getElementById("player-hand");

  const unoBtn = document.getElementById("uno-btn");
  const relaxBtn = document.getElementById("relax-btn");

  const chatLog = document.getElementById("chat-log");
  const chatInput = document.getElementById("chat-input");
  const chatSend = document.getElementById("chat-send");

  const leaderboardRoot = document.getElementById("leaderboard");
  const muteToggle = document.getElementById("mute-toggle");

  if (!joinScreen || !gameScreen || !nameInput || !lobbyInput || !joinBtn) {
    console.error("UNO UI missing required elements (index.html IDs).");
    return;
  }

  // ---------------- State ----------------
  let me = null; // { id, sid, name, lobby, spectator }
  let lastHand = [];
  let lastState = null;
  let muted = false;

  // ---------------- Utils ----------------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[m]));
  }

  function secsLeft(turnEndsAt) {
    if (!turnEndsAt) return null;
    return Math.max(0, Math.ceil((turnEndsAt - Date.now()) / 1000));
  }

  // ✅ FIXED: show must set an explicit display value
  function setVisible(el, yes, displayType = "block") {
    if (!el) return;
    el.style.display = yes ? displayType : "none";
  }

  // Server sends hand snapshots for some specials without .img
  function imgFromSnap(c) {
    if (!c) return "back.png";
    const color = String(c.color || "");
    const type = String(c.type || "");
    const value = c.value;

    const specialMap = {
      yellow_shopping: "yellow_shopping.png",
      yellow_pinkypromise: "yellow_pinkypromise.png",
      green_recycle: "green_recycle.png",
      blue_moon: "blue_moon.png",
      red_it: "red_it.png",
      red_noc: "red_noc.png",
      blue_look: "blue_look.png",
      green_happy: "green_happy.png",
      wild: "wild.png",
      wild_draw4: "wild_draw4.png",
      wild_relax: "wild_relax.png",
      wild_rainbow: "wild_rainbow.png",
      wild_boss: "wild_boss.png",
      wild_packyourbags: "wild_packyourbags.png",
    };
    if (specialMap[type]) return specialMap[type];

    if (type === "number" && typeof value === "number") return `${color}_${value}.png`;
    if (type === "skip") return `${color}_skip.png`;
    if (type === "reverse") return `${color}_reverse.png`;
    // Draw 2 image file is <color>_draw.png (NOT draw2.png)
    if (type === "draw2") return `${color}_draw.png`;
    return "back.png";
  }

  // ---------------- Toast (single reusable) ----------------
  let toastEl = null;
  let toastTimer = null;

  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "fh-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = String(msg || "");
    toastEl.classList.add("show");

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl && toastEl.classList.remove("show");
    }, 2400);
  }

  // ---------------- Sound ----------------
  const SOUND_KEYS = new Set([
    "draw", "joined", "lose", "number", "reverse", "skip", "special", "start", "uno", "wild", "win"
  ]);

  function playSound(key) {
    if (muted) return;
    const k = String(key || "").trim();
    if (!k) return;
    const file = SOUND_KEYS.has(k) ? `${k}.mp3` : `${k}.mp3`;
    const a = new Audio(`assets/sounds/${file}`);
    a.volume = 0.9;
    a.play().catch(() => {});
  }

  function setMuteUI() {
    if (!muteToggle) return;
    muteToggle.textContent = muted ? "🔇 Sound Off" : "🔊 Sound On";
    muteToggle.setAttribute("aria-label", muted ? "Sound off" : "Sound on");
  }

  if (muteToggle) {
    muteToggle.addEventListener("click", () => {
      muted = !muted;
      localStorage.setItem("uno_muted", muted ? "1" : "0");
      setMuteUI();
    });
  }

  // ---------------- Modals (standardized, layered) ----------------
  function openModal(title, bodyNode, actions) {
    const overlay = document.createElement("div");
    overlay.className = "fh-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "fh-modal";

    const header = document.createElement("div");
    header.className = "fh-modal-header";

    const h = document.createElement("h3");
    h.className = "fh-modal-title";
    h.textContent = title || "Action";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "fh-btn fh-btn-ghost";
    closeBtn.style.padding = "8px 10px";
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.onclick = () => overlay.remove();

    header.appendChild(h);
    header.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "fh-modal-body";
    body.appendChild(bodyNode);

    modal.appendChild(header);
    modal.appendChild(body);

    if (actions && actions.length) {
      const footer = document.createElement("div");
      footer.className = "fh-modal-actions";

      actions.forEach(a => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = a.primary ? "fh-btn fh-btn-primary" : "fh-btn fh-btn-ghost";
        b.textContent = a.label;
        b.onclick = () => a.onClick && a.onClick({ close: () => overlay.remove() });
        footer.appendChild(b);
      });

      modal.appendChild(footer);
    }

    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
    return { close: () => overlay.remove() };
  }

  // ---------------- Join flow ----------------
  function hydrateJoinForm() {
    nameInput.value = localStorage.getItem("uno_name") || "";
    lobbyInput.value = localStorage.getItem("uno_lobby") || "default";
    muted = localStorage.getItem("uno_muted") === "1";
    setMuteUI();
  }

  hydrateJoinForm();

  function doJoin() {
    const name = (nameInput.value || "").trim() || "Player";
    const lobby = (lobbyInput.value || "").trim() || "default";
    localStorage.setItem("uno_name", name);
    localStorage.setItem("uno_lobby", lobby);
    socket.emit("join", { name, lobby });
  }

  joinBtn.addEventListener("click", doJoin);
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });
  lobbyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });

  socket.on("me", (info) => {
    me = info;

    // ✅ FIX: explicitly show game screen as block
    setVisible(joinScreen, false);
    setVisible(gameScreen, true, "block");

    toast(`Joined lobby: ${me.lobby}`);
    playSound("joined");
    loadLeaderboard();
  });

  // ---------------- Chat ----------------
  function appendChatLine(html) {
    if (!chatLog) return;
    const line = document.createElement("div");
    line.innerHTML = html;
    chatLog.appendChild(line);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  if (chatSend && chatInput) {
    chatSend.addEventListener("click", () => {
      const text = (chatInput.value || "").trim();
      if (!text) return;
      socket.emit("chat", { text });
      chatInput.value = "";
    });
    chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") chatSend.click(); });
  }

  socket.on("chat", ({ fromName, text }) => {
    appendChatLine(`<b>${esc(fromName || "Player")}:</b> ${esc(text || "")}`);
  });

  socket.on("announce", (txt) => {
    appendChatLine(`<span style="opacity:.85">• ${esc(txt || "")}</span>`);
  });

  socket.on("warn", (msg) => {
    toast(msg || "Warning");
  });

  // ---------------- Actions ----------------
  if (drawPile) drawPile.addEventListener("click", () => socket.emit("drawCard"));
  if (unoBtn) unoBtn.addEventListener("click", () => socket.emit("callUno"));
  if (relaxBtn) relaxBtn.addEventListener("click", () => socket.emit("playRelaxRequested"));

  // ---------------- Render ----------------
  function setColorBadge(raw) {
    if (!colorBadge) return;
    const val = raw ? String(raw).toLowerCase() : "";
    colorBadge.classList.remove("color-red", "color-yellow", "color-green", "color-blue", "color-wild");
    if (val === "red") colorBadge.classList.add("color-red");
    else if (val === "yellow") colorBadge.classList.add("color-yellow");
    else if (val === "green") colorBadge.classList.add("color-green");
    else if (val === "blue") colorBadge.classList.add("color-blue");
    else if (val) colorBadge.classList.add("color-wild");
    colorBadge.textContent = val ? val.toUpperCase() : "—";
  }

  function renderPlayers(state) {
    if (!playerList) return;
    const ps = state.players || [];
    const currentSid = state.current;

    playerList.innerHTML = "";
    ps.forEach(p => {
      const row = document.createElement("div");
      row.className = "player";

      const left = document.createElement("div");
      left.className = "name";
      const isMe = me && p.sid === me.sid;
      left.innerHTML = `${isMe ? "⭐ " : ""}${esc(p.name || "Player")}${p.spectator ? " <span style='opacity:.7'>(spectator)</span>" : ""}`;

      const right = document.createElement("div");
      right.className = "meta";

      const isTurn = (p.sid === currentSid);
      right.textContent = isTurn ? "TURN" : "";

      row.appendChild(left);
      row.appendChild(right);
      playerList.appendChild(row);
    });
  }

  function renderTop(state) {
    const top = state.top;
    if (discardTop) {
      discardTop.src = top && top.img ? `assets/cards/${top.img}` : "assets/cards/back.png";
    }
    setColorBadge(state.color);
  }

  function renderTurn(state) {
    if (!turnIndicator) return;

    const ps = state.players || [];
    const cur = ps.find(p => p.sid === state.current);
    const curName = cur ? cur.name : "—";
    const isMyTurn = me && state.current === me.sid;

    const s = secsLeft(state.turnEndsAt);
    const timerTxt = (s == null) ? "" : ` • ⏳ ${s}s`;

    let penTxt = "";
    if (state.penalty && state.penalty.amount) {
      const target = ps.find(p => p.sid === state.penalty.targetSid);
      const who = target ? target.name : "someone";
      penTxt = ` • ⚠️ Stack: ${state.penalty.amount} on ${who}`;
    }

    turnIndicator.textContent =
      `${isMyTurn ? "👉 Your turn" : `Turn: ${curName}`}${timerTxt}${penTxt}`;
  }

  function renderHand(state, hand) {
    if (!handRoot) return;
    const isMyTurn = me && state.current === me.sid;

    handRoot.innerHTML = "";
    (hand || []).forEach((card, idx) => {
      const img = document.createElement("img");
      img.alt = card.type || "card";
      img.src = `assets/cards/${card.img || "back.png"}`;
      img.title = `${card.color || ""} ${card.type || ""}${typeof card.value === "number" ? " " + card.value : ""}`;

      if (!isMyTurn) {
        img.style.opacity = "0.65";
        img.style.pointerEvents = "none";
      }

      img.addEventListener("click", () => {
        if (!isMyTurn) return;
        socket.emit("playCard", { index: idx });
      });

      handRoot.appendChild(img);
    });
  }

  setInterval(() => {
    if (lastState) renderTurn(lastState);
  }, 250);

  socket.on("hand", (hand) => {
    lastHand = Array.isArray(hand) ? hand : [];
    if (lastState) renderHand(lastState, lastHand);
  });

  socket.on("state", (state) => {
    lastState = state || null;
    if (!lastState) return;

    // Seat swaps (Pack Your Bags) are server-authoritative.
    // Keep our local sid in sync with what the server reports.
    if (me && Array.isArray(lastState.players)) {
      const mine = lastState.players.find(p => p && p.id === me.id);
      if (mine && mine.sid && mine.sid !== me.sid) me.sid = mine.sid;
    }

    renderTop(lastState);
    renderPlayers(lastState);
    renderTurn(lastState);
    renderHand(lastState, lastHand);
  });

  socket.on("sound", (key) => playSound(key));

  // ---------------- Specials: chooseColor ----------------
  socket.on("chooseColor", () => {
    const body = document.createElement("div");
    const intro = document.createElement("div");
    intro.style.opacity = "0.9";
    intro.style.marginBottom = "12px";
    intro.textContent = "Pick the next color:";
    body.appendChild(intro);

    const colors = ["red", "yellow", "green", "blue"];
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.flexWrap = "wrap";
    row.style.gap = "10px";

    const modal = openModal("Choose Color", body, [
      { label: "Random", primary: false, onClick: ({ close }) => { socket.emit("colorChosen", { color: "random" }); close(); } }
    ]);

    colors.forEach(c => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "fh-btn fh-btn-primary";
      b.style.padding = "10px 12px";
      b.textContent = c.toUpperCase();
      b.onclick = () => {
        socket.emit("colorChosen", { color: c });
        modal.close();
      };
      row.appendChild(b);
    });

    body.appendChild(row);
  });

  // ---------------- Leaderboard ----------------
  async function loadLeaderboard() {
    if (!leaderboardRoot) return;
    try {
      const res = await fetch("/leaderboard", { cache: "no-store" });
      const data = await res.json();
      leaderboardRoot.innerHTML = renderBoard(Array.isArray(data) ? data : []);
    } catch {
      leaderboardRoot.textContent = "Failed to load leaderboard.";
    }
  }

  function renderBoard(rows) {
    const tr = r =>
      `<tr><td>${esc(r.name)}</td><td>${Number(r.wins || 0)}</td><td>${Number(r.points || 0)}</td></tr>`;
    return `<table><thead><tr><th>Name</th><th>Wins</th><th>Points</th></tr></thead><tbody>${rows.map(tr).join("")}</tbody></table>`;
  }

  setInterval(() => { if (me) loadLeaderboard(); }, 12000);
})();
