function clearLeaderboard() {
  if (confirm("Are you sure? This will erase all scores.")) {
    fetch("/admin/clear-scores", { method: "POST" }).then(res => {
      if (res.ok) alert("Leaderboard cleared.");
      else alert("Failed to clear leaderboard.");
    });
  }
}
