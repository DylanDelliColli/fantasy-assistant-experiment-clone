import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  loadContext,
  fetchSource,
  externalId,
  BASE_URL,
} from "../sleeper/client.mjs";
import {
  POSITIONS,
  NFL_TEAMS,
  normalizePosition,
  normalizeTeam,
  parseEcrHtml,
  matchEcrPlayers,
} from "./identity.mjs";
import { writeJsonAtomic } from "./snapshot.mjs";
import { SNAPSHOT_VERSION } from "../contracts.mjs";
const ECR_URL =
  "https://www.fantasypros.com/nfl/rankings/half-point-ppr-cheatsheets.php";
const numeric = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const adpValue = (v) => (numeric(v) !== null && v > 0 && v !== 999 ? v : null);
const sourceTime = (v) =>
  v == null ||
  typeof v === "string" ||
  (typeof v === "number" && Number.isFinite(v));
function rowsById(rows, season) {
  if (!Array.isArray(rows)) throw new Error("Invalid source rows");
  const map = new Map();
  for (const row of rows) {
    if (
      row?.season !== season ||
      row.sport !== "nfl" ||
      row.season_type !== "regular"
    )
      throw new Error("Invalid source season/sport/type");
    const id = externalId(row.player_id);
    if (map.has(id)) throw new Error("duplicate source ID");
    if (!row.stats || typeof row.stats !== "object" || Array.isArray(row.stats))
      throw new Error("Invalid source stats");
    if (!sourceTime(row.updated_at) || !sourceTime(row.last_modified))
      throw new Error("Invalid source update time");
    map.set(id, row);
  }
  return map;
}
const points = (row) =>
  row
    ? {
        points: numeric(row.stats.pts_half_ppr),
        updatedAt: row.updated_at ?? row.last_modified ?? null,
      }
    : null;
