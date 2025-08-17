// public/admin-leaderboard.js
(function(){
  const root = document.getElementById("admin-leaderboard");
  if (!root) return;

  function esc(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]))}

  async function refresh(){
    try{
      const res = await fetch("/leaderboard", { cache: "no-store" });
      const rows = await res.json();
      root.innerHTML = render(rows || []);
    }catch{
      root.textContent = "Failed to load leaderboard.";
    }
  }

  function render(rows){
    const tr = r => `<tr><td>${esc(r.name)}</td><td>${Number(r.wins||0)}</td><td>${Number(r.points||0)}</td></tr>`;
    return `<table><thead><tr><th>Name</th><th>Wins</th><th>Points</th></tr></thead><tbody>${(rows||[]).map(tr).join("")}</tbody></table>`;
  }

  refresh();
  setInterval(refresh, 5000);
})();
