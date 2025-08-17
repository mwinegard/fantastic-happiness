// Client with specialty flows, stacking narration via announcements, HAPPY emoji moderation,
// Look/Shopping/Rainbow modals, Relax interrupt, and improved timer label.
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
    const handDiv = document.getElementById("player-hand");
    const unoBtn = document.getElementById("uno-btn");
    const chatLog = document.getElementById("chat-log");
    const chatInput = document.getElementById("chat-input");
    const chatSend = document.getElementById("chat-send");
    const turnIndicator = document.getElementById("turn-indicator");
    const dirLabel = document.getElementById("dir-label");
    const colorLabel = document.getElementById("color-label");

    // Inline prompt dock, injected just below the top timer area
    const promptDock = (function(){
      const gs = document.getElementById("game-screen");
      const dock = document.createElement("div");
      dock.id = "prompt-dock";
      dock.style.margin = "8px 16px";
      gs && gs.insertBefore(dock, gs.querySelector(".board"));
      return dock;
    })();

    // Inline prompt “modal-card” (no overlay), reusing existing .modal-card styles
    // so nothing layers over gameplay and prompts live under the timer as requested.
    let modalDiv;
    function ensureModal(){
      if (modalDiv) return modalDiv;
      modalDiv = document.createElement("div");
      modalDiv.className = "modal-card"; // reuse card styling
      return modalDiv;
    }
    function closeModal(){
      if (!promptDock) return;
      promptDock.innerHTML = "";
    }
    function openModal(title, bodyNode, actions=[]) {
      const card = ensureModal();
      card.innerHTML = "";
      const t = document.createElement("div"); t.className="modal-title"; t.textContent = title || "";
      const body = document.createElement("div"); body.className="modal-body";
      if (bodyNode) body.appendChild(bodyNode);
      const acts = document.createElement("div"); acts.className="modal-actions";
      actions.forEach(a=>{ const b=document.createElement("button"); b.textContent=a.label; b.onclick=()=>a.onClick && a.onClick(); acts.appendChild(b); });
      card.appendChild(t); card.appendChild(body); card.appendChild(acts);
      promptDock.innerHTML = ""; promptDock.appendChild(card);
    }

    function openColorPicker(onPick){
      const body = document.createElement("div");
      const row = document.createElement("div"); row.className="wild-picker";
      ["red","yellow","green","blue"].forEach(c=>{
        const b=document.createElement("button"); b.textContent=c.toUpperCase(); b.dataset.color=c;
        b.onclick=()=>{ onPick && onPick(c); closeModal(); };
        row.appendChild(b);
      });
      body.appendChild(row);
      openModal("Choose a color", body, []);
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
      const img = document.createElement("img");
      if (!card) { img.src = "assets/cards/back.png"; img.alt = "Empty Pile"; }
      else { img.src = `assets/cards/${card.img}`; img.alt = `${card.color} ${card.type}`; }
      discardTop.appendChild(img);
    }
    function renderDrawPile(){
      drawPile.innerHTML = "";
      const back = document.createElement("div");
      back.className = "card back";
      const img = document.createElement("img");
      img.src = "assets/cards/back.png";
      img.alt = "Draw Pile";
      back.appendChild(img);
      drawPile.appendChild(back);
    }

    // State (from server)
    let started=false, countdownEndsAt=null, turnEndsAt=null, current=null, dir=1, color=null, top=null, penalty=null, roundFlags={happy:false};
    let playersState=[], isMyTurn=false, myHand=[];

    // simple legality (server is the source of truth; this just gates UI)
    function legal(card){
      if (!started || !top) return false;
      if (card.type==="number") return (card.color===color || (typeof top.value!=="undefined" && card.value===top.value));
      if (card.type.startsWith("wild")) return true;
      return (card.color===color || card.type===top.type);
    }
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
            d.addEventListener("click", ()=>{
              openColorPicker((chosen)=> socket.emit("playRelax", { index:i, color: chosen }));
            });
          } else {
            d.addEventListener("click",()=>socket.emit("playCard",{index:i}));
          }
        } else {
          d.classList.add("unplayable");
        }
        handDiv.appendChild(d);
      });
      unoBtn && (unoBtn.disabled = !(myHand.length===2 && started && !me.spectator));
    }
    function msToSec(ms){ return Math.max(0, Math.ceil(ms/1000)); }
    function renderTimer(){
      if (countdownEndsAt && !started) {
        turnIndicator.textContent = `Game starts in ${msToSec(countdownEndsAt - Date.now())}s`;
        return;
      }
      if (!started || !turnEndsAt) { turnIndicator.textContent = "—"; return; }
      const secs = msToSec(turnEndsAt - Date.now());
      const active = playersState.find(p => p.id === current);
      const who = isMyTurn ? "Your" : (active ? `${active.name}'s` : "Player");
      turnIndicator.textContent = `${who} turn ends in ${secs}s`;
    }
    function renderPiles(){
      renderTopCard(top);
      renderDrawPile();
      dirLabel.textContent = `Direction: ${dir===1?"→":"←"}`;
      colorLabel.textContent = `Color: ${color?color.toUpperCase():"—"}`;
    }

    // socket streams
    socket.on("helloAck", ()=>{ /* no-op */ });

    socket.on("me", (p)=>{
      if (!p?.id) return;
      me.id = p.id; me.name = p.name; me.spectator = !!p.spectator;
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

    socket.on("chat", (m)=>{
      const line = document.createElement("div");
      line.className = "chatline";
      const txt = document.createElement("span");
      txt.textContent = `${m.fromName}: ${m.msg}`;
      line.appendChild(txt);

      if (roundFlags.happy) {
        const sender = (playersState||[]).find(p=>p.id===m.fromSid);
        const eligible = (m.fromSid!=="admin" && sender && !sender.spectator);
        if (eligible) {
          const btn = document.createElement("button");
          btn.className = "happy-btn";
          btn.textContent = "🙂";
          btn.title = "Flag this message (author draws 1)";
          btn.onclick = ()=> socket.emit("happyFlag", { messageId: m.id });
          line.appendChild(btn);
        }
      }

      chatLog.appendChild(line); chatLog.scrollTop = chatLog.scrollHeight;
    });

    socket.on("happyFlagApplied", ()=>{
      const btns = chatLog.querySelectorAll(".happy-btn:not([disabled])");
      if (btns.length){ const btn = btns[btns.length-1]; btn.textContent="😼"; btn.disabled=true; btn.title="Already flagged"; }
    });

    // Color picker generic
    socket.on("chooseColor", ()=>{
      openColorPicker((c)=> socket.emit("colorChosen", { color:c }));
    });

    // PROMPTS (now shown inline in the prompt dock below the timer)
    socket.on("prompt", ({ kind, data, timeoutMs })=>{
      if (kind==="targetPicker"){
        const body = document.createElement("div"); body.className="target-list";
        (data.targets||[]).forEach(t=>{
          const b = document.createElement("button");
          b.textContent = t.name;
          b.onclick = ()=>{ socket.emit("promptChoice", { kind, targetSid: t.sid }); closeModal(); };
          body.appendChild(b);
        });
        openModal("Choose a player", body, []);
        setTimeout(()=>closeModal(), timeoutMs||15000);
      }
      if (kind==="lookOrder"){
        const body = document.createElement("div"); body.className="look4";
        // simple reorder UX: choose the order by clicking 1..4
        const order=[], cards=(data.top4||[]);
        cards.forEach((c,i)=>{
          const d = document.createElement("div"); d.className="card mini";
          const img = document.createElement("img"); img.src = `assets/cards/${c.img}`; d.appendChild(img);
          d.onclick=()=>{
            if (order.includes(i)) return;
            order.push(i); d.classList.add("picked");
          };
          body.appendChild(d);
        });
        const confirmBtn = document.createElement("button"); confirmBtn.textContent="Confirm order";
        confirmBtn.onclick=()=>{ if (order.length===4){ socket.emit("promptChoice", { kind, order }); closeModal(); } };
        openModal("Look: reorder the next 4 cards (top to bottom)", body, [{label:"Confirm", onClick:()=>confirmBtn.onclick()}]);
        setTimeout(()=>closeModal(), timeoutMs||15000);
      }
      if (kind==="shoppingTrade"){
        const body = document.createElement("div"); body.className="shopping";
        const wrap = document.createElement("div"); wrap.style.display="flex"; wrap.style.gap="10px"; wrap.style.flexWrap="wrap";

        const mineSel = new Set(); let theirSel = null;

        const secMine = document.createElement("div"); secMine.className="handsec";
        const titleMine = document.createElement("div"); titleMine.textContent="Pick TWO of yours";
        secMine.appendChild(titleMine);
        (data.mine||[]).forEach(c=>{
          const d=document.createElement("div"); d.className="card mini";
          const img=document.createElement("img"); img.src=`assets/cards/${c.img}`; d.appendChild(img);
          d.onclick=()=>{
            if (mineSel.has(c.idx)) { mineSel.delete(c.idx); d.classList.remove("picked"); }
            else if (mineSel.size<2){ mineSel.add(c.idx); d.classList.add("picked"); }
          };
          secMine.appendChild(d);
        });

        const secTheirs = document.createElement("div"); secTheirs.className="handsec";
        const titleTheirs = document.createElement("div"); titleTheirs.textContent="Pick ONE of theirs";
        secTheirs.appendChild(titleTheirs);
        (data.theirs||[]).forEach(c=>{
          const d=document.createElement("div"); d.className="card mini";
          const img=document.createElement("img"); img.src=`assets/cards/${c.img}`; d.appendChild(img);
          d.onclick=()=>{
            if (theirSel===c.idx){ theirSel=null; d.classList.remove("picked"); }
            else { theirSel=c.idx; [...secTheirs.querySelectorAll(".card")].forEach(x=>x.classList.remove("picked")); d.classList.add("picked"); }
          };
          secTheirs.appendChild(d);
        });

        const confirmBtn = document.createElement("button"); confirmBtn.textContent="Confirm";
        confirmBtn.onclick=()=>{
          if (mineSel.size===2 && typeof theirSel==="number") {
            socket.emit("promptChoice", { kind, myTwo: Array.from(mineSel), theirOne: theirSel });
            closeModal();
          }
        };
        wrap.append(secMine, secTheirs, confirmBtn);
        openModal("Shopping: trade 2 for 1", wrap, []);
        setTimeout(()=>closeModal(), timeoutMs||20000);
      }
      if (kind==="rainbowSelects"){
        const body = document.createElement("div"); body.className="rainbow";
        const info = document.createElement("div"); info.className="muted"; info.textContent="Pick one RED, YELLOW, GREEN, and BLUE card from your hand.";
        body.appendChild(info);
        const picks = new Set();
        (data.hand||[]).forEach(c=>{
          if (!["red","yellow","green","blue"].includes(c.color)) return;
          const d=document.createElement("div"); d.className="card mini";
          const img=document.createElement("img"); img.src=`assets/cards/${c.img}`; d.appendChild(img);
          d.onclick=()=>{
            if (picks.has(c.idx)){ picks.delete(c.idx); d.classList.remove("picked"); }
            else if (picks.size<4){ picks.add(c.idx); d.classList.add("picked"); }
          };
          body.appendChild(d);
        });
        const confirm = document.createElement("button"); confirm.textContent="Confirm 4";
        confirm.onclick=()=>{ if (picks.size===4){ socket.emit("promptChoice", { kind, picks: Array.from(picks) }); closeModal(); } };
        openModal("Rainbow: choose one of each color", body, [ {label:"Confirm", onClick:()=>confirm.onclick()} ]);
        setTimeout(()=>closeModal(), timeoutMs||20000);
      }
    });

    // UI
    function doJoin(){
      const name = (nameInput?.value || "").trim();
      socket.emit("join", { name, clientId: me.clientId });
    }
    joinBtn?.addEventListener("click", doJoin);
    nameInput?.addEventListener("keydown", (e)=>{ if (e.key === "Enter") doJoin(); });

    chatSend?.addEventListener("click", ()=>{
      const msg = (chatInput?.value || "").trim();
      if (msg) socket.emit("chat", msg);
      if (chatInput) chatInput.value = "";
    });
    chatInput?.addEventListener("keydown",(e)=>{ if (e.key==="Enter") chatSend.click(); });

    unoBtn?.addEventListener("click", ()=> socket.emit("callUno"));
  }
  waitIO();
})();
