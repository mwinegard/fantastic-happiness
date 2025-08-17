// Lightweight, read-only leaderboard embed for the Admin page.
// Renders into <div id="adminLeaderboard"></div> if present.
// No styling assumptions: plain table markup.

(function(){
  const mountId = 'adminLeaderboard';
  const root = document.getElementById(mountId);
  if (!root) return;

  root.innerHTML = `
    <div class="admin-lb">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <strong>Leaderboard</strong>
        <button id="adminLbRefresh" type="button">Refresh</button>
        <label style="font-size:12px;color:#666;">Auto <input id="adminLbAuto" type="checkbox" checked> (15s)</label>
        <span id="adminLbUpdated" style="margin-left:auto;font-size:12px;color:#666;"></span>
      </div>
      <table id="adminLbTable" style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="text-align:left;border-bottom:1px solid #ddd;padding:6px 4px;width:50px;">#</th>
            <th style="text-align:left;border-bottom:1px solid #ddd;padding:6px 4px;">Name</th>
            <th style="text-align:right;border-bottom:1px solid #ddd;padding:6px 4px;width:90px;">Wins</th>
            <th style="text-align:right;border-bottom:1px solid #ddd;padding:6px 4px;width:110px;">Points</th>
          </tr>
        </thead>
        <tbody id="adminLbBody">
          <tr><td colspan="4" style="padding:8px;color:#666;">Loading…</td></tr>
        </tbody>
      </table>
    </div>
  `;

  const $body = root.querySelector('#adminLbBody');
  const $updated = root.querySelector('#adminLbUpdated');
  const $refresh = root.querySelector('#adminLbRefresh');
  const $auto = root.querySelector('#adminLbAuto');

  let timer = null;

  async function load() {
    try {
      const res = await fetch('/leaderboard', { cache: 'no-store' });
      const data = await res.json();
      render(Array.isArray(data) ? data : []);
    } catch {
      render([]);
    }
  }

  function render(arr){
    if (!arr.length) {
      $body.innerHTML = `<tr><td colspan="4" style="padding:8px;color:#666;">No games recorded yet.</td></tr>`;
    } else {
      // Keep server order; render rows
      $body.innerHTML = arr.map((row, i) => {
        const name = escapeHtml(row.name || 'Player');
        const wins = Number(row.wins || 0);
        const points = Number(row.points || 0);
        return `
          <tr>
            <td style="padding:6px 4px;border-bottom:1px solid #eee;">${i+1}</td>
            <td style="padding:6px 4px;border-bottom:1px solid #eee;">${name}</td>
            <td style="padding:6px 4px;border-bottom:1px solid #eee;text-align:right;">${wins}</td>
            <td style="padding:6px 4px;border-bottom:1px solid #eee;text-align:right;">${points}</td>
          </tr>
        `;
      }).join('');
    }
    $updated.textContent = 'Updated ' + new Date().toLocaleTimeString();
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  $refresh.addEventListener('click', load);
  $auto.addEventListener('change', () => {
    if ($auto.checked) {
      if (timer) clearInterval(timer);
      timer = setInterval(load, 15000);
    } else if (timer) {
      clearInterval(timer); timer = null;
    }
  });

  // initial
  load();
  timer = setInterval(load, 15000);
})();
