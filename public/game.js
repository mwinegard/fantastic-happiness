// Client with persistent clientId, debounced join, and image-based rendering
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
    const socket = io({ autoConnect:true, transports:["polling","websocket"] });
    window.socket = socket;

    let me = { id:null, name:null, spectator:false, clientId: ensureClientId() };
    let started=false, current=null, dir=1, color=null, top=null;
    let turnEndsAt=null, countdownEndsAt=null, myHand=[], isMyTurn=false, ready=false, joinLock=false;

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

    function legal(card){
      if (!started || !top) return false;
      if (card.type==="wild"||card.type==="wild_draw4") return true;
      if (card.type==="number") return (card.color===color || (typeof top.value!=="undefined" && card.value===top.value));
      return (card.color===color || card.type===top.type);
    }

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
      discardTop.innerHTML = "";
      discardTop.className = "card";
      if (!card) {
        const back = document.createElement("div");
        back.className = "card back";
        discardTop.appendChild(back);
        return;
      }
      const img = document.createElement("img");
      img.src = `assets/cards/${card.img}`;
      img.alt = `${card.color} ${card.type}`;
      discardTop.appendChild(img);
    }

    function renderHand(){
      handDiv.innerHTML="";
      if (me.spectator || !started) return;
      myHand.forEach((c, i)=>{
        const d = document.createElement("div");
        d.className = "card";
        const img = document.createElement("img");
        img.src = `assets/cards/${c.img}`;
        img.alt = `${c.color} ${c.type}`;
        d.appendChild(img);
        const ok = isMyTurn && legal(c);
        if (ok) {
          d.classList.add("playable");
          d.addEventListener("click",()=>socket.emit("playCard",{index:i}));
        } else {
          d.classList.add("unplayable");
        }
        handDiv.appendChild(d);
      });
      unoBtn.disabled = !(myHand.length===2 && started && !me.spectator);
    }

    function msToSec(ms){ return Math.max(0, Math.ceil(ms/1000)); }
    function renderTimer(){
      if (countdownEndsAt && !started) turnIndicator.textContent = `Game starts in ${msToSec(countdownEndsAt - Date.now())}s`;
      else if (turnEndsAt && started)  turnIndicator.textContent = `Your turn ends in ${msToSec(turnEndsAt - Date.now())}s`;
      else turnIndicator.textContent = "—";
    }
    function renderPiles(){
      renderTopCard(top);
      dirLabel.textContent = `Direction: ${dir===1?"→":"←"}`;
      colorLabel.textContent = `Color: ${color?color.toUpperCase():"—"}`;
    }
    setInterval(renderTimer, 250);

    // lifecycle
    socket.on("connect", ()=>{ ready=true; });
    socket.on("disconnect", ()=>{ ready=false; joinLock=false; });

    // join
    function doJoin(){
      if (joinLock) return;
      const name = (nameInput?.value || "").trim();
      const payload = { name, clientId: me.clientId };
      if (!ready){
        joinLock = true;
        const old = joinBtn.textContent;
        joinBtn.disabled = true; joinBtn.textContent = "Connecting…";
        socket.once("connect", ()=>{ socket.emit("join", payload); joinBtn.disabled=false; joinBtn.textContent=old; joinLock=false; });
        socket.connect();
        return;
      }
      joinLock = true;
      socket.emit("join", payload);
      setTimeout(()=>{ joinLock=false; }, 800);
    }
    window.doJoin = doJoin;
    joinBtn?.addEventListener("click", doJoin);
    nameInput?.addEventListener("keydown", (e)=>{ if (e.key === "Enter") doJoin(); });

    // server events
    socket.on("me", (p)=>{
      if (!p?.id) return;
      me = { ...me, ...p };
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

      renderPlayers(s.players, current);
      renderPiles();
      renderTimer();

      if (drawPile) {
        if (isMyTurn && !me.spectator) drawPile.classList.add("clickable");
        else drawPile.classList.remove("clickable");
      }
    });

    socket.on("handSnapshot", (hand)=>{ myHand = hand || []; renderHand(); });

    socket.on("announce", (text)=>{
      const div = document.createElement("div");
      div.textContent = text; chatLog.appendChild(div); chatLog.scrollTop = chatLog.scrollHeight;
    });

    socket.on("chooseColor", ()=>{ wildButtons.style.display = "flex"; });

    // ui
    chatSend?.addEventListener("click", ()=>{
      const msg = (chatInput?.value || "").trim();
      if (msg) socket.emit("chat", msg);
      if (chatInput) chatInput.value = "";
    });
    chatInput?.addEventListener("keydown",(e)=>{ if (e.key==="Enter") chatSend.click(); });

    drawPile?.addEventListener("click", ()=>{ if (isMyTurn && !me.spectator) socket.emit("drawCard"); });
    unoBtn?.addEventListener("click", ()=> socket.emit("callUno"));
    wildButtons?.addEventListener("click",(e)=>{
      const btn = e.target.closest("button"); if (!btn) return;
      wildButtons.style.display = "none";
      socket.emit("colorChosen", { color: btn.getAttribute("data-color") });
    });
  }
  waitIO();
})();
