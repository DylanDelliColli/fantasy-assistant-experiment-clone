import test from "node:test";
import assert from "node:assert/strict";
import {
  createDraftState,
  reconcileDraft,
  applyLocalAction,
  deriveEffectiveDraft,
  ownPickSchedule,
} from "../../src/draft/state.mjs";
import { recommend } from "../../src/draft/recommend.mjs";
import {
  configFingerprint,
  normalizePicks,
} from "../../src/sleeper/client.mjs";
import { pick } from "../fixtures/sleeper.mjs";
import { draftFixture } from "../fixtures/rankings.mjs";

const expectedSchedule = [
  1, 28, 29, 56, 57, 84, 85, 112, 113, 140, 141, 168, 169,
];
function setup() {
  const snapshot = draftFixture();
  return {
    snapshot,
    state: createDraftState(snapshot),
    ids: Object.keys(snapshot.playersById),
  };
}
function incoming(snapshot, rows = [], extra = {}) {
  return {
    draftId: snapshot.config.draftId,
    configFingerprint: configFingerprint(snapshot.config),
    picks: normalizePicks(rows, snapshot.config),
    status: "drafting",
    fetchedAt: "2026-09-08T20:00:00Z",
    ...extra,
  };
}
const act = (state, action) =>
  applyLocalAction(state, { expectedRevision: state.revision, ...action });

test("unknown availability differs from an accepted empty board; exact own schedule excludes reserve", () => {
  const { snapshot, state } = setup();
  assert.deepEqual(ownPickSchedule(snapshot.config), expectedSchedule);
  assert.equal(state.accepted, null);
  assert.equal(
    recommend(snapshot, deriveEffectiveDraft(state, snapshot.config)).status,
    "unknown-initial",
  );
  const known = reconcileDraft(state, incoming(snapshot));
  assert.deepEqual(known.accepted.picks, []);
  assert.equal(
    recommend(snapshot, deriveEffectiveDraft(known, snapshot.config)).candidates
      .length,
    3,
  );
  assert.deepEqual(
    deriveEffectiveDraft(known, snapshot.config).nextPicks,
    [1, 28],
  );
});

test("taken and undo only affect availability; local28 immediately yields29/56 without opponent invention", () => {
  let { snapshot, state, ids } = setup();
  state = reconcileDraft(state, incoming(snapshot, [pick(1, ids[0])]));
  const before = structuredClone(state);
  state = act(state, { type: "taken", playerId: ids[1] });
  let effective = deriveEffectiveDraft(state, snapshot.config);
  assert.equal(effective.observedCount, 1);
  assert.deepEqual(effective.ownPlayerIds, [ids[0]]);
  assert.ok(effective.unavailableIds.includes(ids[1]));
  state = act(state, { type: "undo", correctionId: state.corrections[0].id });
  assert.deepEqual(state.accepted, before.accepted);
  assert.equal(state.corrections.length, 0);
  state = act(state, { type: "my-pick", playerId: ids[2], pickNo: 28 });
  effective = deriveEffectiveDraft(state, snapshot.config);
  assert.deepEqual(effective.nextPicks, [29, 56]);
  assert.deepEqual(effective.ownPlayerIds, [ids[0], ids[2]]);
  assert.equal(effective.observedCount, 1);
  assert.equal(state.accepted.picks.length, 1);
});

