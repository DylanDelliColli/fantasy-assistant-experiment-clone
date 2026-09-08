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
import { normalizeContext } from "../../src/sleeper/client.mjs";
import { normalizePlayers } from "../../src/data/sources.mjs";
import { context, pool } from "./sleeper.mjs";

export function draftPlayer(id, positions, overrides = {}) {
  const fantasyPositions = Array.isArray(positions) ? positions : [positions];
  return {
    id,
    name: `Fictional ${id}`,
    team: "ARI",
    active: true,
    position: fantasyPositions[0],
    fantasyPositions,
    policyPosition: fantasyPositions[0],
    eligible: true,
    adp: 50,
    adpBand: 4,
    ecr: { sourceId: `FP-${id}`, rank: 50, tier: 5, updatedAt: null },
    projection: { points: 100, updatedAt: null },
    history: null,
    injury: { status: null, bodyPart: null, notes: null, updatedAt: null },
    ...overrides,
  };
}

export function draftFixture(players = null, rankingMode = "ecr") {
  const raw = pool();
  const playersById = players
    ? Object.fromEntries(players.map((player) => [player.id, player]))
    : normalizePlayers(raw.players, raw.projections, raw.history, "2026");
  return {
    version: 1,
    config: normalizeContext(context()),
    playersById,
    rankingMode,
  };
}
