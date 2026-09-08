export const TEAMS =
  "ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LAC LAR LV MIA MIN NE NO NYG NYJ PHI PIT SEA SF TB TEN WAS".split(
    " ",
  );
export function context() {
  const owners = Array.from({ length: 14 }, (_, i) =>
    i === 0 ? "1264288993504149504" : `90071992547410${i}`,
  );
  const rosterIds = [5, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  return {
    user: { user_id: owners[0], username: "Kijuuu" },
    league: {
      league_id: "1389330057733865472",
      draft_id: "1389330057733865473",
      season: "2026",
      season_type: "regular",
      sport: "nfl",
      total_rosters: 14,
      settings: { draft_rounds: 3, type: 0, reserve_slots: 1 },
      scoring_settings: { rec: 0.5, pass_td: 4 },
      roster_positions: [
        "QB",
        "RB",
        "RB",
        "WR",
        "WR",
        "TE",
        "FLEX",
        "K",
        "DEF",
        "BN",
        "BN",
        "BN",
        "BN",
      ],
    },
    draft: {
      draft_id: "1389330057733865473",
      league_id: "1389330057733865472",
      season: "2026",
      season_type: "regular",
      sport: "nfl",
      type: "snake",
      status: "pre_draft",
      settings: { rounds: 13, teams: 14, reversal_round: 0 },
      draft_order: Object.fromEntries(owners.map((x, i) => [x, i + 1])),
      slot_to_roster_id: Object.fromEntries(
        rosterIds.map((x, i) => [i + 1, x]),
      ),
    },
    rosters: owners.map((owner_id, i) => ({
      owner_id,
      roster_id: rosterIds[i],
      keepers: null,
    })),
    tradedPicks: [],
    picks: [],
  };
}
export function pool() {
  const players = {},
    projections = [],
    history = [];
  let n = 0;
  for (const [position, count] of Object.entries({
    QB: 40,
    RB: 110,
    WR: 130,
    TE: 56,
    K: 32,
    DEF: 32,
  }))
    for (let i = 0; i < count; i++) {
      n++;
      const id = position === "DEF" ? TEAMS[i] : String(10000 + n);
      const team = TEAMS[i % 32];
      players[id] = {
        player_id: id,
        first_name: "Fictional",
        last_name: `Player ${n}`,
        full_name: `Fictional Player ${n}`,
        position,
        fantasy_positions: [position],
        active: true,
        team,
      };
      projections.push({
        player_id: id,
        season: "2026",
        season_type: "regular",
        sport: "nfl",
        stats: { adp_half_ppr: n, pts_half_ppr: n === 1 ? 0 : 100, gp: 18 },
        updated_at: 1788800000000,
      });
      history.push({
        player_id: id,
        season: "2025",
        season_type: "regular",
        sport: "nfl",
        stats: { pts_half_ppr: 90, gp: 1 },
        updated_at: 1758800000000,
      });
    }
  return { players, projections, history };
}
export function pick(n, id = `unknown-${n}`) {
  const round = Math.ceil(n / 14),
    offset = (n - 1) % 14;
  return {
    pick_no: n,
    round,
    draft_slot: round % 2 ? offset + 1 : 14 - offset,
    player_id: id,
    picked_by: "",
  };
}
