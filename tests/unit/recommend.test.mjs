import test from "node:test";
import assert from "node:assert/strict";
import { recommend } from "../../src/draft/recommend.mjs";
import {
  createDraftState,
  reconcileDraft,
  deriveEffectiveDraft,
  ownPickSchedule,
} from "../../src/draft/state.mjs";
import { configFingerprint } from "../../src/sleeper/client.mjs";
import { draftPlayer as p, draftFixture } from "../fixtures/rankings.mjs";

const basePositions = ["QB", "RB", "RB", "WR", "WR", "TE", "RB", "K", "DEF"];
function fixture(ownPositions, candidates, mode = "ecr") {
  const owned = ownPositions.map((position, i) => p(`own-${i}`, position));
  const snapshot = draftFixture([...owned, ...candidates], mode);
  const schedule = ownPickSchedule(snapshot.config);
  const state = createDraftState(snapshot);
  // Recommendation unit boundary is the already-normalized effective state.
  const effective = {
    ...deriveEffectiveDraft(state, snapshot.config),
    availabilityKnown: true,
    ownPlayerIds: owned.map((x) => x.id),
    unavailableIds: owned.map((x) => x.id),
    remainingPicks: schedule.slice(owned.length),
    nextPicks: schedule.slice(owned.length, owned.length + 2),
    configFingerprint: configFingerprint(snapshot.config),
  };
  return { snapshot, effective, owned };
}
const ids = (result) => result.candidates.map((x) => x.id);
const ecr = (rank, tier = 1) => ({
  rank,
  tier,
  sourceId: `fp-${rank}`,
  updatedAt: null,
});

test("inherited dictionary keys are unknown own identities and keep player browsing available", () => {
  const { snapshot, effective } = fixture([], [p("known", "WR")]);
  for (const id of ["toString", "constructor", "__proto__"]) {
    const result = recommend(snapshot, {
      ...effective,
      ownPlayerIds: [id],
      unavailableIds: [id],
    });
    assert.equal(result.status, "unknown-own-player");
    assert.deepEqual(result.candidates, []);
    assert.equal(result.players.length, 1);
    assert.equal(result.roster.filled, 0);
  }
});

test("returns exactly0/1/2/3 distinct survivors without padding; complete and unknown are separate", () => {
  for (const count of [0, 1, 2, 3, 4]) {
    const candidates = Array.from({ length: count }, (_, i) =>
      p(`candidate-${i}`, "WR"),
    );
    const { snapshot, effective } = fixture(basePositions, candidates);
    const result = recommend(snapshot, effective);
    assert.equal(result.candidates.length, Math.min(count, 3));
    assert.equal(new Set(ids(result)).size, result.candidates.length);
    if (count === 0) assert.equal(result.status, "unavailable");
  }
  const { snapshot, effective } = fixture(
    [...basePositions, "WR", "RB", "WR", "RB"],
    [p("extra", "WR")],
  );
  assert.equal(recommend(snapshot, effective).status, "complete");
  effective.ownPlayerIds[0] = "unknown-completed-own-pick";
  assert.equal(recommend(snapshot, effective).status, "complete");
  effective.availabilityKnown = false;
  assert.equal(recommend(snapshot, effective).status, "unknown-initial");
});

test("hard eligibility, taken and canonical caps exclude candidates without excluding unrelated positions", () => {
  const candidates = [
    p("off", "WR", { eligible: false }),
    p("taken", "WR"),
    p("k", "K"),
    p("d", "DEF"),
    p("q3", "QB"),
    p("t3", "TE"),
    p("ok", "WR"),
  ];
  const { snapshot, effective } = fixture(
    [...basePositions, "QB", "TE", "K"],
    candidates,
  );
  effective.unavailableIds.push("taken");
  assert.deepEqual(ids(recommend(snapshot, effective)), ["ok"]);
  const dual = p("dual", ["RB", "WR"], { policyPosition: "RB" });
  const f = fixture(basePositions, [dual]);
  assert.deepEqual(ids(recommend(f.snapshot, f.effective)), ["dual"]);
});

test("same-tier starter fit wins, while an ordinary cross-tier need boost is forbidden", () => {
  // QB,RB,RB,WR,TE,FLEX,K,DEF filled; one WR starter remains.
  const own = ["QB", "RB", "RB", "WR", "TE", "RB", "K", "DEF"];
  let f = fixture(own, [
    p("rb", "RB", { ecr: ecr(1) }),
    p("wr", "WR", { ecr: ecr(2) }),
  ]);
  assert.deepEqual(ids(recommend(f.snapshot, f.effective)), ["wr", "rb"]);
  f.snapshot.playersById.wr.ecr = ecr(2, 2);
  assert.deepEqual(ids(recommend(f.snapshot, f.effective)), ["rb", "wr"]);
});

test("ranked precedes unranked within group, but ordinary unranked precedes early ranked DEF", () => {
  const own = ["QB", "RB", "RB", "WR", "WR", "TE", "RB"];
  const f = fixture(own, [
    p("ranked", "RB", { ecr: ecr(100) }),
    p("unranked", "RB", { ecr: null, adp: 1 }),
    p("def", "DEF", { ecr: ecr(1) }),
    p("k", "K", { ecr: ecr(2) }),
  ]);
  assert.deepEqual(ids(recommend(f.snapshot, f.effective)), [
    "ranked",
    "unranked",
    "def",
  ]);
});

