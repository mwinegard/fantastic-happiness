/*
  admin.js — Fantastic Happiness UNO admin console (refined UI compatible)

  Goals:
  - Join as a SPECTATOR so it doesn't interfere with seating/turn logic
  - Select lobby, receive state updates, show basic game state snapshot
  - Provide safe admin actions (emit existing server events if present)
  - Broadcast table message
  - Soundboard buttons (data-sound="key") -> emit "adminSound" or "sound" depending on server

  NOTE:
  This is written to be tolerant:
  - If certain events don't exist server-side, it logs a warning instead of crashing.
*/

(() => {
  const socket = io();

  // --------- DOM ----------
  const lobbySelect = document.getElementById("lobby-select");
  const refreshBtn = document.getElementById("refresh-lobbies");

  const topDiscard = document.getElementById("top-discard");
  const topMeta = document.getElementById("top-meta");

  const gsCurrent = document.getElementById("gs-current");
  const gsDirection = document.getElementById("gs-direction");
  const gsColor = document.getElementById("gs-color");
  const gsStarted = document.getElementById("gs-started");
  const gsEnds = document.getElementById("gs-ends");
  const gsDeck = document.getElementById("gs-deck");
  const gsDiscard = document.getElementById("gs-discard");
  const gsPenalty = document.getElementById("gs-penalty");
  const gsFlags = document.getElementById("gs-flags");

  const btnResetGame = document.getElementById("btn-reset-game");
  const btnForceEnd = document.getElementById("btn-force-end");
  const btnResetLobby = document.getElementById("btn-reset-lobby");
  const btnCloseLobby = document.getElementById("btn-close-lobby");

  const adminMsg = document.getElementById("admin-msg");
  const adminSend = document.getElementById("admin-send");

  const adminLog = document.getElementById("admin-log");
  const adminLb = document.getElementById("admin-leaderboard");

  const customSoundInput = document.getElementById("custom-sound");
  const triggerCustom = document.getElementById("trigger-custom");

  // --------- State ----------
  let currentLobby = null;
  let joined = false;

  // --------- Utils ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[m]));
  }

  function logLine(html) {
    if (!adminLog) return;
    const d = document.createElement("div");
    d.className = "line";
    d.innerHTML = html;
    adminLog.prepend(d);
  }

  function setText(el, v) {
    if (!el) return;
    el.textContent = (v == null || v === "") ? "—" : String(v);
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString();
  }

  async function loadLeaderboard() {
    if (!adminLb) return;
    try {
      const res = await fetch("/leaderboard", { cache: "no-store" });
      const data = await res.json();
      adminLb.innerHTML = renderBoard(Array.isArray(data) ? data : []);
    } catch {
      adminLb.textContent = "Failed to load leaderboard.";
    }
  }

  function renderBoard(rows) {
    const tr = r =>
      `<tr><td>${esc(r.name)}</td><td>${Number(r.wins || 0)}</td><td>${Number(r.points || 0)}</td></tr>`;
    return `<table><thead><tr><th>Name</th><th>Wins</th><th>Points</th></tr></thead><tbody>${rows.map(tr).join("")}</tbody></table>`;
  }

  // --------- Lobby discovery ----------
  function requestLobbies() {
    // Some server builds expose "lobbies" or "adminLobbies" or "getLobbies"
    socket.emit("getLobbies");
    socket.emit("adminGetLobbies");
    socket.emit("lobbies");
  }

  function setLobbyOptions(lobbies) {
    if (!lobbySelect) return;
    const list = Array.isArray(lobbies) ? lobbies : [];

    // Preserve selection if possible
    const prev = lobbySelect.value || "";

    lobbySelect.innerHTML = `<option value="">Select a lobby…</option>` + list
      .map(l => `<option value="${esc(l)}">${esc(l)}</option>`)
      .join("");

    if (prev && list.includes(prev)) lobbySelect.value = prev;
  }

  // --------- Join as spectator ----------
  function joinLobby(lobby) {
    if (!lobby) return;
    currentLobby = lobby;

    // Try common server join contracts:
    // - join({name,lobby,spectator})
    // - join({name,lobby}) (server ignores spectator)
    socket.emit("join", { name: "Admin", lobby, spectator: true });

    joined = true;
    logLine(`Joined lobby <b>${esc(lobby)}</b> as spectator.`);
  }

  // --------- Event wiring ----------
  if (refreshBtn) refreshBtn.addEventListener("click", () => requestLobbies());

  if (lobbySelect) {
    lobbySelect.addEventListener("change", () => {
      const v = lobbySelect.value;
      if (!v) return;
      joinLobby(v);
    });
  }

  // Broadcast message
  function sendMsg() {
    const msg = (adminMsg?.value || "").trim();
    if (!msg) return;

    // Try common server event names
    socket.emit("adminAnnounce", { lobby: currentLobby, text: msg });
    socket.emit("announce", msg); // some servers broadcast based on socket lobby
    socket.emit("chat", { text: msg }); // fallback to chat channel

    logLine(`<span style="opacity:.85;">Broadcast:</span> ${esc(msg)}`);
    adminMsg.value = "";
  }

  if (adminSend && adminMsg) {
    adminSend.addEventListener("click", sendMsg);
    adminMsg.addEventListener("keydown", (e) => { if (e.key === "Enter") sendMsg(); });
  }

  // Admin controls (best-effort emit)
  function emitAdmin(action, payload) {
    socket.emit(action, payload || {});
    logLine(`Sent <span class="mono">${esc(action)}</span>`);
  }

  if (btnResetGame) btnResetGame.addEventListener("click", () => {
    emitAdmin("adminResetGame", { lobby: currentLobby });
    emitAdmin("resetGame", { lobby: currentLobby });
  });

  if (btnForceEnd) btnForceEnd.addEventListener("click", () => {
    emitAdmin("adminForceEnd", { lobby: currentLobby });
    emitAdmin("forceRoundEnd", { lobby: currentLobby });
  });

  if (btnResetLobby) btnResetLobby.addEventListener("click", () => {
    emitAdmin("adminResetLobby", { lobby: currentLobby });
    emitAdmin("resetLobby", { lobby: currentLobby });
  });

  if (btnCloseLobby) btnCloseLobby.addEventListener("click", () => {
    emitAdmin("adminCloseLobby", { lobby: currentLobby });
    emitAdmin("closeLobby", { lobby: currentLobby });
  });

  // Soundboard: click any [data-sound]
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;

    const key = t.getAttribute("data-sound");
    if (!key) return;

    // Try admin sound channel, then generic
    socket.emit("adminSound", { lobby: currentLobby, key });
    socket.emit("sound", key);

    logLine(`Sound <b>${esc(key)}</b>`);
  });

  if (triggerCustom && customSoundInput) {
    triggerCustom.addEventListener("click", () => {
      const k = (customSoundInput.value || "").trim();
      if (!k) return;
      socket.emit("adminSound", { lobby: currentLobby, key: k });
      socket.emit("sound", k);
      logLine(`Sound <b>${esc(k)}</b>`);
    });
  }

  // --------- Listen for common server responses ----------
  socket.on("connect", () => {
    logLine(`Connected <span class="mono">${esc(socket.id)}</span>`);
    requestLobbies();
    loadLeaderboard();
  });

  socket.on("warn", (msg) => logLine(`<span style="color:#fbbf24;">Warn:</span> ${esc(msg || "")}`));
  socket.on("announce", (txt) => logLine(`<span style="opacity:.85;">•</span> ${esc(txt || "")}`));
  socket.on("chat", ({ fromName, text }) => logLine(`<b>${esc(fromName || "Player")}:</b> ${esc(text || "")}`));

  // Lobby list payloads
  socket.on("lobbies", (payload) => {
    // payload could be ["default","x"] or {lobbies:[...]}
    const list = Array.isArray(payload) ? payload : (payload && payload.lobbies) || [];
    if (list.length) setLobbyOptions(list);
  });
  socket.on("adminLobbies", (payload) => {
    const list = Array.isArray(payload) ? payload : (payload && payload.lobbies) || [];
    if (list.length) setLobbyOptions(list);
  });
  socket.on("getLobbies", (payload) => {
    const list = Array.isArray(payload) ? payload : (payload && payload.lobbies) || [];
    if (list.length) setLobbyOptions(list);
  });

  // State updates — your server likely sends "state"
  socket.on("state", (state) => {
    if (!state) return;

    // top discard
    if (topDiscard) topDiscard.src = state.top?.img ? `assets/cards/${state.top.img}` : `assets/cards/back.png`;
    if (topMeta) {
      const t = state.top || {};
      const meta = [
        `Top: ${t.color || "—"} ${t.type || ""}${typeof t.value === "number" ? " " + t.value : ""}`,
        `Lobby: ${currentLobby || "—"}`
      ].join("\n");
      topMeta.textContent = meta;
      topMeta.style.whiteSpace = "pre-line";
    }

    // basic fields
    setText(gsCurrent, state.current || "—");
    setText(gsDirection, state.direction || "—");
    setText(gsColor, state.color || "—");
    setText(gsStarted, String(!!state.started));
    setText(gsEnds, fmtTime(state.turnEndsAt));
    setText(gsDeck, state.deck ? state.deck.length : "—");
    setText(gsDiscard, state.discard ? state.discard.length : "—");

    if (state.pendingPenalty?.amount) {
      setText(gsPenalty, `${state.pendingPenalty.amount} (targetSid=${state.pendingPenalty.targetSid || "?"})`);
    } else {
      setText(gsPenalty, "—");
    }

    const flags = [];
    if (state.awaitingColorChoice) flags.push("awaitingColorChoice");
    if (state.awaitingRainbow) flags.push("awaitingRainbow");
    if (state.awaitingShopping) flags.push("awaitingShopping");
    if (state.awaitingPromise) flags.push("awaitingPromise");
    setText(gsFlags, flags.length ? flags.join(", ") : "—");
  });

  // Some servers may require an explicit "adminJoin" flow — try it too
  socket.on("me", (info) => {
    // If server supports spectator on join, you’ll see spectator=true here.
    logLine(`Server acknowledged identity: <span class="mono">${esc(info?.sid || "")}</span>`);
  });

  // Keep leaderboard fresh
  setInterval(() => loadLeaderboard(), 12000);

  // Try to join last used lobby automatically
  const lastLobby = localStorage.getItem("fh_admin_lobby");
  if (lastLobby) {
    // Preload list (may get replaced) and attempt join
    joinLobby(lastLobby);
  }

  // Persist selection
  if (lobbySelect) {
    lobbySelect.addEventListener("change", () => {
      if (lobbySelect.value) localStorage.setItem("fh_admin_lobby", lobbySelect.value);
    });
  }

  // If we never got lobby list, give a hint
  setTimeout(() => {
    if (!joined && lobbySelect && lobbySelect.options.length <= 1) {
      logLine(
        `No lobby list received. If your server doesn't expose lobbies, type /?lobby=YOURLOBBY on the player page and use that name here.`
      );
    }
  }, 2500);
})();
