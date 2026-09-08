import { createHash } from "node:crypto";
export const DEFAULT_LEAGUE = "1389330057733865472";
export const DEFAULT_USER = "Kijuuu";
export const BASE_URL = "https://api.sleeper.app";
const SLOTS = [
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
];
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
export function externalId(value, label = "ID") {
  requireValue(
    (typeof value === "string" && value.trim().length > 0) ||
      (Number.isSafeInteger(value) && value >= 0),
    `Invalid ${label}`,
  );
  const id = String(value);
  requireValue(
    !["__proto__", "constructor", "prototype"].includes(id),
    `Invalid ${label}`,
  );
  return id;
}
const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export function configFingerprint(config) {
  const fields = [
    "leagueId",
    "draftId",
    "userId",
    "rosterId",
    "slot",
    "season",
    "seasonType",
    "sport",
    "type",
    "leagueType",
    "teams",
    "rounds",
    "reversal",
    "rosterPositions",
    "reserveSlots",
    "scoring",
    "draftOrder",
    "slotToRosterId",
    "keeperAssignments",
    "tradedPicks",
  ];
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical(Object.fromEntries(fields.map((key) => [key, config[key]]))),
      ),
    )
    .digest("hex");
}

/** Validate persisted normalized configuration at its owning context reader. */
export function validateConfig(config) {
  requireValue(config && typeof config === "object", "Invalid configuration");
  for (const key of ["leagueId", "draftId", "userId", "rosterId"]) {
    requireValue(typeof config[key] === "string", `Invalid config ${key}`);
    externalId(config[key], key);
  }
  requireValue(
    config.sport === "nfl" &&
      config.type === "snake" &&
      config.leagueType === 0 &&
      config.seasonType === "regular" &&
      typeof config.season === "string" &&
      /^20\d{2}$/.test(config.season),
    "Unsupported configuration season/type",
  );
  requireValue(
    config.teams === 14 && config.rounds === 13 && config.reversal === 0,
    "Unsupported configuration teams/rounds/reversal",
  );
  requireValue(
    JSON.stringify(config.rosterPositions) === JSON.stringify(SLOTS) &&
      config.reserveSlots === 1,
    "Unsupported configuration roster shape",
  );
  requireValue(
    config.scoring &&
      !Array.isArray(config.scoring) &&
      config.scoring.rec === 0.5 &&
      config.scoring.pass_td === 4 &&
      Object.values(config.scoring).every(Number.isFinite),
    "Invalid configuration scoring",
  );
  requireValue(
    config.draftOrder && config.slotToRosterId && config.keeperAssignments,
    "Missing configuration mappings",
  );
  const order = Object.entries(config.draftOrder);
  requireValue(
    order.length === 14 &&
      new Set(order.map(([, slot]) => slot)).size === 14 &&
      order.every(([id, slot]) => externalId(id) && integer(slot, 1, 14)),
    "Invalid configuration draft order",
  );
  const mapped = Object.values(config.slotToRosterId);
  requireValue(
    mapped.length === 14 &&
      new Set(mapped).size === 14 &&
      mapped.every((id) => typeof id === "string" && externalId(id)),
    "Invalid configuration roster mapping",
  );
  for (let slot = 1; slot <= 14; slot++)
    requireValue(
      typeof config.slotToRosterId[slot] === "string",
      "Missing configuration slot",
    );
  requireValue(
    integer(config.slot, 1, 14) &&
      config.draftOrder[config.userId] === config.slot &&
      config.slotToRosterId[config.slot] === config.rosterId,
    "Configuration owner/slot mismatch",
  );
  requireValue(
    Object.keys(config.keeperAssignments).length === 14 &&
      mapped.every(
        (id) =>
          Array.isArray(config.keeperAssignments[id]) &&
          config.keeperAssignments[id].length === 0,
      ),
    "Assigned or invalid configuration keepers",
  );
  requireValue(
    Array.isArray(config.tradedPicks) && config.tradedPicks.length === 0,
    "Assigned or invalid configuration traded picks",
  );
  return config;
}