test("prepared ADP12/13 bands and stable ID ties survive removal; bands outrank starter fit", () => {
  const own = ["QB", "RB", "RB", "WR", "TE", "RB", "K", "DEF"];
  const f = fixture(
    own,
    [
      p("b", "RB", { adp: 12, adpBand: 0, ecr: null }),
      p("a", "RB", { adp: 12, adpBand: 0, ecr: null }),
      p("wr", "WR", { adp: 13, adpBand: 1, ecr: null }),
      p("gone", "RB", { adp: 1, adpBand: 0, ecr: null }),
    ],
    "adp-only",
  );
  f.effective.unavailableIds.push("gone");
  assert.deepEqual(ids(recommend(f.snapshot, f.effective)), ["a", "b", "wr"]);
});

test("dual QB filling offense avoids deferral; adding a second QB cannot consume the only future WR option", () => {
  const own = ["QB", "RB", "RB", "WR", "TE", "RB", "K", "DEF"];
  const f = fixture(own, [
    p("q", "QB", { ecr: ecr(1) }),
    p("te", "TE", { ecr: ecr(2) }),
    p("rb", "RB", { ecr: ecr(100) }),
    p("dual", ["QB", "WR"], { ecr: ecr(50) }),
  ]);
  assert.deepEqual(ids(recommend(f.snapshot, f.effective)), [
    "dual",
    "rb",
    "te",
  ]);
});

test("ordinary RB candidates precede better-ranked backup QB/TE while offense has holes", () => {
  // FLEX is already filled by the extra WR; only a dedicated RB remains open.
  const own = ["QB", "RB", "WR", "WR", "TE", "K", "DEF", "WR"];
  const f = fixture(own, [
    p("q", "QB", { ecr: ecr(1) }),
    p("te", "TE", { ecr: ecr(2) }),
    p("rb1", "RB", { ecr: ecr(100) }),
    p("rb2", "RB", { ecr: ecr(101) }),
  ]);
  assert.deepEqual(ids(recommend(f.snapshot, f.effective)), [
    "rb1",
    "rb2",
    "q",
  ]);
});

test("K/DEF defer early but final two selections force their completion rather than impossible offense", () => {
  const own = [
    "QB",
    "RB",
    "RB",
    "WR",
    "WR",
    "TE",
    "RB",
    "WR",
    "RB",
    "WR",
    "RB",
  ];
  const f = fixture(own, [
    p("rb", "RB", { ecr: ecr(1) }),
    p("k", "K", { ecr: ecr(3) }),
    p("def", "DEF", { ecr: ecr(2) }),
  ]);
  assert.deepEqual(ids(recommend(f.snapshot, f.effective)), ["def", "k"]);
  const missing = fixture(own, [p("rb", "RB")]);
  const result = recommend(missing.snapshot, missing.effective);
  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /complete|starter/i);
  assert.equal(result.players.length, 12);
});

test("specialist deferral lifts at exactly two remaining selections even when ordinary candidates remain feasible", () => {
  const own = [
    "QB",
    "RB",
    "RB",
    "WR",
    "WR",
    "TE",
    "RB",
    "DEF",
    "RB",
    "WR",
    "RB",
  ];
  const candidates = [
    p("k", "K", { ecr: ecr(1) }),
    p("rb", "RB", { ecr: ecr(2) }),
  ];
  const finalTwo = fixture(own, candidates);
  assert.deepEqual(ids(recommend(finalTwo.snapshot, finalTwo.effective)), [
    "k",
    "rb",
  ]);
  const early = fixture(own.slice(0, -1), candidates);
  assert.deepEqual(ids(recommend(early.snapshot, early.effective)), [
    "rb",
    "k",
  ]);
});

test("context points/injury never alter rank or invent health, per-game, survival claims; output deterministic", () => {
  const f = fixture(basePositions, [
    p("a", "RB", { ecr: ecr(1) }),
    p("b", "WR", { ecr: ecr(2) }),
  ]);
  const before = recommend(f.snapshot, f.effective);
  f.snapshot.playersById.a.projection.points = -500;
  f.snapshot.playersById.b.projection.points = 5000;
  f.snapshot.playersById.a.injury.status = "Questionable";
  const after = recommend(f.snapshot, f.effective);
  assert.deepEqual(ids(before), ids(after));
  assert.deepEqual(after, recommend(f.snapshot, structuredClone(f.effective)));
  assert.doesNotMatch(
    JSON.stringify(after.candidates.map((c) => c.reasons)),
    /healthy|per.game|survival|%/i,
  );
});

test("full400-player calculation is deterministic and initial empty board yields three eligible distinct choices", () => {
  const snapshot = draftFixture(null, "adp-only");
  const state = reconcileDraft(createDraftState(snapshot), {
    draftId: snapshot.config.draftId,
    configFingerprint: configFingerprint(snapshot.config),
    picks: [],
    status: "pre_draft",
    fetchedAt: "2026-09-08T20:00:00Z",
  });
  const effective = deriveEffectiveDraft(state, snapshot.config);
  const a = recommend(snapshot, effective),
    b = recommend(snapshot, effective);
  assert.equal(a.candidates.length, 3);
  assert.equal(a.players.length, 400);
  assert.deepEqual(a, b);
  assert.ok(a.candidates.every((c) => snapshot.playersById[c.id].eligible));
});
