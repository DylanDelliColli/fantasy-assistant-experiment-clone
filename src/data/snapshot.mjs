import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  configFingerprint,
  validateConfig,
  externalId,
} from "../sleeper/client.mjs";
import { POSITIONS, NFL_TEAMS } from "./identity.mjs";
import { SNAPSHOT_VERSION } from "../contracts.mjs";

export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nullableNumber = (value) =>
  value === null || (typeof value === "number" && Number.isFinite(value));
const nullableText = (value) => value === null || typeof value === "string";
const originalTime = (value) =>
  value === null ||
  typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value));
const isoTime = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const positiveInteger = (value) => Number.isInteger(value) && value > 0;
function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid snapshot: ${message}`);
}
function validateSource(source, season, scoring) {
  requireValue(
    record(source) &&
      typeof source.url === "string" &&
      /^https?:\/\//.test(source.url) &&
      source.season === season &&
      source.scoring === scoring &&
      isoTime(source.fetchedAt) &&
      originalTime(source.updatedAt),
    "source provenance",
  );
}
function validatePlayer(id, p, mode) {
  requireValue(
    record(p) && p.id === id && externalId(id) && typeof p.name === "string",
    "player identity",
  );
  requireValue(
    nullableText(p.position) &&
      nullableText(p.team) &&
      typeof p.active === "boolean" &&
      Array.isArray(p.fantasyPositions) &&
      p.fantasyPositions.every((x) => typeof x === "string") &&
      new Set(p.fantasyPositions).size === p.fantasyPositions.length,
    "player fields",
  );
  const policy =
    POSITIONS.includes(p.position) && p.fantasyPositions.includes(p.position)
      ? p.position
      : (POSITIONS.find((x) => p.fantasyPositions.includes(x)) ?? null);
  requireValue(p.policyPosition === policy, "player policyPosition");
  requireValue(
    p.adp === null ||
      (typeof p.adp === "number" &&
        Number.isFinite(p.adp) &&
        p.adp > 0 &&
        p.adp !== 999),
    "player ADP",
  );
  requireValue(
    p.ecr === null ||
      (mode === "ecr" &&
        record(p.ecr) &&
        typeof p.ecr.sourceId === "string" &&
        externalId(p.ecr.sourceId) &&
        positiveInteger(p.ecr.rank) &&
        (p.ecr.tier === null || positiveInteger(p.ecr.tier)) &&
        originalTime(p.ecr.updatedAt)),
    "player ECR",
  );
  const eligible =
    p.active &&
    NFL_TEAMS.has(p.team) &&
    policy !== null &&
    (p.adp !== null || p.ecr !== null);
  requireValue(p.eligible === eligible, "candidate eligibility");
  requireValue(
    eligible && p.adp !== null
      ? Number.isInteger(p.adpBand) && p.adpBand >= 0
      : p.adpBand === null,
    "player ADP band",
  );
  for (const value of [p.projection, p.history]) {
    requireValue(
      value === null ||
        (record(value) &&
          nullableNumber(value.points) &&
          originalTime(value.updatedAt)),
      "player points",
    );
  }
  requireValue(
    record(p.injury) &&
      nullableText(p.injury.status) &&
      nullableText(p.injury.bodyPart) &&
      nullableText(p.injury.notes) &&
      originalTime(p.injury.updatedAt),
    "player injury",
  );
}

/** Load a complete prepared snapshot; reject corruption without writing the file. */
export async function loadSnapshot(file, expected = {}) {
  const s = JSON.parse(await readFile(file, "utf8"));
  requireValue(
    s?.version === SNAPSHOT_VERSION,
    "unsupported or missing version",
  );
  requireValue(
    typeof s.snapshotId === "string" &&
      s.snapshotId &&
      isoTime(s.preparedAt) &&
      typeof s.leagueName === "string",
    "header",
  );
  validateConfig(s.config);
  requireValue(
    s.configFingerprint === configFingerprint(s.config),
    "configuration fingerprint",
  );
  for (const key of ["leagueId", "draftId", "userId", "rosterId"]) {
    requireValue(
      expected[key] === undefined || s.config[key] === expected[key],
      "context identity mismatch",
    );
  }
  requireValue(
    record(s.sources) &&
      record(s.importReport) &&
      record(s.playersById) &&
      ["ecr", "adp-only"].includes(s.rankingMode),
    "schema",
  );
  validateSource(s.sources.players, s.config.season, null);
  validateSource(s.sources.projections, s.config.season, "half-ppr");
  if (s.sources.history)
    validateSource(
      s.sources.history,
      String(Number(s.config.season) - 1),
      "half-ppr",
    );
  if (s.rankingMode === "ecr")
    validateSource(s.sources.ecr, s.config.season, "half-ppr");
  for (const [id, p] of Object.entries(s.playersById))
    validatePlayer(id, p, s.rankingMode);
  const adpPool = Object.values(s.playersById)
    .filter((p) => p.eligible && p.adp !== null)
    .sort((a, b) => a.adp - b.adp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  requireValue(adpPool.length >= 400, "ADP coverage below 400");
  requireValue(
    adpPool.every((p, i) => p.adpBand === Math.floor(i / 12)),
    "fixed ADP bands",
  );
  const floors = { QB: 14, RB: 42, WR: 42, TE: 14, K: 14, DEF: 14 };
  const coverage = s.importReport.coverage;
  requireValue(
    record(coverage) &&
      record(coverage.positions) &&
      coverage.total === adpPool.length &&
      Array.isArray(s.importReport.warnings) &&
      s.importReport.warnings.every((x) => typeof x === "string") &&
      Array.isArray(s.importReport.quarantine),
    "import report",
  );
  for (const [position, min] of Object.entries(floors)) {
    const count = adpPool.filter((p) => p.policyPosition === position).length;
    requireValue(
      count >= min && coverage.positions[position] === count,
      `coverage ${position}`,
    );
  }
  const ranked = Object.values(s.playersById).filter((p) => p.ecr !== null);
  requireValue(
    new Set(ranked.map((p) => p.ecr.rank)).size === ranked.length &&
      new Set(ranked.map((p) => p.ecr.sourceId)).size === ranked.length,
    "duplicate ECR ranks/identities",
  );
  if (s.rankingMode === "ecr") {
    const ranks = new Set(ranked.map((p) => p.ecr.rank));
    requireValue(
      Array.from({ length: 400 }, (_, i) => i + 1).every((rank) =>
        ranks.has(rank),
      ),
      "ECR top400 coverage",
    );
  }
  return s;
}
