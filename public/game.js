// Client with specialty flows, stacking narration, HAPPY emoji, Look/Shopping/Rainbow modals, and Relax interrupt
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
    let turnEndsAt=null, countdownEndsAt=null, myHand=[], isMyTurn=false;
    let penalty=null; // { total, type, target }
    let roundFlags={ happy:false };

    // DOM
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

    // Simple modal infra
    let modalDiv;
    function ensureModal(){
      if (modalDiv) return modalDiv;
      modalDiv = document.createElement("div");
      modalDiv.id = "modal";
      modalDiv.innerHTML = `
        <div class="modal-backdrop"></div>
        <div class="modal-card">
          <div class="modal-title"></div>
          <div class="modal-body"></div>
          <div class="modal-actions"></div>
        </div>`;
      document.body.appendChild(modalDiv);
      modalDiv.addEventListener("click",(e)=>{
        if (e.target.classList.contains("modal-backdrop")) closeModal();
      });
      return modalDiv;
    }
    function closeModal(){ if (modalDiv) modalDiv.classList.remove("open"); }
    function openModal(title, bodyNode, actions=[]) {
      ensureModal();
      modalDiv.querySelector(".modal-title").textContent = title || "";
      const body = modalDiv.querySelector(".modal-body"); body.innerHTML = "";
      body.appendChild(bodyNode);
      const acts = modalDiv.querySelector(".modal-actions"); acts.innerHTML="";
      actions.forEach(a=>{
        const b=document.createElement("button"); b.textContent=a.label; b.onclick=()=>a.onClick && a.onClick();
        acts.appendChild(b);
      });
      modalDiv.classList.add("open");
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
      const img = document.createElement("img");
      img.src = "assets/cards/back.png"; img.alt = "Draw Pile";
      drawPile.appendChild(img);
      if (isMyTurn && !me.spectator) {
        drawPile.classList.add("playable");
        drawPile.onclick = () => socket.emit("drawCard");
      } else {
        drawPile.classList.remove("playable");
        drawPile.onclick = null;
      }
    }
    function legal(card){
      if (!started || !top) return false;
      if (card.type==="number") return (card.color===color || (typeof top.value!=="undefined" && card.value===top.value));
      if (card.type.startsWith("wild")) return true;
      // actions: match color or type
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
        if (isMyTurn) clickable = legal(c);
        // OUT-OF-TURN Relax: allow if penalty exists and card is wild_relax
        if (!isMyTurn && penalty && c.type==="wild_relax") clickable = true;

        if (clickable) {
          d.classList.add("playable");
          if (!isMyTurn && penalty && c.type==="wild_relax") {
            d.addEventListener("click", ()=>{
              // need color for relax
              openColorPicker((chosen)=>{
                closeModal();
                socket.emit("playRelax", { index:i, color: chosen });
              });
            });
          } else {
            d.addEventListener("click",()=>socket.emit("playCard",{index:i}));
          }
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
      renderDrawPile();
      dirLabel.textContent = `Direction: ${dir===1?"→":"←"}`;
      colorLabel.textContent = `Color: ${color?color.toUpperCase():"—"}`;
    }

    function openColorPicker(onPick){
      const body = document.createElement("div");
      const row = document.createElement("div"); row.className="wild-picker";
      ["red","yellow","green","blue"].forEach(c=>{
        const b=document.createElement("button"); b.textContent=c.toUpperCase(); b.dataset.color=c;
        b.onclick=()=>onPick && onPick(c);
        row.appendChild(b);
      });
      body.appendChild(row);
      openModal("Choose a color", body, []);
    }

    // lifecycle
    socket.on("connect", ()=>{ /* ok */ });
    socket.on("me", (p)=>{
      if (!p?.id) return;
      me = { ...me, ...p };
      joinScreen && (joinScreen.style.display = "none");
      gameScreen && (gameScreen.style.display = "block");
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

    // CHAT messages with ids (for Happy)
    socket.on("chat", (m)=>{
      const line = document.createElement("div");
      line.className = "chatline";
      const txt = document.createElement("span");
      txt.textContent = `${m.fromName}: ${m.msg}`;
      line.appendChild(txt);

      if (roundFlags.happy) {
        const btn = document.createElement("button");
        btn.className = "happy-btn";
        btn.textContent = "🙂";
        btn.title = "Flag this message (author draws 1)";
        btn.onclick = ()=> socket.emit("happyFlag", { messageId: m.id });
        line.appendChild(btn);
      }

      chatLog.appendChild(line); chatLog.scrollTop = chatLog.scrollHeight;
    });

    socket.on("happyFlagApplied", ({ messageId })=>{
      // find line and flip emoji
      const lines = chatLog.querySelectorAll(".chatline");
      // naive: flip the last one with a visible happy button
      for (let i=lines.length-1;i>=0;i--){
        const btn = lines[i].querySelector(".happy-btn");
        if (btn && !btn.disabled) { btn.textContent="😼"; btn.disabled = true; btn.title="Already flagged"; break; }
      }
    });

    // Color picker prompts + specialty prompts
    socket.on("chooseColor", ()=>{
      openColorPicker((c)=>{ socket.emit("colorChosen", { color:c }); closeModal(); });
    });

    socket.on("prompt", ({ kind, data, timeoutMs })=>{
      if (kind==="targetPicker"){
        const body = document.createElement("div");
        body.className="target-list";
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
        const picks = [];
        const top4 = data.top4 || [];
        const info = document.createElement("div"); info.className="muted"; info.textContent="Click in the order you want them drawn (1st → 4th)";
        body.appendChild(info);
        top4.forEach((c,i)=>{
          const d=document.createElement("div"); d.className="card mini";
          const img=document.createElement("img"); img.src=`assets/cards/${c.img}`;
          d.appendChild(img);
          d.onclick=()=>{
            if (picks.includes(i)) return;
            picks.push(i);
            d.classList.add("picked");
            if (picks.length===4){ socket.emit("promptChoice", { kind, order: picks }); closeModal(); }
          };
          body.appendChild(d);
        });
        openModal("Look: reorder top 4", body, []);
        setTimeout(()=>{ if (document.body.contains(body)) { socket.emit("promptChoice", { kind, order:[0,1,2,3] }); closeModal(); } }, timeoutMs||15000);
      }
      if (kind==="shoppingPick"){
        const body = document.createElement("div"); body.className="shopping";
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
            else { theirSel=c.idx; [...secTheirs.querySelectorAll(".picked")].forEach(x=>x.classList.remove("picked")); d.classList.add("picked"); }
          };
          secTheirs.appendChild(d);
        });

        const actions = document.createElement("div"); actions.className="muted"; actions.textContent="Confirm when ready.";
        const confirmBtn = document.createElement("button"); confirmBtn.textContent="Confirm";
        confirmBtn.onclick=()=>{
          if (mineSel.size===2 && typeof theirSel==="number") {
            socket.emit("promptChoice", { kind, myTwo: Array.from(mineSel), theirOne: theirSel });
            closeModal();
          }
        };
        const wrap = document.createElement("div"); wrap.append(secMine, secTheirs, actions, confirmBtn);
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