test("official confirmation retires once; official conflicting slot or player ownership wins visibly", () => {
  for (const conflict of ["confirmation", "slot", "player"]) {
    let { snapshot, state, ids } = setup();
    state = reconcileDraft(state, incoming(snapshot, [pick(1, ids[0])]));
    state = act(state, { type: "my-pick", playerId: ids[1], pickNo: 28 });
    const correctionId = state.corrections[0].id;
    const rows = Array.from({ length: 28 }, (_, i) =>
      pick(i + 1, i === 0 ? ids[0] : `opponent-${i}`),
    );
    if (conflict === "confirmation") rows[27] = pick(28, ids[1]);
    if (conflict === "player") rows[1] = pick(2, ids[1]);
    state = reconcileDraft(state, incoming(snapshot, rows));
    assert.equal(state.corrections.length, 0);
    assert.ok(
      state.notices.some((notice) => notice.correctionId === correctionId),
    );
    const unchanged = reconcileDraft(state, incoming(snapshot, rows));
    assert.equal(unchanged.revision, state.revision);
    assert.equal(
      new Set(deriveEffectiveDraft(state, snapshot.config).ownPlayerIds).size,
      2,
    );
    assert.throws(
      () => act(state, { type: "undo", correctionId }),
      /local correction/i,
    );
  }
});

test("invalid, duplicate, unknown, occupied, non-own and out-of-order actions fail without changing input", () => {
  let { snapshot, state, ids } = setup();
  state = reconcileDraft(state, incoming(snapshot, [pick(1, ids[0])]));
  const before = structuredClone(state);
  for (const action of [
    { type: "taken", playerId: "absent" },
    { type: "taken", playerId: ids[0] },
    { type: "my-pick", playerId: ids[1], pickNo: 1 },
    { type: "my-pick", playerId: ids[1], pickNo: 2 },
    { type: "my-pick", playerId: ids[1], pickNo: 29 },
    { type: "my-pick", playerId: ids[1], pickNo: 28.5 },
    { type: "undo", correctionId: "missing" },
    { type: "accept-pending", pendingRevision: "missing" },
    { type: "write-sleeper" },
  ])
    assert.throws(
      () => act(state, action),
      (error) => error.status === 422,
    );
  assert.throws(
    () =>
      applyLocalAction(state, {
        expectedRevision: state.revision - 1,
        type: "taken",
        playerId: ids[1],
      }),
    (error) => error.status === 409,
  );
  assert.deepEqual(state, before);
  state = act(state, { type: "taken", playerId: ids[1] });
  assert.throws(
    () => act(state, { type: "my-pick", playerId: ids[1], pickNo: 28 }),
    /already/i,
  );
});

test("smaller/changed boards remain pending; only exact review token adopts and clears affected corrections", () => {
  let { snapshot, state, ids } = setup();
  const original = Array.from({ length: 28 }, (_, i) =>
    pick(i + 1, i === 0 ? ids[0] : i === 27 ? ids[1] : `opponent-${i}`),
  );
  state = reconcileDraft(state, incoming(snapshot, original));
  state = act(state, { type: "my-pick", playerId: ids[2], pickNo: 29 });
  state = act(state, { type: "taken", playerId: ids[3] });
  const changed = original.slice(0, 27);
  const held = reconcileDraft(state, incoming(snapshot, changed));
  assert.equal(held.accepted.picks.length, 28);
  assert.equal(held.pending.diff.firstChangedPick, 28);
  assert.equal(held.revision, state.revision);
  assert.throws(
    () => act(held, { type: "accept-pending", pendingRevision: "obsolete" }),
    /pending/i,
  );
  const adopted = act(held, {
    type: "accept-pending",
    pendingRevision: held.pending.revision,
  });
  assert.equal(adopted.accepted.picks.length, 27);
  assert.equal(adopted.corrections.length, 0);
  assert.equal(adopted.notices.filter((n) => n.kind === "cleared").length, 2);
  assert.equal(adopted.pending, null);
  const alternate = changed.map((row, i) => (i === 0 ? pick(1, ids[4]) : row));
  const second = reconcileDraft(held, incoming(snapshot, alternate));
  assert.notEqual(second.pending.revision, held.pending.revision);
  assert.equal(second.pending.diff.firstChangedPick, 1);
  assert.throws(() =>
    act(second, {
      type: "accept-pending",
      pendingRevision: held.pending.revision,
    }),
  );
});

