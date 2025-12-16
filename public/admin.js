/*
  admin.js — Fantastic Happiness UNO admin console (MATCHED TO PROVIDED server.js)

  Your server supports:
    - GET /lobbies  (express route)
    - socket events:
        admin:pullState   -> emits admin:state
        admin:chat        -> broadcasts announce
        admin:sound       -> broadcasts sound
        admin:forceRoundEnd
        admin:resetGame
        admin:lobbyReset
        admin:lobbyClose

  Notes:
  - Server currently ignores spectator flag on join. I include a tiny server.js patch below
    so Admin won't auto-seat and trigger auto-start rules.
*/

(() => {
  const socket = io();

  // -------- DOM --------
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

  // -------- State --------
  let currentLobby = null;

  // -------- Utils --------
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

  // -------- /lobbies endpoint (authoritative) --------
  async function fetchLobbies() {
    try {
      const res = await fetch("/lobbies", { cache: "no-store" });
      const data = await res.json();
      // data: [{name, players, spectators, started}]
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async function refreshLobbyDropdown() {
    if (!lobbySelect) return;
    const rows = await fetchLobbies();

    const prev = lobbySelect.value || "";
    lobbySelect.innerHTML =
      `<option value="">Select a lobby…</option>` +
      rows
        .map(r => {
          const label = `${r.name}  •  players:${r.players}  spec:${r.spectators}  ${r.started ? "• started" : ""}`;
          return `<option value="${esc(r.name)}">${esc(label)}</option>`;
        })
        .join("");

    if (prev && rows.some(r => r.name === prev)) {
      lobbySelect.value = prev;
    }
  }

  // -------- Join lobby as spectator --------
  function joinLobby(lobby) {
    if (!lobby) return;
    currentLobby = lobby;
    localStorage.setItem("fh_admin_lobby", lobby);

    // Join the lobby room via your server's standard join
    // (Server currently forces spectator:false — patch below fixes that)
    socket.emit("join", { name: "Admin", lobby, spectator: true });

    logLine(`Joined lobby <b>${esc(lobby)}</b> (Admin).`);
    // Immediately request admin state snapshot
    socket.emit("admin:pullState");
    loadLeaderboard();
  }

  // -------- Leaderboard --------
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

  // -------- Wire UI --------
  if (refreshBtn) refreshBtn.addEventListener("click", refreshLobbyDropdown);

  if (lobbySelect) {
    lobbySelect.addEventListener("change", () => {
      const v = lobbySelect.value;
      if (!v) return;
      joinLobby(v);
    });
  }

  // Broadcast
  function sendMsg() {
    const msg = (adminMsg?.value || "").trim();
    if (!msg) return;
    socket.emit("admin:chat", { text: msg });
    logLine(`<span style="opacity:.85;">Broadcast:</span> ${esc(msg)}`);
    adminMsg.value = "";
  }

  if (adminSend && adminMsg) {
    adminSend.addEventListener("click", sendMsg);
    adminMsg.addEventListener("keydown", (e) => { if (e.key === "Enter") sendMsg(); });
  }

  // Admin controls (EXACT EVENT NAMES)
  if (btnResetGame) btnResetGame.addEventListener("click", () => {
    socket.emit("admin:resetGame");
    logLine(`Sent <span class="mono">${esc("admin:resetGame")}</span>`);
  });

  if (btnForceEnd) btnForceEnd.addEventListener("click", () => {
    socket.emit("admin:forceRoundEnd");
    logLine(`Sent <span class="mono">${esc("admin:forceRoundEnd")}</span>`);
  });

  if (btnResetLobby) btnResetLobby.addEventListener("click", () => {
    socket.emit("admin:lobbyReset");
    logLine(`Sent <span class="mono">${esc("admin:lobbyReset")}</span>`);
  });

  if (btnCloseLobby) btnCloseLobby.addEventListener("click", () => {
    socket.emit("admin:lobbyClose");
    logLine(`Sent <span class="mono">${esc("admin:lobbyClose")}</span>`);
  });

  // Soundboard: click any [data-sound]
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const key = t.getAttribute("data-sound");
    if (!key) return;
    socket.emit("admin:sound", { name: key });
    logLine(`Sound <b>${esc(key)}</b>`);
  });

  if (triggerCustom && customSoundInput) {
    triggerCustom.addEventListener("click", () => {
      const k = (customSoundInput.value || "").trim();
      if (!k) return;
      socket.emit("admin:sound", { name: k });
      logLine(`Sound <b>${esc(k)}</b>`);
    });
  }

  // -------- Listen for server updates --------
  socket.on("connect", async () => {
    logLine(`Connected <span class="mono">${esc(socket.id)}</span>`);
    await refreshLobbyDropdown();
    loadLeaderboard();

    // Auto-join last used lobby
    const last = localStorage.getItem("fh_admin_lobby");
    if (last) {
      // attempt to select it if present
      if (lobbySelect) lobbySelect.value = last;
      joinLobby(last);
    }
  });

  socket.on("warn", (msg) => logLine(`<span style="color:#fbbf24;">Warn:</span> ${esc(msg || "")}`));
  socket.on("announce", (txt) => logLine(`<span style="opacity:.85;">•</span> ${esc(txt || "")}`));
  socket.on("chat", ({ fromName, text }) => logLine(`<b>${esc(fromName || "Player")}:</b> ${esc(text || "")}`));

  // Your server emits this continuously from emitState()
  socket.on("admin:state", (s) => {
    if (!s) return;

    // Top card
    if (topDiscard) topDiscard.src = s.topCard?.img ? `assets/cards/${s.topCard.img}` : `assets/cards/back.png`;
    if (topMeta) {
      const tc = s.topCard || {};
      const meta = [
        `Lobby: ${s.lobby || currentLobby || "—"}`,
        `Top: ${tc.color || "—"} ${tc.type || ""}${typeof tc.value === "number" ? " " + tc.value : ""}`
      ].join("\n");
      topMeta.textContent = meta;
      topMeta.style.whiteSpace = "pre-line";
    }

    setText(gsCurrent, s.currentName ? `${s.currentName} (${s.currentSid || ""})` : (s.currentSid || "—"));
    setText(gsDirection, s.direction || "—");
    setText(gsColor, s.color || "—");
    setText(gsStarted, String(!!s.started));
    setText(gsEnds, fmtTime(s.turnEndsAt));
    setText(gsDeck, s.deckSize);
    setText(gsDiscard, s.discardSize);

    if (s.penalty && s.penalty.amount) {
      setText(gsPenalty, `${s.penalty.amount} (${s.penalty.kind || "?"}) on ${s.penalty.targetSid || "?"}`);
    } else {
      setText(gsPenalty, "—");
    }

    setText(gsFlags, (s.roundFlags && s.roundFlags.length) ? s.roundFlags.join(", ") : "—");
  });

  // Keep state & leaderboard fresh
  setInterval(() => {
    if (currentLobby) socket.emit("admin:pullState");
    loadLeaderboard();
  }, 8000);
})();
