import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeName,
  matchEcrPlayers,
  parseEcrHtml,
} from "../../src/data/identity.mjs";
import { normalizePlayers } from "../../src/data/sources.mjs";
import { pool } from "../fixtures/sleeper.mjs";
import { rankings, html } from "../fixtures/rankings.mjs";
function inputs() {
  const p = pool();
  return {
    p: normalizePlayers(p.players, p.projections, p.history, "2026"),
    e: rankings(p.players),
  };
}
test("name punctuation/diacritics/suffix normalization is deterministic; HTML scripts never run", () => {
  assert.equal(normalizeName("José O’Neil Jr."), normalizeName("Jose ONeil"));
  delete globalThis.SOURCE_SCRIPT_EXECUTED;
  const e = { year: "2026", week: "0", scoring: "HALF", players: [] };
  assert.deepEqual(parseEcrHtml(html(e)), e);
  assert.equal(globalThis.SOURCE_SCRIPT_EXECUTED, undefined);
  assert.throws(() =>
    parseEcrHtml(
      "var ecrData = (()=>{globalThis.SOURCE_SCRIPT_EXECUTED=true})()",
    ),
  );
  assert.equal(globalThis.SOURCE_SCRIPT_EXECUTED, undefined);
});
test("exact joins, PK/K, DST/DEF, JAC/JAX; DB primary with WR eligibility retains policy", () => {
  const { p, e } = inputs();
  const k = Object.values(p).find((p) => p.position === "K");
  e.players.find((r) => r.player_name === k.name).player_position_id = "PK";
  const d = e.players.find(
    (r) => r.player_team_id === "JAX" && r.player_position_id === "DEF",
  );
  d.player_position_id = "DST";
  d.player_team_id = "JAC";
  d.player_name = "Any Defense";
  const w = Object.values(p).find((p) => p.position === "WR");
  w.position = "DB";
  assert.equal(matchEcrPlayers(e, p, "2026").valid, true);
  assert.equal(w.policyPosition, "WR");
});
test("top400 unresolved/ambiguous invalidates all; lower rows quarantine; duplicate IDs/ranks/joins rejected", () => {
  for (const mutate of [
    (e) => (e.players[0].player_name = "Unknown"),
    (e) => (e.players[1].player_id = e.players[0].player_id),
    (e) => (e.players[1].rank_ecr = 1),
    (e) =>
      Object.assign(e.players[1], {
        player_name: e.players[0].player_name,
        player_position_id: e.players[0].player_position_id,
        player_team_id: e.players[0].player_team_id,
      }),
    (e) => (e.year = "2025"),
    (e) => (e.week = "1"),
    (e) => (e.scoring = "PPR"),
  ]) {
    const { p, e } = inputs();
    mutate(e);
    const r = matchEcrPlayers(e, p, "2026");
    assert.equal(r.valid, false);
    assert.deepEqual(r.matches, {});
  }
  const { p, e } = inputs();
  e.players.push({
    player_id: "9007199254740993",
    player_name: "Unknown",
    rank_ecr: 401,
    player_position_id: "RB",
    player_team_id: "ARI",
  });
  let r = matchEcrPlayers(e, p, "2026");
  assert.equal(r.valid, true);
  assert.equal(r.quarantine[0].sourceId, "9007199254740993");
  p.extra = { ...Object.values(p)[0], id: "extra" };
  assert.equal(matchEcrPlayers(e, p, "2026").valid, false);
});
test("only reviewed FP aliases supplement exact matching; near aliases never fuzzy join", () => {
  const players = {
    5848: {
      id: "5848",
      name: "Marquise Brown",
      team: "KC",
      fantasyPositions: ["WR"],
    },
    8122: {
      id: "8122",
      name: "Zonovan Knight",
      team: "ARI",
      fantasyPositions: ["RB"],
    },
  };
  const e = {
    year: "2026",
    week: "0",
    scoring: "HALF",
    players: [
      {
        player_id: "18226",
        player_name: "Hollywood Brown",
        player_team_id: "KC",
        player_position_id: "WR",
        rank_ecr: 1,
      },
      {
        player_id: "24901",
        player_name: "Bam Knight",
        player_team_id: "ARI",
        player_position_id: "RB",
        rank_ecr: 2,
      },
    ],
  };
  const fixture = inputs();
  Object.assign(players, fixture.p);
  e.players.push(...fixture.e.players.slice(2));
  assert.equal(matchEcrPlayers(e, players, "2026").valid, true);
  e.players[0].player_id = "18227";
  assert.equal(matchEcrPlayers(e, players, "2026").valid, false);
});
test("empty or incomplete ECR top400 rejects, while JSON braces and embedded strings are parsed without code execution", () => {
  const { p, e } = inputs();
  e.players = e.players.slice(1);
  assert.equal(matchEcrPlayers(e, p, "2026").valid, false);
  const payload = { label: 'brace } and quote " and slash \\', players: [] };
  assert.deepEqual(parseEcrHtml(html(payload)), payload);
});