test("rollback preserves unaffected early own corrections while clearing all unassigned markers", () => {
  let { snapshot, state, ids } = setup();
  state = reconcileDraft(state, incoming(snapshot));
  state = act(state, { type: "my-pick", playerId: ids[0], pickNo: 1 });
  state = act(state, { type: "taken", playerId: ids[1] });
  // A changed source can be reviewed without inventing an official confirmation.
  state.accepted = incoming(snapshot, [
    pick(1, "other-own"),
    pick(2, "opponent"),
  ]);
  const held = reconcileDraft(
    state,
    incoming(snapshot, [pick(1, "other-own")]),
  );
  const adopted = act(held, {
    type: "accept-pending",
    pendingRevision: held.pending.revision,
  });
  // Official conflicting ownership still overrides the early local correction.
  assert.equal(adopted.corrections.length, 0);
  assert.ok(adopted.notices.some((n) => n.kind === "conflict"));
});

test("obsolete fetches cannot replace actions; unchanged checks and failure preserve durable revision", () => {
  let { snapshot, state, ids } = setup();
  state = reconcileDraft(state, incoming(snapshot));
  const oldRevision = state.revision;
  state = act(state, { type: "taken", playerId: ids[0] });
  assert.deepEqual(
    reconcileDraft(
      state,
      incoming(snapshot, [], { baseRevision: oldRevision }),
    ),
    state,
  );
  const checked = reconcileDraft(
    state,
    incoming(snapshot, [], { fetchedAt: "2026-09-08T20:00:05Z" }),
  );
  assert.equal(checked.revision, state.revision);
  assert.equal(checked.lastCheckedAt, "2026-09-08T20:00:05Z");
  assert.equal(checked.lastChangedAt, null);
  const failed = reconcileDraft(checked, {
    error: "offline",
    fetchedAt: "2026-09-08T20:00:10Z",
  });
  assert.equal(failed.error, "offline");
  assert.equal(failed.lastCheckedAt, checked.lastCheckedAt);
  assert.equal(failed.revision, checked.revision);
  assert.deepEqual(failed.accepted, checked.accepted);
  assert.throws(
    () =>
      reconcileDraft(
        state,
        incoming(snapshot, [], { configFingerprint: "changed" }),
      ),
    /prepare/i,
  );
  const newer = reconcileDraft(
    checked,
    incoming(snapshot, [], { requestSequence: 5 }),
  );
  assert.deepEqual(
    reconcileDraft(
      newer,
      incoming(snapshot, [pick(1, ids[2])], { requestSequence: 4 }),
    ),
    newer,
  );
});

test("an ownership change at the same pick is held for exact review", () => {
  const { snapshot, state, ids } = setup();
  const initial = reconcileDraft(state, incoming(snapshot, [pick(1, ids[0])]));
  const changed = incoming(snapshot, [pick(1, ids[0])]);
  changed.picks[0].rosterId = "1";
  const held = reconcileDraft(initial, changed);
  assert.equal(held.accepted.picks[0].rosterId, "5");
  assert.equal(held.pending.diff.changes[0].after.rosterId, "1");
  assert.equal(held.revision, initial.revision);
});

test("unknown opponent remains unavailable; unknown own identity disables personalized advice but keeps browsing", () => {
  const { snapshot, state, ids } = setup();
  const opponent = reconcileDraft(
    state,
    incoming(snapshot, [pick(1, ids[0]), pick(2, "unknown-opponent")]),
  );
  assert.ok(
    deriveEffectiveDraft(opponent, snapshot.config).unavailableIds.includes(
      "unknown-opponent",
    ),
  );
  assert.equal(
    recommend(snapshot, deriveEffectiveDraft(opponent, snapshot.config))
      .candidates.length,
    3,
  );
  const own = reconcileDraft(
    state,
    incoming(snapshot, [pick(1, "unknown-own")]),
  );
  const result = recommend(
    snapshot,
    deriveEffectiveDraft(own, snapshot.config),
  );
  assert.equal(result.status, "unknown-own-player");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.players.length, 400);
});
