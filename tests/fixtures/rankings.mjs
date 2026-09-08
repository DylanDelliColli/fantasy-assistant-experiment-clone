export function rankings(players) {
  return {
    year: "2026",
    week: "0",
    scoring: "HALF",
    players: Object.values(players).map((p, i) => ({
      player_id: String(20000 + i),
      player_name: p.full_name,
      player_team_id: p.team,
      player_position_id: p.position,
      rank_ecr: i + 1,
      tier: Math.floor(i / 12) + 1,
    })),
  };
}
export function html(data) {
  return `<script>globalThis.SOURCE_SCRIPT_EXECUTED=true;</script><script>var ecrData = ${JSON.stringify(data)}; globalThis.SOURCE_SCRIPT_EXECUTED=true;</script>`;
}
