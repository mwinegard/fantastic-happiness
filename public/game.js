// Robust client boot: wait for io() if fallback CDN is loading
(function boot(){
  function start(){
    const socket = io({ autoConnect:true, transports:["polling","websocket"] });
    window.socket = socket; // for inline fallback

    // --- State
    let me = { id:null, name:null, spectator:false };
    let started=false, current=null, dir=1, color=null, top=null;
    let turnEndsAt=null, countdownEndsAt=null, myHand=[], isMyTurn=false;
    let ready=false;

    // --- Elements
    const joinBtn = document.getElementById("join-btn");
    const nameInput = document.getElementById("name");
    const joinScreen = document.getElementById("join-screen");
    const gameScreen = document.getElementById("game-screen");
    const playerList = document.getElementById("player-list");
    const drawPile = document.getElementById("draw-pile");
    const discardTop = document.getElementById("discard-top");
    const handDiv = document.getElementById("player-hand");
    const wildButtons = document.getElementById("wild-buttons");
    const unoBtn = document.getElementById("uno-btn");
    const chatLog = document.getElementById("chat-log");
    const chatInput = document.getElementById("chat-input");
    const chatSend = document.getElementById("chat-send");
    const turnIndicator = document.getElementById("turn-indicator");
    const dirLabel = document.getElementById("dir-label");
    const colorLabel = document.getElementById("color-label");

    // --- UI helpers
    function renderPlayers(list, cur){
      playerList.innerHTML = "";
      (list||[]).forEach(p=>{
        const li = document.createElement("li");
        if (p.id===me.id) li.classList.add("me");
        if (p.id===cur) li.classList.add("turn");
        li.innerHTML = `<span>${p.name}${p.spectator?" (spectator)":""}</span><span>${p.spectator?"—":p.handCount}</span>`;
        playerList.appendChild(li);
      });
    }
    function renderTopCard(card){
      discardTop.className = "card";
      if (!card) { discardTop.classList.add("back"); discardTop.textContent=""; return; }
      if (card.type==="number"){
        discardTop.classList.add(card.color, "num");
        discardTop.textContent = String(card.value);
      } else {
        discardTop.classList.add(card.color==="wild" ? "back" : card.color, card.type);
        discardTop.textContent = "";
      }
    }
    function legal(card){
      if (!started || !top) return false;
      if (card.type==="wild"||card.type==="wild_draw4") return true;
      if (card.type==="number") return (card.color===color || (typeof top.value!=="undefined" && card.value===top.value));
      return (card.color===color || card.type===top.type);
    }
    function renderHand(){
      handDiv.innerHTML="";
      if (me.spectator || !started) return;
      myHand.forEach((c, i)=>{
        const d = document.createElement("div");
        d.className = "card " + (c.type==="number" ? `${c.color} num` : (c.color==="wild" ? "back" : c.color) + " " + c.type);
        if (c.type==="number") d.textContent = String(c.value);
        const ok = isMyTurn && legal(c);
        d.classList.add(ok ? "playable" : "unplayable");
        if (ok) d.addEventListener("click",()=>socket.emit("playCard",{index:i}));
        handDiv.appendChild(d);
      });
      unoBtn.disabled = !(myHand.length===2 && started && !me.spectator);
    }
    function renderPiles(){
      renderTopCard(top);
      dirLabel.textContent = `Direction: ${dir===1?"→":"←"}`;
      colorLabel.textContent = `Color: ${color?color.toUpperCase():"—"}`;
    }
    function msToSec(ms){ return Math.max(0, Math.ceil(ms/1000)); }
    function renderTimer(){
      if (countdownEndsAt && !started) turnIndicator.textContent = `Game starts in ${msToSec(countdownEndsAt - Date.now())}s`;
      else if (turnEndsAt && started)  turnIndicator.textContent = `Your turn ends in ${msToSec(turnEndsAt - Date.now())}s`;
      else turnIndicator.textContent = "—";
    }
    setInterval(renderTimer, 250);

    // --- Socket lifecycle
    socket.on("connect", ()=>{ ready=true; });
    socket.on("disconnect", ()=>{ ready=false; });
    socket.on("helloAck", (p)=>{ console.log("helloAck", p); });

    // --- Join (global + button)
    function doJoin(){
      const name = (nameInput?.value || "").trim();
      try { socket.emit("clientJoinClick", { at: Date.now(), name }); } catch {}
      if (!ready){
        joinBtn.disabled = true; const old=joinBtn.textContent; joinBtn.textContent="Connecting…";
        socket.once("connect", ()=>{ socket.emit("join", name); joinBtn.disabled=false; joinBtn.textContent=old; });
        socket.connect();
        return;
      }
      socket.emit("join", name);
    }
    window.doJoin = doJoin;
    joinBtn?.addEventListener("click", doJoin);
    nameInput?.addEventListener("keydown",(e)=>{ if(e.key==="Enter") doJoin(); });

    // --- Server events
    socket.on("me", (payload)=>{
      if (!payload?.id) return;
      me = payload;
      joinScreen.style.display = "none";
      gameScreen.style.display = "block";
    });
    socket.on("state", (s)=>{
      started = !!s.started;
      countdownEndsAt = s.countdownEndsAt;
      turnEndsAt = s.turnEndsAt;
      current = s.current;
      dir = s.direction;
      color = s.color;
      top = s.top;
      isMyTurn = (current === me.id);

      socket.emit("getMyHand");
      renderPlayers(s.players, current);
      renderPiles();
      renderTimer();

      if (isMyTurn && !me.spectator) drawPile.classList.add("clickable");
      else drawPile.classList.remove("clickable");
    });
    socket.on("handSnapshot", (hand)=>{ myHand = hand || []; renderHand(); });
    socket.on("announce", (text)=>{
      const div = document.createElement("div");
      div.textContent = text;
      chatLog.appendChild(div);
      chatLog.scrollTop = chatLog.scrollHeight;
    });
    socket.on("chooseColor", ()=>{ wildButtons.style.display = "flex"; });

    // --- UI events
    document.getElementById("chat-send")?.addEventListener("click", ()=>{
      const msg = (chatInput?.value || "").trim();
      if (msg) socket.emit("chat", msg);
      if (chatInput) chatInput.value = "";
    });
    chatInput?.addEventListener("keydown",(e)=>{ if(e.key==="Enter") document.getElementById("chat-send").click(); });

    document.getElementById("draw-pile")?.addEventListener("click", ()=>{
      if (isMyTurn && !me.spectator) socket.emit("drawCard");
    });
    document.getElementById("uno-btn")?.addEventListener("click", ()=> socket.emit("callUno"));
    wildButtons?.addEventListener("click",(e)=>{
      const btn = e.target.closest("button"); if (!btn) return;
      wildButtons.style.display = "none";
      socket.emit("colorChosen", { color: btn.getAttribute("data-color") });
    });

    // keep my hand in sync (cheap)
    setInterval(()=> socket.emit("getMyHand"), 2000);
  }
  function waitIO(tries=0){
    if (window.io) return start();
    if (tries>200) { console.error("Socket.IO failed to load"); return; }
    setTimeout(()=>waitIO(tries+1), 25);
  }
  waitIO();
})();
