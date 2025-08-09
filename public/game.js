function renderDrawPile() {
  drawPile.innerHTML = "";
  const img = document.createElement("img");
  img.src = "assets/cards/back.png";
  img.alt = "Draw Pile";
  drawPile.appendChild(img);

  if (isMyTurn && !me.spectator) {
    drawPile.classList.add("playable");
    drawPile.onclick = () => socket.emit("drawCard");
  } else {
    drawPile.classList.remove("playable");
    drawPile.onclick = null;
  }
}