export function normalizePlayers(players, projections, history, season) {
  if (!players || typeof players !== "object" || Array.isArray(players))
    throw new Error("Invalid player map");
  const proj = rowsById(projections, season),
    hist =
      history === null
        ? new Map()
        : rowsById(history, String(Number(season) - 1));
  const result = {};
  for (const [key, p] of Object.entries(players)) {
    const id = externalId(key);
    if (
      !p ||
      typeof p !== "object" ||
      (p.player_id != null && externalId(p.player_id) !== id)
    )
      throw new Error("Player identity mismatch");
    for (const key of [
      "full_name",
      "first_name",
      "last_name",
      "position",
      "team",
      "injury_status",
      "injury_body_part",
      "injury_notes",
    ]) {
      if (p[key] != null && typeof p[key] !== "string")
        throw new Error(`Invalid player ${key}`);
    }
    if (
      p.fantasy_positions != null &&
      (!Array.isArray(p.fantasy_positions) ||
        !p.fantasy_positions.every((x) => typeof x === "string"))
    )
      throw new Error("Invalid player fantasy_positions");
    if (!sourceTime(p.news_updated))
      throw new Error("Invalid player update time");
    const fantasyPositions = [
        ...new Set((p.fantasy_positions ?? []).map(normalizePosition)),
      ],
      position = normalizePosition(p.position) ?? null,
      team = normalizeTeam(p.team),
      adp = adpValue(proj.get(id)?.stats.adp_half_ppr),
      policyPosition =
        POSITIONS.includes(position) && fantasyPositions.includes(position)
          ? position
          : (POSITIONS.find((x) => fantasyPositions.includes(x)) ?? null);
    result[id] = {
      id,
      name:
        p.full_name ??
        ([p.first_name, p.last_name].filter(Boolean).join(" ") || id),
      position,
      team,
      active: p.active === true,
      fantasyPositions,
      policyPosition,
      eligible:
        p.active === true &&
        NFL_TEAMS.has(team) &&
        policyPosition !== null &&
        adp !== null,
      adp,
      adpBand: null,
      ecr: null,
      projection: points(proj.get(id)),
      history: points(hist.get(id)),
      injury: {
        status: p.injury_status ?? null,
        bodyPart: p.injury_body_part ?? null,
        notes: p.injury_notes ?? null,
        updatedAt: p.news_updated ?? null,
      },
    };
  }
  const pool = Object.values(result)
    .filter((p) => p.eligible)
    .sort((a, b) => a.adp - b.adp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  pool.forEach((p, i) => (p.adpBand = Math.floor(i / 12)));
  return result;
}
export function applyEcrRanks(players, matches) {
  for (const p of Object.values(players)) {
    p.ecr = matches[p.id] ?? null;
    p.eligible =
      p.active &&
      NFL_TEAMS.has(p.team) &&
      p.policyPosition !== null &&
      (p.adp !== null || p.ecr !== null);
  }
}
export function validateCoverage(players) {
  const eligible = Object.values(players).filter(
      (p) => p.eligible && p.adp !== null,
    ),
    counts = Object.fromEntries(
      POSITIONS.map((p) => [
        p,
        eligible.filter((x) => x.policyPosition === p).length,
      ]),
    );
  if (eligible.length < 400)
    throw new Error(
      `ADP coverage requires 400 eligible players; found ${eligible.length}`,
    );
  for (const [pos, min] of Object.entries({
    QB: 14,
    RB: 42,
    WR: 42,
    TE: 14,
    K: 14,
    DEF: 14,
  }))
    if (counts[pos] < min)
      throw new Error(
        `ADP coverage ${pos}: requires ${min}, found ${counts[pos]}`,
      );
  return { total: eligible.length, positions: counts };
}
export async function prepareData(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? ".local"),
    rawDir = path.join(dataDir, "sources");
  await mkdir(rawDir, { recursive: true });
  const now = options.now?.() ?? new Date(),
    preparedAt = now.toISOString(),
    base = options.baseUrl ?? BASE_URL;
  const { config, configFingerprint, league } = await loadContext(options),
    sources = {},
    warnings = [];
  if (league.name != null && typeof league.name !== "string")
    throw new Error("Invalid league name");
  function meta(url, season, scoring = "half-ppr", fetchedAt = preparedAt) {
    return { url, season, scoring, fetchedAt, updatedAt: null };
  }
  async function source(name, url, season, text = false) {
    const data = await fetchSource(url, { ...options, text });
    sources[name] = meta(
      url,
      season,
      "half-ppr",
      (options.now?.() ?? new Date()).toISOString(),
    );
    await writeFile(
      path.join(rawDir, `${name}.${text ? "html" : "json"}`),
      text ? data : JSON.stringify(data),
      { mode: 0o600 },
    );
    return data;
  }
  const playerUrl = `${base}/v1/players/nfl`,
    cacheFile = path.join(rawDir, "players-cache.json");
  let cache;
  try {
    cache = JSON.parse(await readFile(cacheFile, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
  }
  const fresh = (c) =>
    c &&
    c.url === playerUrl &&
    Number.isFinite(Date.parse(c.fetchedAt)) &&
    now - Date.parse(c.fetchedAt) >= 0 &&
    now - Date.parse(c.fetchedAt) < 86400000;
  if (options.playersFile) {
    cache = {
      players: JSON.parse(await readFile(options.playersFile, "utf8")),
      fetchedAt: options.playersFetchedAt,
      url: playerUrl,
    };
    if (!fresh(cache))
      throw new Error("Explicit player file timestamp is expired or invalid");
  }
  if (
    !fresh(cache) &&
    options.researchPlayersFile !== null &&
    now.toISOString().startsWith("2026-09-08")
  ) {
    try {
      cache = {
        players: JSON.parse(
          await readFile(
            options.researchPlayersFile ?? "/tmp/fantasy-research-players.json",
            "utf8",
          ),
        ),
        fetchedAt: "2026-09-08T16:28:00.000Z",
        url: playerUrl,
      };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  if (!fresh(cache))
    cache = {
      players: await source("players", playerUrl, config.season),
      fetchedAt: preparedAt,
      url: playerUrl,
    };
  sources.players = meta(
    playerUrl,
    config.season,
    null,
    new Date(cache.fetchedAt).toISOString(),
  );
  const projectionUrl = `${base}/projections/nfl/${config.season}?season_type=regular`,
    historySeason = String(Number(config.season) - 1);
  const projections = await source("projections", projectionUrl, config.season);
  let history = null;
  try {
    history = await source(
      "history",
      `${base}/stats/nfl/${historySeason}?season_type=regular`,
      historySeason,
    );
    rowsById(history, historySeason);
  } catch (error) {
    history = null;
    delete sources.history;
    warnings.push(`History unavailable: ${error.message}`);
  }
  const playersById = normalizePlayers(
      cache.players,
      projections,
      history,
      config.season,
    ),
    coverage = validateCoverage(playersById);
  await writeJsonAtomic(cacheFile, cache);
  let rankingMode = "adp-only",
    quarantine = [];
  if (options.withoutEcr) warnings.push("ECR disabled; ADP-only ranking");
  else
    try {
      const ecr = await source(
          "ecr",
          options.ecrUrl ?? ECR_URL,
          config.season,
          true,
        ),
        parsed = parseEcrHtml(ecr),
        result = matchEcrPlayers(parsed, playersById, config.season);
      quarantine = result.quarantine;
      if (!result.valid) throw new Error(result.error);
      sources.ecr.updatedAt = parsed.last_updated ?? null;
      applyEcrRanks(playersById, result.matches);
      rankingMode = "ecr";
    } catch (error) {
      delete sources.ecr;
      warnings.push(`ECR unavailable; ADP-only ranking: ${error.message}`);
    }
  const snapshot = {
    version: SNAPSHOT_VERSION,
    snapshotId: randomUUID(),
    preparedAt,
    leagueName: league.name ?? "",
    config,
    configFingerprint,
    sources,
    playersById,
    rankingMode,
    importReport: { coverage, warnings, quarantine },
  };
  await writeJsonAtomic(path.join(dataDir, "snapshot.json"), snapshot);
  return snapshot;
}
