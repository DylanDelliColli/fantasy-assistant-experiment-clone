import { externalId } from "../sleeper/client.mjs";
export const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
export const NFL_TEAMS = new Set(
  "ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LAC LAR LV MIA MIN NE NO NYG NYJ PHI PIT SEA SF TB TEN WAS".split(
    " ",
  ),
);
export const normalizePosition = (p) =>
  ({ PK: "K", DST: "DEF", "D/ST": "DEF" })[p] ?? p;
export const normalizeTeam = (t) =>
  ({ JAC: "JAX", WSH: "WAS", LA: "LAR", SD: "LAC", OAK: "LV", STL: "LAR" })[
    t
  ] ??
  t ??
  null;
export function normalizeName(name) {
  return String(name)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[’'`.]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/, "")
    .replace(/\s+/g, " ")
    .trim();
}
// Scan only a balanced JSON object: no eval, vm, Function or HTML execution.
export function parseEcrHtml(html) {
  const match = /\bvar\s+ecrData\s*=\s*/.exec(html);
  if (!match) throw new Error("Missing ecrData JSON");
  const start = match.index + match[0].length;
  if (html[start] !== "{") throw new Error("Invalid ecrData JSON");
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0)
      return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error("Incomplete ecrData JSON");
}
const reviewed = { 18226: "5848", 24901: "8122" };
export function matchEcrPlayers(data, playersById, season) {
  const quarantine = [];
  const matches = {};
  const ids = new Set(),
    ranks = new Set(),
    joins = new Set();
  try {
    if (
      String(data?.year) !== season ||
      String(data.week) !== "0" ||
      data.scoring !== "HALF" ||
      !Array.isArray(data.players) ||
      !data.players.length
    ) {
      throw new Error("Invalid ECR year/week/scoring/players");
    }
    // Index every identity, including inactive players: they still explain picks.
    // Multiple exact keys remain ambiguous; no fuzzy tie-break is permitted.
    const index = new Map();
    const key = (position, team, name) =>
      JSON.stringify([position, team, position === "DEF" ? "" : name]);
    for (const [id, p] of Object.entries(playersById)) {
      if (p.id !== id)
        throw new Error("Duplicate or mismatched source identity");
      for (const position of p.fantasyPositions) {
        const k = key(position, normalizeTeam(p.team), normalizeName(p.name));
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(p);
      }
    }
    let topFailure = false;
    for (const row of data.players) {
      const sourceId = externalId(row.player_id, "ECR ID");
      const rank = Number(row.rank_ecr);
      if (
        !Number.isInteger(rank) ||
        rank <= 0 ||
        ids.has(sourceId) ||
        ranks.has(rank)
      ) {
        throw new Error("Duplicate/invalid ECR IDs or ranks");
      }
      ids.add(sourceId);
      ranks.add(rank);
      const position = normalizePosition(row.player_position_id);
      const team = normalizeTeam(row.player_team_id);
      const aliasId = reviewed[sourceId.replace(/^FP/, "")];
      const alias = aliasId && playersById[aliasId];
      const candidates = aliasId
        ? alias &&
          alias.fantasyPositions.includes(position) &&
          normalizeTeam(alias.team) === team
          ? [alias]
          : []
        : (index.get(key(position, team, normalizeName(row.player_name))) ??
          []);
      if (candidates.length !== 1) {
        quarantine.push({
          sourceId,
          rank,
          reason: candidates.length ? "ambiguous" : "unresolved",
        });
        if (rank <= 400) topFailure = true;
        continue;
      }
      const id = candidates[0].id;
      if (joins.has(id)) throw new Error("Duplicate canonical ECR join");
      joins.add(id);
      const tier = row.tier == null ? null : Number(row.tier);
      if (tier !== null && (!Number.isInteger(tier) || tier <= 0))
        throw new Error("Invalid ECR tier");
      matches[id] = {
        sourceId,
        rank,
        tier,
        updatedAt: data.last_updated ?? null,
      };
    }
    if (topFailure)
      throw new Error("Unresolved or ambiguous top400 ECR identity");
    if (
      Array.from({ length: 400 }, (_, i) => i + 1).some(
        (rank) => !ranks.has(rank),
      )
    ) {
      throw new Error("Incomplete ECR top400 coverage");
    }
    return { valid: true, matches, quarantine, error: null };
  } catch (error) {
    return { valid: false, matches: {}, quarantine, error: error.message };
  }
}
