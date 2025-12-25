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

  // ---------------- Specials: Blue Look (reorder top of deck) ----------------
  socket.on("lookTop", ({ cards }) => {
    const list = Array.isArray(cards) ? cards : [];
    if (!list.length) return;

    const picked = [];
    const used = new Set();

    const body = document.createElement("div");
    const p = document.createElement("div");
    p.style.marginBottom = "10px";
    p.style.opacity = "0.9";
    p.textContent = "Tap cards in the order you want them to be drawn (1st tap = next draw).";
    body.appendChild(p);

    const grid = document.createElement("div");
    grid.style.display = "flex";
    grid.style.gap = "10px";
    grid.style.flexWrap = "wrap";

    const status = document.createElement("div");
    status.style.marginTop = "10px";
    status.style.fontWeight = "800";
    const updateStatus = () => {
      status.textContent = `Selected: ${picked.length}/${list.length}`;
    };
    updateStatus();

    const modal = openModal("Blue Look — Reorder", body, [
      { label: "Keep Unchanged", primary: false, onClick: ({ close }) => { socket.emit("lookTopOrder", { order: list.map(c => c.i) }); close(); } },
      { label: "Reset", primary: false, onClick: () => { picked.length = 0; used.clear(); Array.from(grid.children).forEach(el => el.removeAttribute("data-picked")); updateStatus(); } },
      { label: "Confirm Order", primary: true, onClick: ({ close }) => { socket.emit("lookTopOrder", { order: picked.slice() }); close(); } }
    ]);

    // Show from top → down (server uses deck.pop, so last is top)
    const show = list.slice().reverse();
    show.forEach((c) => {
      const img = document.createElement("img");
      img.className = "fh-cardimg";
      img.style.width = "84px";
      img.style.height = "auto";
      img.style.cursor = "pointer";
      img.src = `assets/cards/${imgFromSnap(c)}`;
      img.title = "Tap to add to order";
      img.onclick = () => {
        if (used.has(c.i)) return;
        used.add(c.i);
        picked.push(c.i);
        img.setAttribute("data-picked", "1");
        img.style.outline = "3px solid rgba(255,255,255,.5)";
        img.style.outlineOffset = "2px";
        updateStatus();
        if (picked.length === list.length) {
          // auto-confirm if complete
          socket.emit("lookTopOrder", { order: picked.slice() });
          modal.close();
        }
      };
      grid.appendChild(img);
    });

    body.appendChild(grid);
    body.appendChild(status);
  });

  // ---------------- Specials: Yellow Shopping ----------------
  socket.on("shoppingChooseTarget", ({ targets }) => {
    const ts = Array.isArray(targets) ? targets : [];
    const body = document.createElement("div");
    body.textContent = "Choose who to shop with:";
    const wrap = document.createElement("div");
    wrap.style.display = "grid";
    wrap.style.gap = "10px";
    wrap.style.marginTop = "12px";
    body.appendChild(wrap);

    const modal = openModal("Shopping — Choose Target", body, []);
    ts.forEach(t => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "fh-btn fh-btn-primary";
      b.textContent = t.name || t.sid;
      b.onclick = () => { socket.emit("shoppingTargetChosen", { sid: t.sid }); modal.close(); };
      wrap.appendChild(b);
    });
  });

  socket.on("shoppingPickGive", ({ hand }) => {
    const h = Array.isArray(hand) ? hand : [];
    const chosen = [];
    const body = document.createElement("div");
    const info = document.createElement("div");
    info.style.opacity = "0.9";
    info.style.marginBottom = "10px";
    info.textContent = "Pick 2 cards to give:";
    body.appendChild(info);

    const grid = document.createElement("div");
    grid.style.display = "flex";
    grid.style.flexWrap = "wrap";
    grid.style.gap = "10px";

    const status = document.createElement("div");
    status.style.marginTop = "10px";
    status.style.fontWeight = "800";
    const update = () => status.textContent = `Selected: ${chosen.length}/2`;
    update();

    const modal = openModal("Shopping — Give 2", body, [
      { label: "Cancel", primary: false, onClick: ({ close }) => close() },
      { label: "Confirm", primary: true, onClick: ({ close }) => {
        if (chosen.length !== 2) return toast("Pick exactly 2 cards.");
        socket.emit("shoppingGiveChosen", { idx1: chosen[0], idx2: chosen[1] });
        close();
      } }
    ]);

    h.forEach(c => {
      const img = document.createElement("img");
      img.className = "fh-cardimg";
      img.style.width = "84px";
      img.style.cursor = "pointer";
      img.src = `assets/cards/${imgFromSnap(c)}`;
      img.onclick = () => {
        const i = Number(c.i);
        if (!Number.isInteger(i)) return;
        const at = chosen.indexOf(i);
        if (at >= 0) {
          chosen.splice(at, 1);
          img.style.outline = "";
        } else {
          if (chosen.length >= 2) return;
          chosen.push(i);
          img.style.outline = "3px solid rgba(255,255,255,.5)";
          img.style.outlineOffset = "2px";
        }
        update();
      };
      grid.appendChild(img);
    });

    body.appendChild(grid);
    body.appendChild(status);
  });

  socket.on("shoppingPickTake", ({ hiddenCount, hand }) => {
    const n = Number.isInteger(hiddenCount) ? hiddenCount : (Array.isArray(hand) ? hand.length : 0);
    if (n <= 0) return;

    const body = document.createElement("div");
    const info = document.createElement("div");
    info.style.opacity = "0.9";
    info.style.marginBottom = "10px";
    info.textContent = "Pick 1 card to take (cards are hidden):";
    body.appendChild(info);

    const grid = document.createElement("div");
    grid.style.display = "flex";
    grid.style.flexWrap = "wrap";
    grid.style.gap = "10px";

    const modal = openModal("Shopping — Take 1", body, []);

    for (let i = 0; i < n; i++) {
      const img = document.createElement("img");
      img.className = "fh-cardimg";
      img.style.width = "84px";
      img.style.cursor = "pointer";
      img.src = "assets/cards/back.png";
      img.title = `Hidden card ${i + 1}`;
      img.onclick = () => { socket.emit("shoppingTakeChosen", { idx: i }); modal.close(); };
      grid.appendChild(img);
    }

    body.appendChild(grid);
  });

  // ---------------- Specials: Pinky Promise ----------------
  socket.on("promiseChooseTarget", ({ targets }) => {
    const ts = Array.isArray(targets) ? targets : [];
    const body = document.createElement("div");
    body.textContent = "Choose who to make a Pinky Promise with:";
    const wrap = document.createElement("div");
    wrap.style.display = "grid";
    wrap.style.gap = "10px";
    wrap.style.marginTop = "12px";
    body.appendChild(wrap);

    const modal = openModal("Pinky Promise", body, []);
    ts.forEach(t => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "fh-btn fh-btn-primary";
      b.textContent = t.name || t.sid;
      b.onclick = () => { socket.emit("promiseTargetChosen", { sid: t.sid }); modal.close(); };
      wrap.appendChild(b);
    });
  });

  // ---------------- Specials: Rainbow ----------------
  socket.on("rainbowPick", ({ hand }) => {
    const h = Array.isArray(hand) ? hand : [];
    if (!h.length) return;

    const selected = new Map(); // color -> idx

    const body = document.createElement("div");
    const info = document.createElement("div");
    info.style.opacity = "0.9";
    info.style.marginBottom = "10px";
    info.textContent = "Pick exactly 1 of each color (Red, Yellow, Green, Blue) to discard under the pile:";
    body.appendChild(info);

    const grid = document.createElement("div");
    grid.style.display = "flex";
    grid.style.flexWrap = "wrap";
    grid.style.gap = "10px";

    const status = document.createElement("div");
    status.style.marginTop = "10px";
    status.style.fontWeight = "800";
    const update = () => {
      const got = Array.from(selected.keys());
      status.textContent = `Selected colors: ${got.length}/4 ${got.length ? `(${got.join(", ")})` : ""}`;
    };
    update();

    const modal = openModal("Rainbow — Pick 4", body, [
      { label: "Auto", primary: false, onClick: () => {
        selected.clear();
        const need = ["red","yellow","green","blue"];
        need.forEach(col => {
          const c = h.find(x => x && String(x.color) === col);
          if (c && Number.isInteger(c.i)) selected.set(col, c.i);
        });
        Array.from(grid.children).forEach(img => {
          const idx = Number(img.getAttribute("data-idx"));
          const card = h.find(x => Number(x.i) === idx);
          const col = card ? String(card.color) : "";
          img.style.outline = selected.get(col) === idx ? "3px solid rgba(255,255,255,.5)" : "";
          img.style.outlineOffset = "2px";
        });
        update();
      } },
      { label: "Confirm", primary: true, onClick: ({ close }) => {
        if (selected.size !== 4) return toast("You must pick 1 of each color.");
        socket.emit("rainbowChosen", { indices: Array.from(selected.values()) });
        close();
      } }
    ]);

    h.forEach(c => {
      const idx = Number(c.i);
      const col = String(c.color || "");
      const img = document.createElement("img");
      img.className = "fh-cardimg";
      img.style.width = "84px";
      img.style.cursor = "pointer";
      img.src = `assets/cards/${imgFromSnap(c)}`;
      img.setAttribute("data-idx", String(idx));
      img.onclick = () => {
        if (!["red","yellow","green","blue"].includes(col)) return;

        const existing = selected.get(col);
        if (existing === idx) {
          selected.delete(col);
          img.style.outline = "";
        } else {
          // only one card per color
          selected.set(col, idx);
          // clear outline on any previous for this color
          Array.from(grid.children).forEach(el => {
            const i2 = Number(el.getAttribute("data-idx"));
            const c2 = h.find(x => Number(x.i) === i2);
            const col2 = c2 ? String(c2.color) : "";
            if (col2 === col) {
              el.style.outline = (i2 === idx) ? "3px solid rgba(255,255,255,.5)" : "";
              el.style.outlineOffset = "2px";
            }
          });
        }
        update();
      };
      grid.appendChild(img);
    });

    body.appendChild(grid);
    body.appendChild(status);
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
