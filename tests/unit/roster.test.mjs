import test from "node:test";
import assert from "node:assert/strict";
import {
  assignRoster,
  completionFeasible,
  policyCounts,
} from "../../src/draft/roster.mjs";
import { draftPlayer as p, draftFixture } from "../fixtures/rankings.mjs";

test("maximum roster matching uses dual eligibility once and reserves dedicated slots before FLEX", () => {
  const players = [p("dual", ["RB", "WR"]), p("rb", "RB"), p("te", "TE")];
  const result = assignRoster(players, ["RB", "WR", "FLEX"]);
  assert.deepEqual(
    result.slots.map((s) => s.playerId),
    ["rb", "dual", "te"],
  );
  assert.equal(result.missing.length, 0);
  assert.equal(new Set(result.slots.map((s) => s.playerId)).size, 3);
  const single = assignRoster([players[0]], ["RB", "WR", "FLEX"]);
  assert.deepEqual(
    single.slots.map((s) => s.playerId),
    ["dual", null, null],
  );
  assert.equal(single.filled, 1);
  assert.deepEqual(
    assignRoster([p("b", "RB"), p("a", "RB")], ["RB", "RB"]).slots.map(
      (s) => s.playerId,
    ),
    ["a", "b"],
  );
});

test("one dual player cannot complete two distinct holes; selection limit and policy caps constrain matching", () => {
  assert.equal(
    completionFeasible([], [p("dual", ["RB", "WR"])], 2, ["RB", "WR"]),
    false,
  );
  assert.equal(
    completionFeasible([], [p("dual", ["RB", "WR"]), p("rb", "RB")], 2, [
      "RB",
      "WR",
    ]),
    true,
  );
  assert.equal(
    completionFeasible([], [p("dual", ["RB", "WR"]), p("rb", "RB")], 1, [
      "RB",
      "WR",
    ]),
    false,
  );
  const owned = [p("q1", "QB"), p("q2", "QB")];
  assert.equal(
    completionFeasible(owned, [p("q3", ["QB", "WR"])], 1, ["QB", "WR"]),
    false,
  );
  assert.equal(
    completionFeasible(owned, [p("w", "WR")], 1, ["QB", "WR"]),
    true,
  );
});

test("feasibility can rematch owned players and counts canonical policy once even with existing excess", () => {
  const dual = p("dual", ["QB", "WR"], { policyPosition: "WR" });
  assert.equal(
    completionFeasible([dual], [p("q", "QB")], 1, ["QB", "WR"]),
    true,
  );
  assert.deepEqual(policyCounts([dual]), {
    QB: 0,
    RB: 0,
    WR: 1,
    TE: 0,
    K: 0,
    DEF: 0,
  });
  assert.equal(
    completionFeasible([p("k1", "K"), p("k2", "K")], [p("w", "WR")], 1, [
      "K",
      "WR",
    ]),
    true,
  );
  assert.equal(
    completionFeasible([p("w1", "WR")], [p("w2", "WR")], 1, ["WR", "WR"]),
    true,
  );
});

test("actual roster has nine starters and four bench places; reserve never adds a slot", () => {
  const fixture = draftFixture();
  const players = [
    "QB",
    "RB",
    "RB",
    "WR",
    "WR",
    "TE",
    "RB",
    "K",
    "DEF",
    "WR",
    "RB",
    "WR",
    "RB",
  ].map((pos, i) => p(String(i), pos));
  const result = assignRoster(players, fixture.config);
  assert.equal(result.slots.length, 9);
  assert.equal(result.filled, 9);
  assert.equal(result.bench.length, 4);
  assert.equal(result.missing.length, 0);
});
