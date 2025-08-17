/* global io */
(() => {
  const socket = io();

  // ---------- DOM helpers ----------
  const byId = (id) => document.getElementById(id);

  // Core UI references (safe if null)
  let $players, $draw, $discard, $hand, $chatLog, $chatInput, $sendChat, $timer, $prompts;
  let $joinForm, $joinBtn, $nameInput, $joinOverlay, $statusText;

  // ---------- State ----------
  const COLORS = ["red","yellow","green","blue"];
  const cardImgPath = (img) => `/assets/cards/${img || "back.png"}`;
  const backImg = `/assets/cards/back.png`;

  let me = { id:null, name:null, spectator:true, clientId:null };

  let started = false;
  let countdownEndsAt = null;
  let turnEndsAt = null;
  let current = null;
  let dir = 1;
  let color = null;
  let top = null;
  let penalty = null;  // { total, type, target }
  let roundFlags = { happy:false };
  let playersState = [];
  let myHand = [];

  let uiTicker = null;

  // ---------- Socket diagnostics ----------
  socket.on("connect_error", (err) => {
    console.warn("socket connect_error:", err?.message || err);
    if ($statusText) $statusText.textContent = "Connection error. Check server.";
  });
  socket.on("reconnect", () => {
    if ($statusText) $statusText.textContent = "Reconnected.";
  });

  // ---------- JOIN logic ----------
  function persist(k, v) { try { localStorage.setItem(k, v); } catch {} }
  function read(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } }

  function emitJoin(nameFromUI) {
    const name = (nameFromUI ?? ($nameInput?.value || "")).trim();
    if (name) persist("unoName", name);
    const savedClientId = read("unoClientId");

    if ($joinBtn) { $joinBtn.disabled = true; $joinBtn.textContent = "Joining…"; }
    if ($statusText) $statusText.textContent = "Joining…";

    // Use ACK to confirm on the client that server processed the join
    socket.emit("join", { name, clientId: savedClientId }, (resp) => {
      if (!resp || !resp.ok) {
        if ($statusText) $statusText.textContent = "Join failed. Try again.";
        if ($joinBtn) { $joinBtn.disabled = false; $joinBtn.textContent = "Join"; }
        return;
      }
      // The server will also emit "me" and "state"; we still gracefully hide overlay now
      if ($joinOverlay) $joinOverlay.style.display = "none";
      if ($statusText) $statusText.textContent = "Joined";
      if ($joinBtn) { $joinBtn.disabled = false; $joinBtn.textContent = "Join"; }
    });
  }

  function wireJoinUI() {
    // Safe re-query after DOM is ready
    $joinForm    = byId("joinForm");
    $joinBtn     = byId("joinBtn");
    $nameInput   = byId("nameInput");
    $joinOverlay = byId("joinOverlay");
    $statusText  = byId("status");

    // Prefill saved name if available
    const savedName = read("unoName");
    if ($nameInput && savedName && !$nameInput.value) $nameInput.value = savedName;

    // Button + form submit (prevent default page reload)
    if ($joinBtn && !$joinBtn.__wired) {
      $joinBtn.__wired = true;
      $joinBtn.addEventListener("click", (e) => { e.preventDefault(); emitJoin(); });
    }
    if ($joinForm && !$joinForm.__wired) {
      $joinForm.__wired = true;
      $joinForm.addEventListener("submit", (e) => { e.preventDefault(); emitJoin(); });
    }
  }

  // Auto-join once using persisted identity (comment out to require manual join)
  function autoJoinOnce() {
    const savedClientId = read("unoClientId");
    const savedName = read("unoName");
    socket.emit("join", { name: savedName, clientId: savedClientId }, () => { /* ack ignored here */ });
  }

  // ---------- Server acks identity ----------
  socket.on("me", (info) => {
    me.id = info.id;
    me.name = info.name;
    me.spectator = !!info.spectator;
    me.clientId = info.clientId;
    if (info.clientId) persist("unoClientId", info.clientId);

    if ($joinOverlay) $joinOverlay.style.display = "none";
    if ($statusText) $statusText.textContent = "Joined";
    if ($joinBtn) { $joinBtn.disabled = false; $joinBtn.textContent = "Join"; }
  });

  // ---------- State / hand ----------
  socket.on("state", (s) => {
    started = !!s.started;
    countdownEndsAt = s.countdownEndsAt;
    turnEndsAt = s.turnEndsAt;
    current = s.current;
    dir = s.direction;
    color = s.color;
    top = s.top;
    penalty = s.penalty;
    roundFlags = s.roundFlags || { happy:false };
    playersState = s.players || [];

    const myRow = playersState.find(p => p.id === me.id);
    if (myRow) me.spectator = !!myRow.spectator;

    if ($joinOverlay && me.id) $joinOverlay.style.display = "none";

    renderAll();
  });

  socket.on("handSnapshot", (cards) => {
    myHand = Array.isArray(cards) ? cards.slice() : [];
    renderHand();
  });

  socket.on("announce", (t) => logLine(t));

  // ---------- Happy moderation feedback (optional UI) ----------
  socket.on("happyFlagApplied", ({ messageId }) => {
    // could visually mark a message with data-mid === messageId
  });

  // ---------- Wild color chooser ----------
  socket.on("chooseColor", () => {
    showColorPicker("Choose a color", (c) => {
      socket.emit("colorChosen", { color: c });
      clearPrompt();
    }, () => clearPrompt());
  });

  // ---------- Prompts ----------
  socket.on("prompt", ({ kind, data, timeoutMs }) => {
    switch(kind) {
      case "lookOrder":      renderLookOrderPrompt(data, timeoutMs); break;
      case "rainbowSelects": renderRainbowPrompt(data, timeoutMs);    break;
      case "targetPicker":   renderTargetPicker(data, timeoutMs);     break;
      case "shoppingTrade":  renderShoppingPrompt(data, timeoutMs);   break;
    }
  });

  // ---------- Chat ----------
  function sendChat() {
    const text = ($chatInput.value || "").trim();
    if (!text) return;
    socket.emit("chat", text);
    $chatInput.value = "";
  }

  // ---------- Draw pile ----------
  function bindDrawClick() {
    if (!$draw || $draw.__wired) return;
    $draw.__wired = true;
    $draw.addEventListener("click", () => {
      if (!started) return;
      if (me.spectator) return;
      if (current !== me.id) return;
      socket.emit("drawCard");
    });
  }

  // ---------- Rendering ----------
  function renderAll() {
    renderPlayers(playersState, current);
    renderPiles();
    renderTimer();
    renderHand();
    ensureTicker();
  }

  function renderPlayers(pl, cur) {
    if (!$players || !Array.isArray(pl)) return;
    $players.innerHTML = "";
    pl.forEach(p => {
      const row = document.createElement("div");
      row.className = "player-row" + (p.id === cur ? " current" : "") + (p.spectator ? " spectator" : "");
      row.textContent = `${p.name}${p.spectator ? " (spec)" : ""} — ${p.handCount ?? 0}`;
      $players.appendChild(row);
    });
  }

  function renderPiles() {
    if ($discard) {
      const img = document.createElement("img");
      img.alt = "Top discard";
      img.src = top?.img ? cardImgPath(top.img) : backImg;
      img.className = "card-img top-discard";
      $discard.innerHTML = "";
      $discard.appendChild(img);
    }
    if ($draw) {
      const img = document.createElement("img");
      img.alt = "Draw pile";
      img.src = backImg;
      img.className = "card-img draw-pile";
      $draw.innerHTML = "";
      $draw.appendChild(img);
      if (started && !me.spectator && current === me.id) $draw.classList.add("clickable");
      else $draw.classList.remove("clickable");
    }
  }

  function renderTimer() {
    if (!$timer) return;
    const now = Date.now();
    let leftMs = 0;
    if (!started && countdownEndsAt) leftMs = Math.max(0, countdownEndsAt - now);
    else if (started && turnEndsAt)  leftMs = Math.max(0, turnEndsAt - now);
    const secs = Math.ceil(leftMs / 1000);
    $timer.textContent = !started ? `Game starts in: ${secs}s` : `Turn time: ${secs}s`;
  }
  function ensureTicker() {
    if (uiTicker) return;
    uiTicker = setInterval(renderTimer, 250);
  }

  function renderHand() {
    if (!$hand) return;
    $hand.innerHTML = "";
    const pendingStackAgainstMe = !!(penalty && penalty.target === me.id);
    const myTurn = started && current === me.id && !me.spectator;

    myHand.forEach((c, idx) => {
      const el = document.createElement("img");
      el.className = "card-img hand-card";
      el.src = cardImgPath(c.img);
      el.alt = c.type || "";
      el.dataset.index = String(idx);

      let enabled = false;

      if (penalty && c.type === "wild_relax") {
        enabled = true;
        el.classList.add("relax-card");
        el.title = "Play RELAX to cancel stack";
      }

      if (myTurn) {
        if (!penalty) enabled = clientCanMatchTop(c);
        else if (pendingStackAgainstMe) enabled = (c.type === penalty.type);
        else enabled = false;
      }

      if (enabled) el.classList.add("clickable");
      else el.classList.remove("clickable");

      el.onclick = () => {
        if (!enabled) return;
        if (penalty && c.type === "wild_relax") { socket.emit("playRelax", { index: idx }); return; }
        if (started && current === me.id) socket.emit("playCard", { index: idx });
      };

      $hand.appendChild(el);
    });
  }

  function clientCanMatchTop(card) {
    if (!top) return true;
    const isWild = String(card.type || "").startsWith("wild");
    if (isWild) return true;
    if (card.type === "number") return (card.color === color) || (card.value === top.value);
    return (card.color === color) || (card.type === top.type);
  }

  // ---------- Prompts UI ----------
  function clearPrompt() { if ($prompts) $prompts.innerHTML = ""; }

  function showColorPicker(title, onPick, onCancel) {
    if (!$prompts) return;
    $prompts.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "prompt color-picker";
    const h = document.createElement("div");
    h.className = "prompt-title";
    h.textContent = title || "Choose color";
    wrap.appendChild(h);
    const row = document.createElement("div");
    row.className = "color-row";
    COLORS.forEach(c => {
      const b = document.createElement("button");
      b.className = `color-btn ${c}`;
      b.textContent = c.toUpperCase();
      b.onclick = () => onPick && onPick(c);
      row.appendChild(b);
    });
    wrap.appendChild(row);
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.className = "prompt-cancel";
    cancel.onclick = () => onCancel && onCancel();
    wrap.appendChild(cancel);
    $prompts.appendChild(wrap);
  }

  function renderLookOrderPrompt(data, timeoutMs) {
    if (!$prompts) return;
    const top4 = (data && data.top4) || [];
    let picks = [];
    const wrap = document.createElement("div");
    wrap.className = "prompt look-order";
    const title = document.createElement("div");
    title.className = "prompt-title";
    title.textContent = "Reorder the next 4 draw cards (first click = top of deck)";
    wrap.appendChild(title);
    const grid = document.createElement("div");
    grid.className = "prompt-grid";
    top4.forEach((c, i) => {
      const img = document.createElement("img");
      img.src = cardImgPath(c.img);
      img.className = "card-img";
      img.onclick = () => {
        if (picks.length >= 4 || picks.includes(i)) return;
        picks.push(i);
        img.style.opacity = 0.6;
        img.setAttribute("data-ord", String(picks.length));
      };
      grid.appendChild(img);
    });
    wrap.appendChild(grid);
    const btns = document.createElement("div");
    const ok = document.createElement("button");
    ok.textContent = "Confirm Order";
    ok.onclick = () => { socket.emit("promptChoice", { kind: "lookOrder", order: picks }); clearPrompt(); };
    btns.appendChild(ok);
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.onclick = () => clearPrompt();
    btns.appendChild(cancel);
    if (timeoutMs) {
      const t = document.createElement("span");
      t.className = "prompt-time";
      tickCountdown(t, timeoutMs);
      btns.appendChild(t);
    }
    wrap.appendChild(btns);
    $prompts.innerHTML = "";
    $prompts.appendChild(wrap);
  }

  function renderRainbowPrompt(data, timeoutMs) {
    if (!$prompts) return;
    const hand = (data && data.hand) || [];
    const picks = new Set();
    const wrap = document.createElement("div");
    wrap.className = "prompt rainbow";
    const title = document.createElement("div");
    title.className = "prompt-title";
    title.textContent = "Rainbow: select one card of each color (R/Y/G/B)";
    wrap.appendChild(title);
    const grid = document.createElement("div");
    grid.className = "prompt-grid";
    hand.forEach((c) => {
      const img = document.createElement("img");
      img.src = cardImgPath(c.img);
      img.className = "card-img";
      img.onclick = () => {
        if (picks.has(c.idx)) { picks.delete(c.idx); img.classList.remove("selected"); }
        else { picks.add(c.idx); img.classList.add("selected"); }
      };
      grid.appendChild(img);
    });
    wrap.appendChild(grid);
    const btns = document.createElement("div");
    const ok = document.createElement("button");
    ok.textContent = "Discard 4 (one of each)";
    ok.onclick = () => { socket.emit("promptChoice", { kind:"rainbowSelects", picks: Array.from(picks) }); clearPrompt(); };
    btns.appendChild(ok);
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.onclick = () => clearPrompt();
    btns.appendChild(cancel);
    if (timeoutMs) {
      const t = document.createElement("span");
      t.className = "prompt-time";
      tickCountdown(t, timeoutMs);
      btns.appendChild(t);
    }
    wrap.appendChild(btns);
    $prompts.innerHTML = "";
    $prompts.appendChild(wrap);
  }

  function renderTargetPicker(data, timeoutMs) {
    if (!$prompts) return;
    const targets = (data && data.targets) || [];
    const wrap = document.createElement("div");
    wrap.className = "prompt target-picker";
    const title = document.createElement("div");
    title.className = "prompt-title";
    title.textContent = "Choose a player to Pinky Promise with";
    wrap.appendChild(title);
    const list = document.createElement("div");
    list.className = "prompt-list";
    let selected = null;
    targets.forEach(t => {
      const btn = document.createElement("button");
      btn.className = "prompt-btn";
      btn.textContent = t.name;
      btn.onclick = () => { selected = t.sid; };
      list.appendChild(btn);
    });
    wrap.appendChild(list);
    const controls = document.createElement("div");
    const ok = document.createElement("button");
    ok.textContent = "Confirm";
    ok.onclick = () => { socket.emit("promptChoice", { kind:"targetPicker", targetSid: selected }); clearPrompt(); };
    controls.appendChild(ok);
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.onclick = () => clearPrompt();
    controls.appendChild(cancel);
    if (timeoutMs) {
      const t = document.createElement("span");
      t.className = "prompt-time";
      tickCountdown(t, timeoutMs);
      controls.appendChild(t);
    }
    wrap.appendChild(controls);
    $prompts.innerHTML = "";
    $prompts.appendChild(wrap);
  }

  function renderShoppingPrompt(data, timeoutMs) {
    if (!$prompts) return;
    const mine = (data && data.mine) || [];
    const theirs = (data && data.theirs) || [];
    const wrap = document.createElement("div");
    wrap.className = "prompt shopping";
    const title = document.createElement("div");
    title.className = "prompt-title";
    title.textContent = "Shopping: pick TWO to give, and ONE to take";
    wrap.appendChild(title);
    const cols = document.createElement("div");
    cols.className = "prompt-cols";

    const mineCol = document.createElement("div");
    mineCol.className = "prompt-col";
    mineCol.appendChild(makeLabel("Your cards (pick 2)"));
    const mineGrid = document.createElement("div");
    mineGrid.className = "prompt-grid";
    const mineSet = new Set();
    mine.forEach(m => {
      const img = document.createElement("img");
      img.src = cardImgPath(m.img);
      img.className = "card-img";
      img.onclick = () => {
        if (mineSet.has(m.idx)) { mineSet.delete(m.idx); img.classList.remove("selected"); }
        else if (mineSet.size < 2) { mineSet.add(m.idx); img.classList.add("selected"); }
      };
      mineGrid.appendChild(img);
    });
    mineCol.appendChild(mineGrid);

    const theirCol = document.createElement("div");
    theirCol.className = "prompt-col";
    theirCol.appendChild(makeLabel("Their cards (pick 1)"));
    const theirGrid = document.createElement("div");
    theirGrid.className = "prompt-grid";
    let theirPick = null;
    theirs.forEach(t => {
      const img = document.createElement("img");
      img.src = cardImgPath(t.img);
      img.className = "card-img";
      img.onclick = () => {
        theirPick = t.idx;
        Array.from(theirGrid.querySelectorAll("img")).forEach(x => x.classList.remove("selected"));
        img.classList.add("selected");
      };
      theirGrid.appendChild(img);
    });
    theirCol.appendChild(theirGrid);

    cols.appendChild(mineCol);
    cols.appendChild(theirCol);
    wrap.appendChild(cols);

    const controls = document.createElement("div");
    const ok = document.createElement("button");
    ok.textContent = "Trade";
    ok.onclick = () => { socket.emit("promptChoice", { kind:"shoppingTrade", myTwo: Array.from(mineSet), theirOne: theirPick }); clearPrompt(); };
    controls.appendChild(ok);
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.onclick = () => clearPrompt();
    controls.appendChild(cancel);
    if (timeoutMs) {
      const t = document.createElement("span");
      t.className = "prompt-time";
      tickCountdown(t, timeoutMs);
      controls.appendChild(t);
    }
    $prompts.innerHTML = "";
    $prompts.appendChild(wrap);
  }

  function makeLabel(text) { const d = document.createElement("div"); d.className = "prompt-label"; d.textContent = text; return d; }
  function tickCountdown(el, ms) {
    if (!el) return; const end = Date.now() + (ms || 10000);
    const f = () => { const left = Math.max(0, end - Date.now()); el.textContent = ` (${Math.ceil(left/1000)}s)`; if (left > 0) requestAnimationFrame(f); };
    f();
  }

  // ---------- Chat setup after DOM ready ----------
  function wireChat() {
    if ($sendChat && !$sendChat.__wired) {
      $sendChat.__wired = true;
      $sendChat.addEventListener("click", sendChat);
    }
    if ($chatInput && !$chatInput.__wired) {
      $chatInput.__wired = true;
      $chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
    }
  }

  // ---------- Log helper ----------
  function logLine(t) {
    if (!$chatLog) return;
    const el = document.createElement("div");
    el.className = "chat-announce";
    el.textContent = t;
    $chatLog.appendChild(el);
    $chatLog.scrollTop = $chatLog.scrollHeight;
  }

  // ---------- Initial DOM hookup ----------
  function queryCoreNodes() {
    $players   = byId("players");
    $draw      = byId("drawPile");
    $discard   = byId("discardPile");
    $hand      = byId("hand");
    $chatLog   = byId("chatLog");
    $chatInput = byId("chatInput");
    $sendChat  = byId("sendChat");
    $timer     = byId("timer");
    $prompts   = byId("prompts");
  }

  function onDomReady() {
    queryCoreNodes();
    wireJoinUI();
    wireChat();
    bindDrawClick();
    // Auto-join using persisted identity
    autoJoinOnce();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onDomReady, { once:true });
  } else {
    onDomReady();
  }
})();
