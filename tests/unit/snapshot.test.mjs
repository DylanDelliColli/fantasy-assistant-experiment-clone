import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSnapshot, writeJsonAtomic } from "../../src/data/snapshot.mjs";
import {
  configFingerprint,
  normalizeContext,
} from "../../src/sleeper/client.mjs";
import { context, pool } from "../fixtures/sleeper.mjs";
import { normalizePlayers, validateCoverage } from "../../src/data/sources.mjs";
export function snapshot() {
  const p = pool(),
    config = normalizeContext(context());
  return {
    version: 1,
    snapshotId: "test",
    preparedAt: "2026-09-08T18:00:00Z",
    config,
    configFingerprint: configFingerprint(config),
    leagueName: "Fictional league",
    sources: Object.fromEntries(
      ["players", "projections", "history"].map((name) => [
        name,
        {
          url: `https://example.test/${name}`,
          season: name === "history" ? "2025" : "2026",
          scoring: name === "players" ? null : "half-ppr",
          fetchedAt: "2026-09-08T18:00:00Z",
          updatedAt: null,
        },
      ]),
    ),
    playersById: normalizePlayers(p.players, p.projections, p.history, "2026"),
    rankingMode: "adp-only",
    importReport: {
      coverage: validateCoverage(
        normalizePlayers(p.players, p.projections, p.history, "2026"),
      ),
      warnings: [],
      quarantine: [],
    },
  };
}
test("snapshot v1 round trips; missing/unsupported version and identity mismatch reject without rewrite", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "snapshot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "snapshot.json");
  const s = snapshot();
  await writeJsonAtomic(file, s);
  assert.deepEqual(await loadSnapshot(file), s);
  for (const change of [
    (s) => delete s.version,
    (s) => (s.version = 2),
    (s) => (s.playersById[Object.keys(s.playersById)[0]].id = "wrong"),
    (s) => (s.configFingerprint = "wrong"),
  ]) {
    const bad = structuredClone(s);
    change(bad);
    await writeFile(file, JSON.stringify(bad));
    const before = await readFile(file);
    await assert.rejects(loadSnapshot(file));
    assert.deepEqual(await readFile(file), before);
  }
});
test("reader rejects malformed config and candidate values even when the fingerprint is self-consistent", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "corrupt-snapshot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "snapshot.json");
  for (const change of [
    (s) => (s.config.teams = "14"),
    (s) => delete s.config.rosterPositions,
    (s) => (s.config.slot = 2),
    (s) => (s.config.rounds = 3),
    (s) => (s.config.draftOrder[s.config.userId] = 3),
    (s) => (s.config.keeperAssignments["5"] = ["123"]),
    (s) => (s.config.tradedPicks = [{ round: 1 }]),
    (s) => (s.playersById["10001"].adp = "1"),
    (s) => (s.playersById["10001"].adp = 999),
    (s) => (s.playersById["10001"].adp = NaN),
    (s) => (s.playersById["10001"].adp = -1),
    (s) => (s.playersById["10001"].policyPosition = "DB"),
    (s) => (s.playersById["10001"].active = false),
    (s) => (s.playersById["10001"].team = null),
    (s) => (s.playersById["10001"].adpBand = -1),
    (s) => (s.playersById["10001"].projection.points = "100"),
  ]) {
    const bad = snapshot();
    change(bad);
    bad.configFingerprint = configFingerprint(bad.config);
    await writeFile(file, JSON.stringify(bad));
    const before = await readFile(file);
    await assert.rejects(loadSnapshot(file));
    assert.deepEqual(await readFile(file), before);
  }
});
