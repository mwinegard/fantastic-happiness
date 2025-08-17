// public/admin.js
(function () {
  const socket = io();

  // ======== DOM refs ========
  const sel = document.getElementById("lobby-select");
  const btnRef = document.getElementById("refresh-lobbies");
  const adminMsg = document.getElementById("admin-msg");
  const adminSend = document.getElementById("admin-send");

  // Game State panel
  const gsStarted = document.getElementById("gs-started");
  const gsDir = document.getElementById("gs-direction");
  const gsColor = document.getElementById("gs-color");
  const gsCurrent = document.getElementById("gs-current");
  const gsEnds = document.getElementById("gs-ends");
  const gsDeck = document.getElementById("gs-deck");
  const gsDiscard = document.getElementById("gs-discard");
  const gsPenalty = document.getElementById("gs-penalty");
  const gsFlags = document.getElementById("gs-flags");

  // Players
  const playersTableBody = document.querySelector("#players-table tbody");

  // Log
  const adminLog = document.getElementById("admin-log");

  // Top discard
  const topImg = document.getElementById("top-discard");
  const topMeta = document.getElementById("top-meta");

  // Admin chat (table)
  const adminChat = document.getElementById("admin-chat");
  const adminChatSend = document.getElementById("admin-chat-send");

  // Sounds
  const sndBtns = document.querySelectorAll("button.snd");
  const customSound = document.getElementById("custom-sound");
  const triggerCustom = document.getElementById("trigger-custom");

  // Leaderboard target (merged from admin-leaderboard.js)
  const leaderboardRoot = document.getElementById("admin-leaderboard");

  // ======== Lobby selection & join ========
  btnRef.onclick = loadLobbies;
  loadLobbies();

  async function loadLobbies() {
    try {
      const res = await fetch("/lobbies", { cache: "no-store" });
      const data = await res.json();
      sel.innerHTML = (data || [])
        .map(
          (x) =>
            `<option value="${esc(x.name)}">${esc(x.name)} (${x.players}P/${x.spectators}S${
              x.started ? "; live" : ""
            })</option>`
        )
        .join("");
      if (!data || !data.length)
        sel.innerHTML = `<option value="default">default (0P/0S)</option>`;
    } catch {
      sel.innerHTML = `<option value="default">default</option>`;
    }
  }

  function joinSelectedLobby() {
    if (!sel.value) return;
    socket.emit("join", { name: "Admin", lobby: sel.value }); // idempotent
    // pull an initial snapshot
    setTimeout(() => socket.emit("admin:pullState"), 150);
  }

  sel.addEventListener("change", joinSelectedLobby);
  setTimeout(joinSelectedLobby, 250); // auto-join first lobby on load

  // ======== Admin announce to lobby ========
  adminSend.onclick = () => {
    if (!sel.value) return;
    socket.emit("join", { name: "Admin", lobby: sel.value });
    setTimeout(() => socket.emit("admin:chat", { text: adminMsg.value }), 150);
    adminMsg.value = "";
  };

  // ======== Admin-only chat to table ========
  adminChatSend.onclick = () => {
    if (!sel.value) return;
    socket.emit("join", { name: "Admin", lobby: sel.value });
    setTimeout(() => socket.emit("admin:chat", { text: adminChat.value }), 150);
    adminChat.value = "";
  };

  // ======== Sound triggers ========
  function ensureJoinedLobby() {
    if (!sel.value) return;
    socket.emit("join", { name: "Admin", lobby: sel.value });
  }
  sndBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      ensureJoinedLobby();
      const sound = btn.getAttribute("data-sound");
      socket.emit("admin:sound", { name: sound });
    });
  });
  if (triggerCustom) {
    triggerCustom.addEventListener("click", () => {
      ensureJoinedLobby();
      const key = (customSound.value || "").trim();
      if (!key) return;
      socket.emit("admin:sound", { name: key });
    });
  }

  // ======== Live admin state feed ========
  socket.on("admin:state", (snap) => {
    try {
      renderState(snap || {});
    } catch {}
  });

  // Also show lobby announcements in admin log
  socket.on("announce", (txt) => appendLog(String(txt || "")));

  // ======== Leaderboard (merged) ========
  let lastLeaderboardAt = 0;
  async function refreshLeaderboard(force = false) {
    const now = Date.now();
    if (!leaderboardRoot) return;
    if (!force && now - lastLeaderboardAt < 3000) return;
    lastLeaderboardAt = now;
    try {
      const res = await fetch("/leaderboard", { cache: "no-store" });
      const data = await res.json();
      leaderboardRoot.innerHTML = renderLeaderboard(data || []);
    } catch {
      leaderboardRoot.textContent = "Failed to load leaderboard.";
    }
  }

  function renderLeaderboard(rows) {
    const tr = (r) =>
      `<tr><td>${esc(r.name)}</td><td>${Number(r.wins || 0)}</td><td>${Number(
        r.points || 0
      )}</td></tr>`;
    return `<table class="compact"><thead><tr><th>Name</th><th>Wins</th><th>Points</th></tr></thead><tbody>${(rows ||
      [])
      .map(tr)
      .join("")}</tbody></table>`;
  }

  refreshLeaderboard(true);
  setInterval(refreshLeaderboard, 5000);

  // ======== Renderers ========
  function renderState(s) {
    // Game State
    gsStarted.textContent = s.started ? "Yes" : "No";
    gsDir.textContent = s.direction || "—";
    gsColor.textContent = s.color ? s.color.toUpperCase() : "—";
    gsCurrent.textContent = s.currentName || "—";
    gsEnds.textContent = s.turnEndsAt ? `${secs(s.turnEndsAt - Date.now())}s` : "—";
    gsDeck.textContent = s.deckSize ?? "—";
    gsDiscard.textContent = s.discardSize ?? "—";

    if (s.penalty && s.penalty.amount) {
      const who = s.penalty.targetSid ? nameOf(s.penalty.targetSid, s.players) : null;
      gsPenalty.textContent = `+${s.penalty.amount} ${s.penalty.kind}${
        who ? ` → ${who}` : ""
      }`;
    } else {
      gsPenalty.textContent = "—";
    }

    gsFlags.innerHTML =
      s.roundFlags && s.roundFlags.length
        ? s.roundFlags.map((f) => `<span class="pill">${esc(f)}</span>`).join(" ")
        : "—";

    // Players
    playersTableBody.innerHTML = (s.players || [])
      .map((p) => {
        const status = p.spectator ? "Spectator" : p.connected ? "Active" : "Disconnected";
        return `<tr>
          <td>${esc(p.name)}</td>
          <td>${Number(p.hand || 0)}</td>
          <td>${esc(status)}</td>
        </tr>`;
      })
      .join("");

    // Top Discard
    if (s.topCard && s.topCard.img) {
      topImg.src = `assets/cards/${s.topCard.img}`;
      topMeta.textContent = `${s.topCard.color || "?"} ${s.topCard.type || ""}${
        Number.isFinite(s.topCard.value) ? " " + s.topCard.value : ""
      }`;
    } else {
      topImg.src = `assets/cards/back.png`;
      topMeta.textContent = "—";
    }
  }

  // ======== Utils ========
  function appendLog(t) {
    const d = document.createElement("div");
    d.textContent = t;
    adminLog.appendChild(d);
    adminLog.scrollTop = adminLog.scrollHeight;
  }

  function nameOf(sid, players) {
    const p = (players || []).find((x) => x.sid === sid);
    return p ? p.name : sid;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[m]));
  }

  function secs(ms) {
    return Math.max(0, Math.ceil((+ms || 0) / 1000));
  }
})();
