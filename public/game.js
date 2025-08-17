// Client with specialty flows, stacking narration via announcements, HAPPY emoji moderation,
// Look/Shopping/Rainbow prompts, Relax interrupt, and improved timer label.
(function boot(){
  function ensureClientId(){
    try{
      const k="unoClientId"; let id = localStorage.getItem(k);
      if (!id) { id = "c_"+Math.random().toString(36).slice(2)+Date.now().toString(36); localStorage.setItem(k, id); }
      return id;
    }catch{ return "c_"+Math.random().toString(36).slice(2); }
  }
  function waitIO(tries=0){
    if (window.io) return start();
    if (tries>200) { console.error("Socket.IO failed to load"); return; }
    setTimeout(()=>waitIO(tries+1), 25);
  }

  function start(){
    const socket = io();
    const me = { clientId: ensureClientId(), id:null, name:null };

    // DOM
    const joinBtn = document.getElementById("join-btn");
    const nameInput = document.getElementById("name");
    const joinScreen = document.getElementById("join-screen");
    const gameScreen = document.getElementById("game-screen");
    const playerList = document.getElementById("player-list");
    const drawPile = document.getElementById("draw-pile");
    const discardTop = document.getElementById("discard-top");
    const colorBadge = document.getElementById("color-badge");
    const turnIndicator = document.getElementById("turn-indicator");
    const handDiv = document.getElementById("player-hand");
    const unoBtn = document.getElementById("uno-btn");
    const chatLog = document.getElementById("chat-log");
    const chatInput = document.getElementById("chat-input");
    
    // Local state
    let started=false, countdownEndsAt=null, turnEndsAt=null, current=null, dir=1, color=null, top=null, penalty=null;
    let playersState=[], myHand=[], isMyTurn=false;

    // Join
    if (joinBtn) joinBtn.onclick = ()=>{
      const name = (nameInput?.value||"").trim();
      socket.emit("join", { name, clientId: me.clientId });
    };

    socket.on("me", (m)=>{ me.id = m.id; me.name = m.name; me.spectator = !!m.spectator; });

    // Basic render helpers
    function legal(c){
      if (!top || !color) return true;
      if (String(c.type||"").startsWith("wild")) return true;
      if (c.type === "number") return (c.color===color || c.value===top.value);
      return (c.color===color || c.type===top.type);
    }

    // State updates
    socket.on("connected", ()=>{
      if (joinScreen) joinScreen.style.display = "none";
      if (gameScreen) gameScreen.style.display = "block";
    });

    socket.on("state", (s)=>{
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
      isMyTurn = (current === me.id);

      if (colorBadge) colorBadge.textContent = color ? color.toUpperCase() : "—";
      if (discardTop) discardTop.src = top ? `assets/cards/${top.img}` : `assets/cards/back.png`;

      renderPlayers(s.players, current);
      renderPiles();
      renderTimer();
      renderHand();
    });

    socket.on("handSnapshot", (hand)=>{ myHand = hand || []; renderHand(); });

    // Announce & chat
    socket.on("announce", (text)=>{
      const div = document.createElement("div");
      div.textContent = text; chatLog.appendChild(div); chatLog.scrollTop = chatLog.scrollHeight;
    });

    socket.on("chat", ({ fromName, text })=>{
      const div = document.createElement("div");
      div.textContent = `${fromName}: ${text}`; chatLog.appendChild(div); chatLog.scrollTop = chatLog.scrollHeight;
    });

    function renderPlayers(players, cur){
      if (!playerList) return;
      playerList.innerHTML = "";
      (players||[]).forEach(p=>{
        const row = document.createElement("div");
        row.className = "row";
        const s = document.createElement("span");
        s.textContent = p.name + (p.sid===cur ? " ←" : "");
        row.appendChild(s);
        playerList.appendChild(row);
      });
    }

    function renderPiles(){
      if (drawPile) drawPile.src = "assets/cards/back.png";
      if (discardTop) discardTop.src = top ? `assets/cards/${top.img}` : "assets/cards/back.png";
      if (colorBadge) colorBadge.textContent = color ? color.toUpperCase() : "—";
    }

    // prompts
    function openColorPicker(cb){
      // Minimal prompt: just choose via built-in prompt (no UI change)
      const c = prompt("Pick a color (red, blue, green, yellow):","");
      cb((c||"").trim().toLowerCase());
    }

    // Action hooks
    if (unoBtn) unoBtn.onclick = ()=> socket.emit("callUno");
    if (drawPile) drawPile.onclick = ()=> socket.emit("drawCard");

    function renderHand(){
      handDiv.innerHTML="";
      if (me.spectator || !started) return;
      myHand.forEach((c, i)=>{
        const d = document.createElement("div");
        d.className = "card";
        const img = document.createElement("img");
        img.src = `assets/cards/${c.img}`; img.alt = `${c.color} ${c.type}`;
        d.appendChild(img);

        let clickable = false;
        if (isMyTurn) {
          if (penalty && penalty.target === me.id) { clickable = (c.type === (penalty.type)); }
          else { clickable = legal(c); }
        }
        if (!isMyTurn && penalty && c.type==="wild_relax") clickable = true;

        if (clickable) {
          d.classList.add("playable");
          if (!isMyTurn && penalty && c.type==="wild_relax") {
            d.addEventListener("click", ()=> openColorPicker((chosen)=> socket.emit("playRelax", { index:i, color: chosen })));
          } else {
            d.addEventListener("click",()=>socket.emit("playCard",{index:i}));
          }
        } else {
          d.classList.add("unplayable");
        }
        handDiv.appendChild(d);
      });
      unoBtn && (unoBtn.disabled = !(myHand.length===1 && started && !me.spectator));
    }
    function msToSec(ms){ return Math.max(0, Math.ceil(ms/1000)); }
    function renderTimer(){
      if (countdownEndsAt && !started) {
        turnIndicator.textContent = `Game starts in ${msToSec(countdownEndsAt - Date.now())}s`;
        return;
      }
      if (!started || !turnEndsAt) { turnIndicator.textContent = "—"; return; }
      const secs = msToSec(turnEndsAt - Date.now());
      turnIndicator.textContent = `Your move: ${secs}s`;
    }

    // Happy flag
    chatLog?.addEventListener("click", (e)=>{
      const t = e.target;
      if (t?.dataset?.msgId) {
        socket.emit("flagHappy", { messageId: t.dataset.msgId });
      }
    });

    // Send chat
    const chatSend = document.getElementById("chat-send");
    if (chatSend) chatSend.onclick = ()=>{
      const text = (chatInput?.value||"").trim();
      if (!text) return;
      const id = "m_"+Math.random().toString(36).slice(2);
      socket.emit("chat", { text, id });
      chatInput.value="";
    };
    chatInput?.addEventListener("keydown", (e)=>{ if (e.key==="Enter") chatSend?.click(); });

    // Connect the UI
    window.addEventListener("load", ()=>{
      if (joinScreen) joinScreen.style.display = "block";
      if (gameScreen) gameScreen.style.display = "none";
    });

    socket.on("players", ()=>{}); // no-op for now

    socket.on("connect", ()=>{
      socket.emit("join", { name: (nameInput?.value||"").trim(), clientId: me.clientId });
      if (joinScreen) joinScreen.style.display = "none";
      if (gameScreen) gameScreen.style.display = "block";
    });
  }

  waitIO();
})();
