/* global io */
(() => {
  // ---------- Basics ----------
  const socket = io();

  // DOM helpers
  const byId = (id) => document.getElementById(id);
  const $players = byId("players");
  const $draw = byId("drawPile");
  const $discard = byId("discardPile");
  const $hand = byId("hand");
  const $chatLog = byId("chatLog");
  const $chatInput = byId("chatInput");
  const $sendChat = byId("sendChat");
  const $timer = byId("timer");
  const $prompts = byId("prompts"); // container below timer

  // Static
  const COLORS = ["red","yellow","green","blue"];
  const cardImgPath = (img) => `/assets/cards/${img || "back.png"}`;
  const backImg = `/assets/cards/back.png`;

  // Client identity (persistent)
  let me = { id:null, name:null, spectator:true, clientId: null };

  // State snapshot from server
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

  // Local render interval
  let uiTicker = null;

  // ---------- Identity: join with persisted clientId ----------
  try {
    const savedId = localStorage.getItem("unoClientId");
    socket.emit("join", { name: "", clientId: savedId || "" });
  } catch {
    socket.emit("join", { name: "", clientId: "" });
  }

  socket.on("me", (info) => {
    me.id = info.id;
    me.name = info.name;
    me.spectator = !!info.spectator;
    me.clientId = info.clientId || me.clientId;
    // persist identity for next visit
    try {
      if (me.clientId) localStorage.setItem("unoClientId", me.clientId);
    } catch {}
  });

  // ---------- Server pushes ----------
  socket.on("helloAck", () => {
    // no-op
  });

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

    // Keep local spectator flag synced (important when promoted)
    const myRow = playersState.find(p => p.id === me.id);
    if (myRow) me.spectator = !!myRow.spectator;

    renderAll();
  });

  socket.on("handSnapshot", (cards) => {
    // This event is sent only to me for my hand
    myHand = Array.isArray(cards) ? cards.slice() : [];
    renderHand();
  });

  socket.on("announce", (t) => {
    logLine(t);
  });

  // HAPPY flag result
  socket.on("happyFlagApplied", ({ messageId }) => {
    // optional: dim/mark the flagged message in UI if you render IDs
  });

  // Color chooser (server enforces for all wilds)
  socket.on("chooseColor", () => {
    showColorPicker("Choose a color", (c) => {
      socket.emit("colorChosen", { color: c });
      clearPrompt();
    }, () => {
      // If user ignores, do nothing; server will auto-resolve after play flow
      clearPrompt();
    });
  });

  // Generic prompts: lookOrder, rainbowSelects, targetPicker, shoppingTrade
  socket.on("prompt", ({ kind, data, timeoutMs }) => {
    switch(kind) {
      case "lookOrder": renderLookOrderPrompt(data, timeoutMs); break;
      case "rainbowSelects": renderRainbowPrompt(data, timeoutMs); break;
      case "targetPicker": renderTargetPicker(data, timeoutMs); break;
      case "shoppingTrade": renderShoppingPrompt(data, timeoutMs); break;
      default: /* no-op */ break;
    }
  });

  // ---------- Chat ----------
  if ($sendChat && $chatInput) {
    $sendChat.addEventListener("click", sendChat);
    $chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendChat();
    });
  }
  function sendChat() {
    const text = ($chatInput.value || "").trim();
    if (!text) return;
    socket.emit("chat", text);
    $chatInput.value = "";
  }

  socket.on("chat", (payload) => {
    // payload: { id, fromSid, fromName, msg, at }
    // Render basic line; HAPPY flagging can be UI-side if desired
    const line = document.createElement("div");
    line.className = "chat-line";
    line.dataset.mid = payload.id;
    line.textContent = `${payload.fromName}: ${payload.msg}`;
    if ($chatLog) $chatLog.appendChild(line);
    if ($chatLog) $chatLog.scrollTop = $chatLog.scrollHeight;

    // HAPPY: if active, show small flag button for player messages (not Admin/Spectators filtered server-side)
    if (roundFlags && roundFlags.happy) {
      const btn = document.createElement("button");
      btn.className = "happy-flag-btn";
      btn.textContent = "🙂";
      btn.title = "Flag this message (author draws 1)";
      btn.onclick = () => socket.emit("happyFlag", { messageId: payload.id });
      line.appendChild(btn);
    }
  });

  // ---------- Draw pile click ----------
  if ($draw) {
    $draw.addEventListener("click", () => {
      // Drawing is allowed on your turn; if you are stack target on your turn, this settles the stack
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
      // cursor state
      if (started && !me.spectator && current === me.id) {
        $draw.classList.add("clickable");
      } else {
        $draw.classList.remove("clickable");
      }
    }
  }

  // Timer: re-rendered from a local ticker every 250ms
  function renderTimer() {
    if (!$timer) return;
    const now = Date.now();
    let leftMs = 0;
    if (!started && countdownEndsAt) {
      leftMs = Math.max(0, countdownEndsAt - now);
    } else if (started && turnEndsAt) {
      leftMs = Math.max(0, turnEndsAt - now);
    }
    const secs = Math.ceil(leftMs / 1000);
    const label = !started ? `Game starts in: ${secs}s` : `Turn time: ${secs}s`;
    $timer.textContent = label;
  }

  function ensureTicker() {
    if (uiTicker) return;
    uiTicker = setInterval(() => {
      renderTimer();
    }, 250);
  }

  // ---------- Hand & clickability rules ----------
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

      // Enable/disable logic
      let enabled = false;

      // Out-of-turn RELAX: If a stack is pending, any player holding wild_relax can click it
      if (penalty && c.type === "wild_relax") {
        enabled = true; // let server decide legality; we'll route to playRelax
        el.classList.add("relax-card");
        el.title = "Play RELAX to cancel stack";
      }

      if (myTurn) {
        if (!penalty) {
          // Normal turn: optimistic enable (server validates real legality). We gray-out non-matches to help UX.
          enabled = clientCanMatchTop(c);
        } else if (pendingStackAgainstMe) {
          // Only same penalty type can be stacked (or draw by clicking draw pile).
          enabled = (c.type === penalty.type); // draw2 or wild_draw4
        } else {
          // A stack is happening but it's not my turn → can't play (except relax handled above)
          enabled = false;
        }
      }

      if (enabled) el.classList.add("clickable");
      else el.classList.remove("clickable");

      // Click handler
      el.onclick = () => {
        if (!enabled) return;
        // If this is a RELAX play and any stack is pending, use out-of-turn endpoint
        if (penalty && c.type === "wild_relax") {
          // If server needs a color, it will emit chooseColor
          socket.emit("playRelax", { index: idx });
          return;
        }
        // Normal in-turn play
        if (started && current === me.id) {
          socket.emit("playCard", { index: idx });
        }
      };

      $hand.appendChild(el);
    });
  }

  function clientCanMatchTop(card) {
    if (!top) return true;
    const isWild = String(card.type || "").startsWith("wild");
    if (isWild) return true;
    if (card.type === "number") {
      return (card.color === color) || (card.value === top.value);
    }
    // actions & specialties: color or type match allowed
    return (card.color === color) || (card.type === top.type);
  }

  // ---------- Prompts ----------
  function clearPrompt() {
    if ($prompts) $prompts.innerHTML = "";
  }

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

  // Look: choose order of top4
  function renderLookOrderPrompt(data, timeoutMs) {
    if (!$prompts) return;
    const top4 = (data && data.top4) || []; // [{img, idx}]
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
      img.title = `Click to set order (#${i})`;
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
    ok.onclick = () => {
      // Server expects order length 4; if not complete, it will default
      socket.emit("promptChoice", { kind: "lookOrder", order: picks });
      clearPrompt();
    };
    btns.appendChild(ok);

    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.onclick = () => { clearPrompt(); };
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

  // Rainbow: select one of each color from your hand
  function renderRainbowPrompt(data, timeoutMs) {
    if (!$prompts) return;
    const hand = (data && data.hand) || []; // [{idx,color,type,img}]
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
      img.title = `${c.color} ${c.type}`;
      img.onclick = () => {
        if (picks.has(c.idx)) {
          picks.delete(c.idx);
          img.classList.remove("selected");
        } else {
          picks.add(c.idx);
          img.classList.add("selected");
        }
      };
      grid.appendChild(img);
    });
    wrap.appendChild(grid);

    const btns = document.createElement("div");
    const ok = document.createElement("button");
    ok.textContent = "Discard 4 (one of each)";
    ok.onclick = () => {
      socket.emit("promptChoice", { kind:"rainbowSelects", picks: Array.from(picks) });
      clearPrompt();
    };
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

  // Pinky: choose target
  function renderTargetPicker(data, timeoutMs) {
    if (!$prompts) return;
    const targets = (data && data.targets) || []; // [{sid,name}]

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
    ok.onclick = () => {
      socket.emit("promptChoice", { kind:"targetPicker", targetSid: selected });
      clearPrompt();
    };
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

  // Shopping: pick my two & their one
  function renderShoppingPrompt(data, timeoutMs) {
    if (!$prompts) return;
    const mine = (data && data.mine) || [];     // [{idx,img}]
    const theirs = (data && data.theirs) || []; // [{idx,img}]

    const wrap = document.createElement("div");
    wrap.className = "prompt shopping";

    const title = document.createElement("div");
    title.className = "prompt-title";
    title.textContent = "Shopping: pick TWO to give, and ONE to take";
    wrap.appendChild(title);

    const cols = document.createElement("div");
    cols.className = "prompt-cols";

    // My two
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

    // Their one
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
        // visual: highlight only one (lightweight)
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
    ok.onclick = () => {
      socket.emit("promptChoice", { kind:"shoppingTrade", myTwo: Array.from(mineSet), theirOne: theirPick });
      clearPrompt();
    };
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

  function makeLabel(text) {
    const l = document.createElement("div");
    l.className = "prompt-label";
    l.textContent = text;
    return l;
  }

  function tickCountdown(el, ms) {
    if (!el) return;
    const end = Date.now() + (ms || 10000);
    const f = () => {
      const left = Math.max(0, end - Date.now());
      el.textContent = ` (${Math.ceil(left/1000)}s)`;
      if (left <= 0) return;
      requestAnimationFrame(f);
    };
    f();
  }

  // ---------- Convenience actions (buttons you may already have) ----------
  const btnDraw = byId("btnDraw");
  if (btnDraw) btnDraw.onclick = () => {
    if (started && current === me.id) socket.emit("drawCard");
  };
  const btnUno = byId("btnUno");
  if (btnUno) btnUno.onclick = () => socket.emit("callUno");

  // ---------- Minimal styles (only class toggles) ----------
  // NOTE: We’re not injecting CSS; we rely on your existing CSS.
  // .clickable    -> cursor:pointer handled by your sheet
  // .selected     -> highlight a chosen card in prompts
  // .prompt-*     -> whatever default you already have

  // ---------- That’s all ----------
  function logLine(t) {
    if (!$chatLog) return;
    const el = document.createElement("div");
    el.className = "chat-announce";
    el.textContent = t;
    $chatLog.appendChild(el);
    $chatLog.scrollTop = $chatLog.scrollHeight;
  }
})();