function validateDraftDetails(draft) {
  requireValue(
    draft.keepers == null ||
      (typeof draft.keepers === "object" &&
        Object.keys(draft.keepers).length === 0),
    "Assigned draft keepers unsupported",
  );
  const slots = { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, k: 1, def: 1, bn: 4 };
  for (const [position, count] of Object.entries(slots)) {
    const value = draft.settings?.[`slots_${position}`];
    requireValue(
      value === undefined || value === count,
      "Unsupported draft roster slots",
    );
  }
  requireValue(
    ["pre_draft", "drafting", "paused", "complete"].includes(draft.status),
    "Invalid draft status",
  );
}
export function normalizeContext({
  league,
  user,
  draft,
  rosters,
  tradedPicks,
}) {
  requireValue(
    league &&
      user &&
      draft &&
      Array.isArray(rosters) &&
      Array.isArray(tradedPicks),
    "Invalid context schema",
  );
  const leagueId = externalId(league.league_id),
    draftId = externalId(league.draft_id),
    userId = externalId(user.user_id);
  requireValue(
    externalId(draft.draft_id) === draftId &&
      externalId(draft.league_id) === leagueId,
    "Draft identity mismatch",
  );
  requireValue(
    league.sport === "nfl" && draft.sport === "nfl",
    "Unsupported sport",
  );
  requireValue(
    typeof league.season === "string" &&
      /^20\d{2}$/.test(league.season) &&
      draft.season === league.season,
    "Invalid season",
  );
  requireValue(
    league.season_type === "regular" && draft.season_type === "regular",
    "Unsupported season type",
  );
  requireValue(
    draft.type === "snake" && league.settings?.type === 0,
    "Unsupported league/draft type",
  );
  requireValue(
    (league.settings.best_ball ?? 0) === 0 &&
      (league.settings.taxi_slots ?? 0) === 0,
    "Unsupported best-ball/taxi settings",
  );
  validateDraftDetails(draft);
  requireValue(
    league.total_rosters === 14 &&
      draft.settings?.teams === 14 &&
      rosters.length === 14,
    "Unsupported teams",
  );
  requireValue(
    draft.settings.rounds === 13 && draft.settings.reversal_round === 0,
    "Unsupported rounds/reversal",
  );
  requireValue(
    JSON.stringify(league.roster_positions) === JSON.stringify(SLOTS) &&
      league.settings.reserve_slots === 1,
    "Unsupported roster shape",
  );
  const scoring = league.scoring_settings;
  requireValue(
    scoring &&
      scoring.rec === 0.5 &&
      scoring.pass_td === 4 &&
      Object.values(scoring).every(Number.isFinite),
    "Unsupported scoring",
  );
  requireValue(tradedPicks.length === 0, "Traded picks unsupported");
  const keeperAssignments = {};
  const rosterOwners = new Map();
  for (const r of rosters) {
    const id = externalId(r.roster_id, "roster ID");
    requireValue(!rosterOwners.has(id), "Duplicate roster ID");
    rosterOwners.set(id, externalId(r.owner_id, "owner ID"));
    requireValue(
      r.keepers == null || (Array.isArray(r.keepers) && r.keepers.length === 0),
      "Assigned keepers unsupported",
    );
    keeperAssignments[id] = [];
  }
  requireValue(
    !draft.keepers ||
      (typeof draft.keepers === "object" &&
        Object.keys(draft.keepers).length === 0),
    "Assigned draft keepers unsupported",
  );
  const owned = [...rosterOwners].filter(([, owner]) => owner === userId);
  requireValue(owned.length === 1, "Unresolved owner");
  const rosterId = owned[0][0];
  requireValue(
    draft.draft_order && draft.slot_to_roster_id,
    "Missing draft mappings",
  );
  const draftOrder = {},
    slotToRosterId = {};
  const slots = new Set(),
    mapped = new Set();
  for (const [owner, slot] of Object.entries(draft.draft_order)) {
    requireValue(
      integer(slot, 1, 14) && !slots.has(slot),
      "Invalid draft order",
    );
    slots.add(slot);
    draftOrder[externalId(owner)] = slot;
  }
  requireValue(
    slots.size === 14 && Object.keys(draft.slot_to_roster_id).length === 14,
    "Incomplete draft mappings",
  );
  for (let slot = 1; slot <= 14; slot++) {
    const id = externalId(draft.slot_to_roster_id[slot], "slot roster");
    requireValue(
      rosterOwners.has(id) && !mapped.has(id),
      "Invalid slot mapping",
    );
    requireValue(
      draftOrder[rosterOwners.get(id)] === slot,
      "Owner/slot mapping mismatch",
    );
    mapped.add(id);
    slotToRosterId[slot] = id;
  }
  const slot = draftOrder[userId];
  requireValue(
    integer(slot, 1, 14) && slotToRosterId[slot] === rosterId,
    "Unresolved own slot",
  );
  return validateConfig({
    leagueId,
    draftId,
    userId,
    rosterId,
    slot,
    season: league.season,
    seasonType: "regular",
    sport: "nfl",
    type: "snake",
    leagueType: 0,
    teams: 14,
    rounds: 13,
    reversal: 0,
    rosterPositions: [...SLOTS],
    reserveSlots: 1,
    scoring: { ...scoring },
    draftOrder,
    slotToRosterId,
    keeperAssignments,
    tradedPicks: [],
  });
}
export function normalizePicks(rows, config) {
  requireValue(Array.isArray(rows), "Invalid picks schema");
  const numbers = new Set(),
    players = new Set();
  const picks = rows
    .map((row) => {
      requireValue(
        row && integer(row.pick_no, 1, config.teams * config.rounds),
        "Invalid pick number",
      );
      const pickNo = row.pick_no,
        round = Math.ceil(pickNo / config.teams),
        offset = (pickNo - 1) % config.teams,
        slot = round % 2 ? offset + 1 : config.teams - offset;
      requireValue(
        row.round === round && row.draft_slot === slot,
        "Illegal pick round/slot",
      );
      const playerId = externalId(row.player_id, "player ID");
      requireValue(
        !numbers.has(pickNo) && !players.has(playerId),
        "Duplicate pick/player",
      );
      numbers.add(pickNo);
      players.add(playerId);
      const rosterId =
        row.roster_id == null
          ? config.slotToRosterId[slot]
          : externalId(row.roster_id, "pick roster");
      requireValue(
        Object.values(config.slotToRosterId).includes(rosterId) &&
          rosterId === config.slotToRosterId[slot],
        "Illegal pick roster",
      );
      return {
        pickNo,
        round,
        slot,
        rosterId,
        playerId,
        pickedBy:
          row.picked_by == null || row.picked_by === ""
            ? null
            : externalId(row.picked_by),
      };
    })
    .sort((a, b) => a.pickNo - b.pickNo);
  requireValue(
    picks.every((p, i) => p.pickNo === i + 1),
    "Gap in picks",
  );
  return picks;
}
export async function fetchSource(
  url,
  { timeoutMs = 4000, text = false } = {},
) {
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const error = new Error(`GET ${url}: HTTP ${response.status}`);
    error.status = response.status;
    const retry = response.headers.get("retry-after");
    error.retryAfter = retry;
    throw error;
  }
  return text ? response.text() : response.json();
}
export async function loadContext(options = {}) {
  const base = options.baseUrl ?? BASE_URL,
    leagueId = options.league ?? DEFAULT_LEAGUE,
    userName = options.user ?? DEFAULT_USER;
  const [league, user] = await Promise.all([
    fetchSource(`${base}/v1/league/${encodeURIComponent(leagueId)}`, options),
    fetchSource(`${base}/v1/user/${encodeURIComponent(userName)}`, options),
  ]);
  requireValue(
    externalId(league.league_id) === String(leagueId),
    "League identity mismatch",
  );
  const draftId = externalId(league.draft_id);
  const [draft, rosters, tradedPicks] = await Promise.all([
    fetchSource(`${base}/v1/draft/${draftId}`, options),
    fetchSource(
      `${base}/v1/league/${encodeURIComponent(leagueId)}/rosters`,
      options,
    ),
    fetchSource(`${base}/v1/draft/${draftId}/traded_picks`, options),
  ]);
  const config = normalizeContext({
    league,
    user,
    draft,
    rosters,
    tradedPicks,
  });
  return {
    config,
    configFingerprint: configFingerprint(config),
    league,
    draft,
    user,
  };
}
export async function fetchDraftSnapshot(config, options = {}) {
  validateConfig(config);
  const base = options.baseUrl ?? BASE_URL;
  const [draft, rows] = await Promise.all([
    fetchSource(`${base}/v1/draft/${config.draftId}`, options),
    fetchSource(`${base}/v1/draft/${config.draftId}/picks`, options),
  ]);
  validateDraftDetails(draft);
  requireValue(
    draft.draft_id === config.draftId &&
      draft.league_id === config.leagueId &&
      draft.season === config.season &&
      draft.sport === config.sport &&
      draft.type === config.type &&
      draft.settings?.rounds === config.rounds &&
      draft.settings.teams === config.teams &&
      draft.settings.reversal_round === config.reversal,
    "Draft configuration changed; prepare again",
  );
  requireValue(
    JSON.stringify(canonical(draft.draft_order)) ===
      JSON.stringify(canonical(config.draftOrder)) &&
      JSON.stringify(
        canonical(
          Object.fromEntries(
            Object.entries(draft.slot_to_roster_id ?? {}).map(([k, v]) => [
              k,
              String(v),
            ]),
          ),
        ),
      ) === JSON.stringify(canonical(config.slotToRosterId)),
    "Draft mappings changed; prepare again",
  );
  return {
    draftId: config.draftId,
    configFingerprint: configFingerprint(config),
    status: draft.status,
    picks: normalizePicks(rows, config),
    fetchedAt: (options.now?.() ?? new Date()).toISOString(),
  };
}
