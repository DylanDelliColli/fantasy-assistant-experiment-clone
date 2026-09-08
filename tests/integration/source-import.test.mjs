import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { upstream } from "../helpers/upstream.mjs";
import { rankings, html } from "../fixtures/rankings.mjs";
import { runPrepare } from "../../scripts/prepare-data.mjs";
import { loadSnapshot, writeJsonAtomic } from "../../src/data/snapshot.mjs";
async function setup(t) {
  const u = await upstream(t);
  const dir = await mkdtemp(path.join(tmpdir(), "source-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { ...u, dir, args: ["--data-dir", dir] };
}
test("real upstream inherited-key own IDs remain unavailable and disable advice without crashing", async (t) => {
  const u = await setup(t);
  const snapshot = await runPrepare(u.args, u.options);
  const { fetchDraftSnapshot } = await import("../../src/sleeper/client.mjs");
  const { createDraftState, reconcileDraft, deriveEffectiveDraft } =
    await import("../../src/draft/state.mjs");
  const { recommend } = await import("../../src/draft/recommend.mjs");
  const { pick } = await import("../fixtures/sleeper.mjs");
  for (const id of ["toString", "valueOf"]) {
    u.routes[`/v1/draft/${snapshot.config.draftId}/picks`] = [pick(1, id)];
    const state = reconcileDraft(
      createDraftState(snapshot),
      await fetchDraftSnapshot(snapshot.config, u.options),
    );
    const effective = deriveEffectiveDraft(state);
    assert.deepEqual(effective.ownPlayerIds, [id]);
    assert.deepEqual(effective.unavailableIds, [id]);
    const board = recommend(snapshot, effective);
    assert.equal(board.status, "unknown-own-player");
    assert.deepEqual(board.candidates, []);
    assert.equal(board.players.length, 400);
  }
  for (const id of ["__proto__", "constructor", "prototype"]) {
    u.routes[`/v1/draft/${snapshot.config.draftId}/picks`] = [pick(1, id)];
    await assert.rejects(
      fetchDraftSnapshot(snapshot.config, u.options),
      /Invalid player ID/,
    );
  }
});
test("malformed optional ECR timestamp replaces prior ECR only with a loadable ADP fallback and warning", async (t) => {
  const u = await setup(t);
  const file = path.join(u.dir, "snapshot.json");
  const initial = await runPrepare(u.args, u.options);
  assert.equal(initial.rankingMode, "ecr");
  assert.deepEqual(await loadSnapshot(file), initial);
  for (const value of [{ malformed: true }, [], false]) {
    const e = rankings(u.p.players);
    e.last_updated = value;
    u.routes["/ecr"] = html(e);
    const fallback = await runPrepare(u.args, u.options);
    assert.equal(fallback.rankingMode, "adp-only");
    assert.ok(
      fallback.importReport.warnings.some((w) => /ECR.*updated/i.test(w)),
    );
    assert.equal(fallback.sources.ecr, undefined);
    assert.ok(Object.values(fallback.playersById).every((p) => p.ecr === null));
    assert.deepEqual(await loadSnapshot(file), fallback);
    assert.equal(
      fallback.importReport.coverage.total,
      initial.importReport.coverage.total,
    );
  }
});
test("real parser/HTTP/filesystem preparation persists full joins and truthful provenance; fresh cache avoids player GET", async (t) => {
  const u = await setup(t);
  const s = await runPrepare(u.args, u.options);
  const saved = await loadSnapshot(path.join(u.dir, "snapshot.json"));
  assert.deepEqual(saved, s);
  assert.equal(s.version, 1);
  assert.equal(s.rankingMode, "ecr");
  assert.equal(Object.keys(s.playersById).length, 400);
  assert.equal(s.config.rosterId, "5");
  assert.equal(s.config.slot, 1);
  assert.equal(s.sources.projections.season, "2026");
  assert.equal(s.sources.history.season, "2025");
  assert.equal(s.sources.projections.scoring, "half-ppr");
  assert.equal(
    s.sources.projections.url,
    `${u.options.baseUrl}/projections/nfl/2026?season_type=regular`,
  );
  assert.ok(Object.values(s.playersById).every((p) => p.ecr?.rank > 0));
  await runPrepare(u.args, u.options);
  assert.equal(u.log.filter((r) => r.url === "/v1/players/nfl").length, 1);
  assert.ok(u.log.every((r) => r.method === "GET"));
  assert.equal(globalThis.SOURCE_SCRIPT_EXECUTED, undefined);
  assert.equal(
    execFileSync("git", ["check-ignore", ".local/sources/private.json"], {
      encoding: "utf8",
    }).trim(),
    ".local/sources/private.json",
  );
});
test("required HTTP/schema/coverage failures preserve exact previous snapshot bytes", async (t) => {
  const u = await setup(t);
  await runPrepare(u.args, u.options);
  const file = path.join(u.dir, "snapshot.json"),
    before = await readFile(file);
  const key = "/projections/nfl/2026?season_type=regular",
    good = u.routes[key];
  for (const bad of [
    new Error("http"),
    {},
    good.slice(1),
    [...good, good[0]],
    good.map((r, i) => (i ? r : { ...r, season: "2025" })),
  ]) {
    u.routes[key] = bad;
    await assert.rejects(runPrepare(u.args, u.options));
    assert.deepEqual(await readFile(file), before);
  }
});
test("optional ECR/history failures preserve current data; unresolved top400 falls back, rank401 quarantines", async (t) => {
  const u = await setup(t);
  u.routes["/ecr"] = new Error("optional");
  u.routes["/stats/nfl/2025?season_type=regular"] = new Error("optional");
  let s = await runPrepare(u.args, u.options);
  assert.equal(s.rankingMode, "adp-only");
  assert.ok(
    Object.values(s.playersById).every(
      (p) => p.ecr === null && p.history === null,
    ),
  );
  assert.ok(s.importReport.warnings.length >= 2);
  let e = rankings(u.p.players);
  e.players[0].player_name = "Missing";
  u.routes["/ecr"] = html(e);
  s = await runPrepare(u.args, u.options);
  assert.equal(s.rankingMode, "adp-only");
  assert.ok(Object.values(s.playersById).every((p) => p.ecr === null));
  e = rankings(u.p.players);
  e.players.push({
    player_id: "9007199254740993",
    rank_ecr: 401,
    player_name: "Absent",
    player_position_id: "RB",
    player_team_id: "ARI",
  });
  u.routes["/ecr"] = html(e);
  s = await runPrepare(u.args, u.options);
  assert.equal(s.rankingMode, "ecr");
  assert.equal(s.importReport.quarantine.length, 1);
  const count = u.log.filter((r) => r.url === "/ecr").length;
  await runPrepare([...u.args, "--without-ecr"], u.options);
  assert.equal(u.log.filter((r) => r.url === "/ecr").length, count);
});
test("explicit player file keeps original fetch time; cache expires exactly at24h; CLI rejects malformed flags", async (t) => {
  const u = await setup(t),
    file = path.join(u.dir, "players-input.json");
  await writeFile(file, JSON.stringify(u.p.players));
  const args = [
    ...u.args,
    "--league",
    u.c.league.league_id,
    "--user",
    "Kijuuu",
    "--players-file",
    file,
    "--players-fetched-at",
    "2026-09-08T16:28:00Z",
  ];
  const s = await runPrepare(args, u.options);
  assert.equal(s.sources.players.fetchedAt, "2026-09-08T16:28:00.000Z");
  assert.equal(u.log.filter((r) => r.url === "/v1/players/nfl").length, 0);
  await runPrepare(u.args, {
    ...u.options,
    now: () => new Date("2026-09-09T16:27:59Z"),
  });
  assert.equal(u.log.filter((r) => r.url === "/v1/players/nfl").length, 0);
  await runPrepare(u.args, {
    ...u.options,
    now: () => new Date("2026-09-09T16:28:00Z"),
  });
  assert.equal(u.log.filter((r) => r.url === "/v1/players/nfl").length, 1);
  for (const args of [
    ["--wat"],
    ["--user"],
    ["--players-file", file],
    ["--players-fetched-at", "bad"],
  ])
    await assert.rejects(runPrepare(args, u.options));
});
test("atomic replacement readers see complete old/new JSON; genuine rename conflict retains destination", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "atomic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "value.json"),
    a = { value: "old", body: "a".repeat(100000) },
    b = { value: "new", body: "b".repeat(100000) };
  await writeJsonAtomic(file, a);
  let reading = true;
  const reader = (async () => {
    while (reading) {
      const r = JSON.parse(await readFile(file, "utf8"));
      assert.ok(
        JSON.stringify(r) === JSON.stringify(a) ||
          JSON.stringify(r) === JSON.stringify(b),
      );
    }
  })();
  try {
    for (let i = 0; i < 20; i++) await writeJsonAtomic(file, i % 2 ? a : b);
  } finally {
    reading = false;
    await reader;
  }
  const conflict = path.join(dir, "conflict");
  await mkdir(conflict);
  await writeFile(path.join(conflict, "old.json"), "old bytes");
  await assert.rejects(writeJsonAtomic(conflict, b));
  assert.equal(
    await readFile(path.join(conflict, "old.json"), "utf8"),
    "old bytes",
  );
});
test("valid ECR activates rank-only candidate without satisfying required ADP floor; league name survives offline outside fingerprint", async (t) => {
  const u = await setup(t);
  const first = Object.values(u.p.players)[0];
  const extra = {
    ...first,
    player_id: "9007199254740993",
    full_name: "Fictional Rank Only",
  };
  u.p.players[extra.player_id] = extra;
  const e = rankings(u.p.players);
  u.routes["/ecr"] = html(e);
  u.c.league.name = "Fictional league display";
  const s = await runPrepare(u.args, u.options);
  const p = s.playersById[extra.player_id];
  assert.equal(s.rankingMode, "ecr");
  assert.equal(p.eligible, true);
  assert.equal(p.adp, null);
  assert.equal(p.adpBand, null);
  assert.equal(p.ecr.rank, 401);
  assert.equal(s.importReport.coverage.total, 400);
  assert.equal(
    (await loadSnapshot(path.join(u.dir, "snapshot.json"))).leagueName,
    "Fictional league display",
  );
  u.c.league.name = "Renamed display";
  const renamed = await runPrepare(u.args, u.options);
  assert.equal(renamed.configFingerprint, s.configFingerprint);
  assert.equal(renamed.leagueName, "Renamed display");
  u.routes["/ecr"] = new Error("unavailable");
  const fallback = await runPrepare(u.args, u.options);
  assert.equal(fallback.playersById[extra.player_id].eligible, false);
  u.routes["/projections/nfl/2026?season_type=regular"] =
    u.p.projections.slice(1);
  await assert.rejects(runPrepare(u.args, u.options), /400/);
});
test("actual persisted snapshot reader rejects corrupt config/player/source values without rewriting; context failures preserve good bytes", async (t) => {
  const u = await setup(t),
    s = await runPrepare(u.args, u.options),
    file = path.join(u.dir, "snapshot.json");
  for (const mutate of [
    (s) => (s.config.teams = "14"),
    (s) => delete s.config.rosterPositions,
    (s) => (s.playersById["10001"].adp = "1"),
    (s) => {
      s.playersById["10001"].adp = null;
      s.playersById["10001"].ecr = null;
    },
    (s) => (s.sources.players.fetchedAt = "invalid"),
  ]) {
    const bad = structuredClone(s);
    mutate(bad);
    const { configFingerprint } = await import("../../src/sleeper/client.mjs");
    bad.configFingerprint = configFingerprint(bad.config);
    await writeFile(file, JSON.stringify(bad));
    const bytes = await readFile(file);
    await assert.rejects(loadSnapshot(file));
    assert.deepEqual(await readFile(file), bytes);
  }
  await writeJsonAtomic(file, s);
  const before = await readFile(file);
  u.c.draft.settings.rounds = 3;
  await assert.rejects(runPrepare(u.args, u.options), /rounds/);
  assert.deepEqual(await readFile(file), before);
});
test("complete draft snapshots use GET, normalize picks, and reject configuration drift and gaps", async (t) => {
  const u = await setup(t);
  const { loadContext, fetchDraftSnapshot } = await import(
    "../../src/sleeper/client.mjs"
  );
  const { pick } = await import("../fixtures/sleeper.mjs");
  const { config } = await loadContext(u.options);
  u.routes[`/v1/draft/${config.draftId}/picks`] = [pick(2), pick(1)];
  const s = await fetchDraftSnapshot(config, u.options);
  assert.deepEqual(
    s.picks.map((p) => p.pickNo),
    [1, 2],
  );
  assert.equal(s.picks[0].rosterId, "5");
  assert.equal(s.status, "pre_draft");
  u.routes[`/v1/draft/${config.draftId}/picks`] = [pick(2)];
  await assert.rejects(fetchDraftSnapshot(config, u.options), /Gap/);
  u.routes[`/v1/draft/${config.draftId}/picks`] = [];
  u.c.draft.keepers = { 10001: 1 };
  await assert.rejects(fetchDraftSnapshot(config, u.options), /keeper/);
  assert.ok(u.log.every((r) => r.method === "GET"));
});
test("malformed required player fields cannot replace a valid snapshot; malformed optional history degrades truthfully", async (t) => {
  const u = await setup(t);
  await runPrepare(u.args, u.options);
  const file = path.join(u.dir, "snapshot.json"),
    before = await readFile(file),
    input = path.join(u.dir, "bad-players.json");
  const bad = structuredClone(u.p.players);
  bad["10001"].full_name = { invalid: true };
  await writeFile(input, JSON.stringify(bad));
  await assert.rejects(
    runPrepare(
      [
        ...u.args,
        "--players-file",
        input,
        "--players-fetched-at",
        "2026-09-08T16:28:00Z",
      ],
      u.options,
    ),
  );
  assert.deepEqual(await readFile(file), before);
  u.routes["/stats/nfl/2025?season_type=regular"] = [
    ...u.p.history,
    u.p.history[0],
  ];
  const fallback = await runPrepare(u.args, u.options);
  assert.ok(
    fallback.importReport.warnings.some((w) =>
      w.includes("History unavailable"),
    ),
  );
  assert.ok(
    Object.values(fallback.playersById).every((p) => p.history === null),
  );
});
