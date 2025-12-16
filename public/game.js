/*
  game.js — Fantastic Happiness UNO client (Refined UI + Mobile friendly)
  MATCHED TO PROVIDED server.js:
  - uses state.penalty (not pendingPenalty)
  - draw2 image snap/previews use *_draw.png (matches assets list)
  - supports spectator join via ?spectator=1 or ?admin=1
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

  function setVisible(el, yes) {
    if (!el) return;
    el.style.display = yes ? "" : "none";
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

    // ✅ FIX: your assets are *_draw.png (NOT *_draw2.png)
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

  let audioUnlocked = false;

  function unlockAudioOnce() {
    if (audioUnlocked) return;
    audioUnlocked = true;

    // iOS/Safari: must play during a user gesture at least once
    try {
      const a = new Audio("/assets/sounds/start.mp3");
      a.volume = 0.001;
      a.play().then(() => {
        try { a.pause(); a.currentTime = 0; } catch {}
      }).catch(() => {});
    } catch {}
  }

  function playSound(key) {
    if (muted) return;
    const k = String(key || "").trim();
    if (!k) return;

    // allow unknown keys too, but keep your canonical list
    const file = SOUND_KEYS.has(k) ? `${k}.mp3` : `${k}.mp3`;

    try {
      const a = new Audio(`/assets/sounds/${file}`);
      a.volume = 0.9;
      a.play().catch(() => {});
    } catch {}
  }

  function setMuteUI() {
    if (!muteToggle) return;
    muteToggle.textContent = muted ? "🔇 Sound Off" : "🔊 Sound On";
    muteToggle.setAttribute("aria-label", muted ? "Sound off" : "Sound on");
  }

  if (muteToggle) {
    muteToggle.addEventListener("click", () => {
      unlockAudioOnce();
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
    unlockAudioOnce();

    const name = (nameInput.value || "").trim() || "Player";
    const lobby = (lobbyInput.value || "").trim() || "default";

    // ✅ spectator/admin never takes a seat:
    const qs = new URLSearchParams(window.location.search);
    const spectator = qs.get("spectator") === "1" || qs.get("admin") === "1";

    localStorage.setItem("uno_name", name);
    localStorage.setItem("uno_lobby", lobby);

    socket.emit("join", { name, lobby, spectator });
  }

  joinBtn.addEventListener("click", doJoin);
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });
  lobbyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });

  socket.on("me", (info) => {
    me = info;
    setVisible(joinScreen, false);
    setVisible(gameScreen, true);

    if (window.matchMedia && window.matchMedia("(max-width: 780px)").matches) {
      const ds = document.querySelectorAll(".fh-rail details");
      ds.forEach((d, i) => { if (i === 0) return; d.open = false; });
    }

    toast(`Joined lobby: ${me.lobby}${me.spectator ? " (spectator)" : ""}`);
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
      unlockAudioOnce();
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
  if (drawPile) drawPile.addEventListener("click", () => { unlockAudioOnce(); socket.emit("drawCard"); });
  if (unoBtn) unoBtn.addEventListener("click", () => { unlockAudioOnce(); socket.emit("callUno"); });
  if (relaxBtn) relaxBtn.addEventListener("click", () => { unlockAudioOnce(); socket.emit("playRelaxRequested"); });

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

      if (isTurn) {
        right.style.padding = "2px 8px";
        right.style.borderRadius = "999px";
        right.style.border = "1px solid #ffffff26";
        right.style.background = "rgba(255,255,255,.08)";
        right.style.fontWeight = "800";
        right.style.color = "var(--text)";
      }

      row.appendChild(left);
      row.appendChild(right);
      playerList.appendChild(row);
    });
  }

  function renderTop(state) {
    const top = state.top;
    if (discardTop) {
      discardTop.src = top && top.img ? `/assets/cards/${top.img}` : "/assets/cards/back.png";
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
      img.src = `/assets/cards/${card.img || "back.png"}`;
      img.title = `${card.color || ""} ${card.type || ""}${typeof card.value === "number" ? " " + card.value : ""}`;

      if (!isMyTurn) {
        img.style.opacity = "0.65";
        img.style.pointerEvents = "none";
      }

      img.addEventListener("click", () => {
        unlockAudioOnce();
        if (!isMyTurn) return;
        socket.emit("playCard", { index: idx });
      });

      handRoot.appendChild(img);
    });
  }

  // keep countdown fresh
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

    renderTop(lastState);
    renderPlayers(lastState);
    renderTurn(lastState);
    renderHand(lastState, lastHand);
  });

  socket.on("sound", (key) => { unlockAudioOnce(); playSound(key); });

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

  // ---------------- Specials: Blue Look (reorder top N) ----------------
  socket.on("lookTop", ({ cards }) => {
    const list = Array.isArray(cards) ? cards : [];
    const n = list.length;

    const body = document.createElement("div");

    const msg = document.createElement("div");
    msg.style.opacity = "0.9";
    msg.style.marginBottom = "12px";
    msg.textContent = `Reorder the top ${n} cards of the deck (1 = next draw).`;
    body.appendChild(msg);

    if (!n) {
      toast("Nothing to look at.");
      return;
    }

    const table = document.createElement("div");
    table.style.display = "grid";
    table.style.gap = "10px";

    const selects = [];

    list.forEach((c, idx) => {
      const row = document.createElement("div");
      row.style.display = "grid";
      row.style.gridTemplateColumns = "1fr 120px";
      row.style.gap = "10px";
      row.style.alignItems = "center";
      row.style.padding = "10px";
      row.style.border = "1px solid #ffffff18";
      row.style.borderRadius = "14px";
      row.style.background = "rgba(0,0,0,.18)";

      const left = document.createElement("div");
      left.textContent = `${String(c.color || "").toUpperCase()} ${String(c.type || "")}${typeof c.value === "number" ? " " + c.value : ""}`;
      left.style.fontWeight = "700";

      const sel = document.createElement("select");
      sel.style.padding = "10px 10px";
      sel.style.borderRadius = "12px";
      sel.style.border = "1px solid #ffffff22";
      sel.style.background = "rgba(255,255,255,.06)";
      sel.style.color = "var(--text)";
      for (let pos = 1; pos <= n; pos++) {
        const opt = document.createElement("option");
        opt.value = String(pos);
        opt.textContent = String(pos);
        if (pos === idx + 1) opt.selected = true;
        sel.appendChild(opt);
      }

      selects.push(sel);

      row.appendChild(left);
      row.appendChild(sel);
      table.appendChild(row);
    });

    body.appendChild(table);

    openModal("Blue Look", body, [
      {
        label: "Confirm Order",
        primary: true,
        onClick: ({ close }) => {
          const used = new Set();
          const order = new Array(n).fill(null);

          for (let cardIndex = 0; cardIndex < n; cardIndex++) {
            const pos = Number(selects[cardIndex].value);
            if (!Number.isInteger(pos) || pos < 1 || pos > n) continue;
            if (used.has(pos)) { toast("Each position must be unique."); return; }
            used.add(pos);
            order[pos - 1] = cardIndex;
          }

          if (order.some(x => x === null)) { toast("Each position must be assigned once."); return; }
          socket.emit("lookTopOrder", { order });
          close();
        }
      }
    ]);
  });

  // ---------------- Specials: Shopping (target + give 2 + take 1) ----------------
  socket.on("shoppingChooseTarget", ({ targets }) => {
    const list = Array.isArray(targets) ? targets : [];
    const body = document.createElement("div");

    const msg = document.createElement("div");
    msg.style.opacity = "0.9";
    msg.style.marginBottom = "12px";
    msg.textContent = "Choose a target player:";
    body.appendChild(msg);

    const wrap = document.createElement("div");
    wrap.style.display = "grid";
    wrap.style.gap = "10px";

    const modal = openModal("Shopping — Target", body, []);

    list.forEach(t => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "fh-btn fh-btn-primary";
      b.textContent = t.name || t.sid;
      b.onclick = () => {
        socket.emit("shoppingTargetChosen", { sid: t.sid });
        modal.close();
      };
      wrap.appendChild(b);
    });

    body.appendChild(wrap);
  });

  socket.on("shoppingPickGive", ({ hand }) => {
    const cards = Array.isArray(hand) ? hand : [];
    const body = document.createElement("div");

    const msg = document.createElement("div");
    msg.style.opacity = "0.9";
    msg.style.marginBottom = "12px";
    msg.innerHTML = `Pick <b>two</b> cards to give:`;
    body.appendChild(msg);

    const chosen = new Set();
    const grid = document.createElement("div");
    grid.style.display = "flex";
    grid.style.flexWrap = "wrap";
    grid.style.gap = "10px";
    grid.style.justifyContent = "center";

    cards.forEach(c => {
      const img = document.createElement("img");
      img.src = `/assets/cards/${imgFromSnap(c)}`;
      img.alt = c.type || "card";
      img.style.width = "86px";
      img.style.height = "124px";
      img.style.objectFit = "contain";
      img.style.borderRadius = "12px";
      img.style.cursor = "pointer";
      img.style.filter = "drop-shadow(0 10px 14px rgba(0,0,0,.35))";

      img.onclick = () => {
        const i = Number(c.i);
        if (chosen.has(i)) chosen.delete(i);
        else {
          if (chosen.size >= 2) return;
          chosen.add(i);
        }
        img.style.outline = chosen.has(i) ? "3px solid rgba(56,189,248,.85)" : "";
      };

      grid.appendChild(img);
    });

    body.appendChild(grid);

    openModal("Shopping — Give", body, [
      {
        label: "Confirm",
        primary: true,
        onClick: ({ close }) => {
          const arr = Array.from(chosen);
          if (arr.length !== 2) { toast("Pick exactly two cards."); return; }
          socket.emit("shoppingGiveChosen", { idx1: arr[0], idx2: arr[1] });
          close();
        }
      }
    ]);
  });

  socket.on("shoppingPickTake", ({ hand }) => {
    const cards = Array.isArray(hand) ? hand : [];
    const body = document.createElement("div");

    const msg = document.createElement("div");
    msg.style.opacity = "0.9";
    msg.style.marginBottom = "12px";
    msg.innerHTML = `Pick <b>one</b> card to take:`;
    body.appendChild(msg);

    let chosen = null;

    const grid = document.createElement("div");
    grid.style.display = "flex";
    grid.style.flexWrap = "wrap";
    grid.style.gap = "10px";
    grid.style.justifyContent = "center";

    const imgs = [];

    cards.forEach(c => {
      const img = document.createElement("img");
      img.src = `/assets/cards/${imgFromSnap(c)}`;
      img.alt = c.type || "card";
      img.style.width = "86px";
      img.style.height = "124px";
      img.style.objectFit = "contain";
      img.style.borderRadius = "12px";
      img.style.cursor = "pointer";
      img.style.filter = "drop-shadow(0 10px 14px rgba(0,0,0,.35))";

      img.onclick = () => {
        chosen = Number(c.i);
        imgs.forEach(x => (x.style.outline = ""));
        img.style.outline = "3px solid rgba(56,189,248,.85)";
      };

      imgs.push(img);
      grid.appendChild(img);
    });

    body.appendChild(grid);

    openModal("Shopping — Take", body, [
      {
        label: "Confirm",
        primary: true,
        onClick: ({ close }) => {
          if (chosen == null) { toast("Pick one card."); return; }
          socket.emit("shoppingTakeChosen", { idx: chosen });
          close();
        }
      }
    ]);
  });

  // ---------------- Specials: Pinky Promise ----------------
  socket.on("promiseChooseTarget", ({ targets }) => {
    const list = Array.isArray(targets) ? targets : [];
    const body = document.createElement("div");

    const msg = document.createElement("div");
    msg.style.opacity = "0.9";
    msg.style.marginBottom = "12px";
    msg.textContent = "Choose a player to Pinky Promise with:";
    body.appendChild(msg);

    const wrap = document.createElement("div");
    wrap.style.display = "grid";
    wrap.style.gap = "10px";

    const modal = openModal("Pinky Promise", body, []);

    list.forEach(t => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "fh-btn fh-btn-primary";
      b.textContent = t.name || t.sid;
      b.onclick = () => {
        socket.emit("promiseTargetChosen", { sid: t.sid });
        modal.close();
      };
      wrap.appendChild(b);
    });

    body.appendChild(wrap);
  });

  // ---------------- Specials: Rainbow ----------------
  socket.on("rainbowPick", ({ hand }) => {
    const cards = Array.isArray(hand) ? hand : [];
    const needed = ["red", "yellow", "green", "blue"];
    const pickedByColor = new Map();

    const body = document.createElement("div");

    const msg = document.createElement("div");
    msg.style.opacity = "0.9";
    msg.style.marginBottom = "10px";
    msg.innerHTML = `Pick <b>one of each color</b> (Red, Yellow, Green, Blue).`;
    body.appendChild(msg);

    const hint = document.createElement("div");
    hint.style.opacity = "0.8";
    hint.style.marginBottom = "12px";
    hint.textContent = "Only one per color counts.";
    body.appendChild(hint);

    const grid = document.createElement("div");
    grid.style.display = "flex";
    grid.style.flexWrap = "wrap";
    grid.style.gap = "10px";
    grid.style.justifyContent = "center";

    function refreshOutlines() {
      Array.from(grid.children).forEach((imgEl) => {
        const ix = Number(imgEl.getAttribute("data-idx"));
        const c = cards.find(x => Number(x.i) === ix);
        const col = c?.color;
        const picked = pickedByColor.get(col);
        imgEl.style.outline = (picked === ix) ? "3px solid rgba(56,189,248,.85)" : "";
      });
    }

    cards.forEach(c => {
      const img = document.createElement("img");
      img.src = `/assets/cards/${imgFromSnap(c)}`;
      img.alt = c.type || "card";
      img.style.width = "86px";
      img.style.height = "124px";
      img.style.objectFit = "contain";
      img.style.borderRadius = "12px";
      img.style.cursor = "pointer";
      img.style.filter = "drop-shadow(0 10px 14px rgba(0,0,0,.35))";
      img.setAttribute("data-idx", String(c.i));

      img.onclick = () => {
        const col = c.color;
        if (!needed.includes(col)) return;
        pickedByColor.set(col, Number(c.i));
        refreshOutlines();
      };

      grid.appendChild(img);
    });

    body.appendChild(grid);

    openModal("Rainbow", body, [
      {
        label: "Confirm",
        primary: true,
        onClick: ({ close }) => {
          const indices = [];
          for (const col of needed) {
            const ix = pickedByColor.get(col);
            if (ix == null) { toast(`Missing: ${col.toUpperCase()}`); return; }
            indices.push(ix);
          }
          socket.emit("rainbowChosen", { indices });
          close();
        }
      }
    ]);
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
