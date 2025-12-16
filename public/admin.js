/*
  admin.js — Fantastic Happiness UNO admin console (MATCHED TO PROVIDED server.js)
  + Renders Players table into #admin-players from admin:state.players
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

  const adminPlayers = document.getElementById("admin-players");

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

  function pill(text, cls) {
    return `<span class="pill ${cls || ""}">${esc(text)}</span>`;
  }

  // -------- /lobbies endpoint (authoritative) --------
  async function fetchLobbies() {
    try {
      const res = await fetch("/lobbies", { cache: "no-store" });
      const data = await res.json();
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

    socket.emit("join", { name: "Admin", lobby, spectator: true });

    logLine(`Joined lobby <b>${esc(lobby)}</b> (Admin).`);
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

  // -------- Players table --------
  function renderPlayersPanel(players, currentSid, penalty) {
    if (!adminPlayers) return;

    const ps = Array.isArray(players) ? players.slice() : [];

    // Sort: seated first, then spectators; within group by name
    ps.sort((a, b) => {
      const as = !!a.spectator, bs = !!b.spectator;
      if (as !== bs) return as ? 1 : -1;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });

    const penaltyTarget = penalty?.targetSid || null;

    const rowsHtml = ps.map(p => {
      const isTurn = currentSid && p.sid === currentSid;
      const isPenalty = penaltyTarget && p.sid === penaltyTarget;

      const statusBits = [];
      statusBits.push(p.spectator ? pill("Spectator", "muted") : pill("Seated", "good"));
      statusBits.push(p.connected ? pill("Connected", "good") : pill("Disconnected", "warn"));
      if (isTurn) statusBits.push(pill("TURN", "good"));
      if (isPenalty) statusBits.push(pill("PENALTY TARGET", "warn"));

      const handCount = Number.isFinite(Number(p.hand)) ? Number(p.hand) : 0;

      return `
        <tr>
          <td><span style="font-weight:800;">${esc(p.name || "Player")}</span><div class="fh-muted" style="margin-top:4px;">${esc(p.sid || "")}</div></td>
          <td>${handCount}</td>
          <td>${statusBits.join(" ")}</td>
        </tr>
      `;
    }).join("");

    adminPlayers.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Player</th>
            <th>Hand</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || `<tr><td colspan="3" class="fh-muted">No players in this lobby.</td></tr>`}
        </tbody>
      </table>
    `;
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

  // Soundboard
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

    const last = localStorage.getItem("fh_admin_lobby");
    if (last) {
      if (lobbySelect) lobbySelect.value = last;
      joinLobby(last);
    }
  });

  socket.on("warn", (msg) => logLine(`<span style="color:#fbbf24;">Warn:</span> ${esc(msg || "")}`));
  socket.on("announce", (txt) => logLine(`<span style="opacity:.85;">•</span> ${esc(txt || "")}`));
  socket.on("chat", ({ fromName, text }) => logLine(`<b>${esc(fromName || "Player")}:</b> ${esc(text || "")}`));

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

    // NEW: Players panel render
    renderPlayersPanel(s.players || [], s.currentSid || null, s.penalty || null);
  });

  // Keep state & leaderboard fresh
  setInterval(() => {
    if (currentLobby) socket.emit("admin:pullState");
    loadLeaderboard();
  }, 8000);
})();
