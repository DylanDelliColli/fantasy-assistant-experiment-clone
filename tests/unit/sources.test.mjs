import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlayers, validateCoverage } from "../../src/data/sources.mjs";
import { pool } from "../fixtures/sleeper.mjs";
const normalize = (p) =>
  normalizePlayers(p.players, p.projections, p.history, "2026");
test("ADP and points keep null, sentinel and genuine numeric zero distinct; provenance stays separate", () => {
  const p = pool();
  const row = p.projections[0];
  for (const v of [undefined, null, NaN, Infinity, -1, 0, 999]) {
    row.stats.adp_half_ppr = v;
    assert.equal(normalize(p)[row.player_id].adp, null);
  }
  row.stats.adp_half_ppr = 1;
  let a = normalize(p)[row.player_id];
  assert.equal(a.projection.points, 0);
  assert.equal(a.history.points, 90);
  assert.equal(a.projection.updatedAt, 1788800000000);
  assert.equal(a.history.updatedAt, 1758800000000);
  row.stats.gp = 1;
  assert.deepEqual(normalize(p)[row.player_id].projection, a.projection);
  delete row.stats.pts_half_ppr;
  assert.equal(normalize(p)[row.player_id].projection.points, null);
});
test("400 eligible ADP players pass, 399 fail and every position floor is enforced independently", () => {
  const p = normalize(pool());
  assert.equal(validateCoverage(p).total, 400);
  const one = structuredClone(p);
  delete one[Object.keys(one)[0]];
  assert.throws(() => validateCoverage(one), /400/);
  for (const [pos, min] of Object.entries({
    QB: 14,
    RB: 42,
    WR: 42,
    TE: 14,
    K: 14,
    DEF: 14,
  })) {
    const q = structuredClone(p);
    let count = 0;
    for (const x of Object.values(q))
      if (x.policyPosition === pos && ++count >= min)
        x.policyPosition = pos === "WR" ? "RB" : "WR";
    assert.throws(() => validateCoverage(q), new RegExp(pos));
  }
});
test("wrong season and duplicate projection IDs fail; inactive and teamless identities retained but excluded; ordinal bands fixed", () => {
  let p = pool();
  p.projections[0].season = "2025";
  assert.throws(() => normalize(p), /season/);
  p = pool();
  p.projections.push(p.projections[0]);
  assert.throws(() => normalize(p), /duplicate/);
  p = pool();
  const ids = Object.keys(p.players);
  p.players[ids[0]].active = false;
  p.players[ids[1]].team = null;
  const result = normalize(p);
  assert.equal(result[ids[0]].eligible, false);
  assert.equal(result[ids[1]].eligible, false);
  assert.equal(Object.keys(result).length, 400);
  const eligible = Object.values(result)
    .filter((p) => p.eligible)
    .sort((a, b) => a.adp - b.adp);
  assert.equal(eligible[11].adpBand, 0);
  assert.equal(eligible[12].adpBand, 1);
});
test("rank-only eligibility is assigned after ECR, while missing ADP has no band and cannot satisfy coverage; primary DB retains all eligibility", () => {
  const p = pool();
  const id = Object.keys(p.players)[0];
  p.players[id].position = "DB";
  p.players[id].fantasy_positions = ["DB", "WR"];
  p.projections[0].stats.adp_half_ppr = null;
  const result = normalize(p);
  assert.deepEqual(result[id].fantasyPositions, ["DB", "WR"]);
  assert.equal(result[id].policyPosition, "WR");
  assert.equal(result[id].eligible, false);
  assert.equal(result[id].adpBand, null);
});
test("rank-only candidate activates from valid ECR without ADP or band; inactive identity stays excluded", async () => {
  const { applyEcrRanks } = await import("../../src/data/sources.mjs");
  const raw = pool();
  raw.projections[0].stats.adp_half_ppr = null;
  const p = normalize(raw);
  applyEcrRanks(p, {
    10001: { sourceId: "r1", rank: 1, tier: 1, updatedAt: null },
  });
  assert.equal(p["10001"].eligible, true);
  assert.equal(p["10001"].adp, null);
  assert.equal(p["10001"].adpBand, null);
  p["10001"].active = false;
  applyEcrRanks(p, {
    10001: { sourceId: "r1", rank: 1, tier: 1, updatedAt: null },
  });
  assert.equal(p["10001"].eligible, false);
});
test("malformed player labels, fantasy eligibility and original update values fail source schema validation", () => {
  for (const change of [
    (p) => (p.players["10001"].full_name = {}),
    (p) => (p.players["10001"].fantasy_positions = [null]),
    (p) => (p.players["10001"].fantasy_positions = "QB"),
    (p) => (p.players["10001"].team = 42),
    (p) => (p.players["10001"].injury_status = []),
    (p) => (p.projections[0].updated_at = {}),
  ]) {
    const p = pool();
    change(p);
    assert.throws(() => normalize(p));
  }
});
