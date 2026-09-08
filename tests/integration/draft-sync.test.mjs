import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { upstream } from "../helpers/upstream.mjs";
import { pick } from "../fixtures/sleeper.mjs";
import { runPrepare } from "../../scripts/prepare-data.mjs";
import { fetchDraftSnapshot } from "../../src/sleeper/client.mjs";
import {
  createDraftState,
  reconcileDraft,
  applyLocalAction,
  deriveEffectiveDraft,
} from "../../src/draft/state.mjs";
import { recommend } from "../../src/draft/recommend.mjs";

test("real client/domain replay0/1/27/28/29, local28 confirmation, bad feed retention and reviewed rollback", async (t) => {
  const u = await upstream(t);
  const dir = await mkdtemp(path.join(tmpdir(), "draft-sync-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const snapshot = await runPrepare(["--data-dir", dir], u.options);
  let state = createDraftState(snapshot);
  const board = () =>
    recommend(snapshot, deriveEffectiveDraft(state, snapshot.config));
  const draftPath = `/v1/draft/${snapshot.config.draftId}`;
  const picksPath = `${draftPath}/picks`;
  const sync = async () => {
    state = reconcileDraft(
      state,
      await fetchDraftSnapshot(snapshot.config, u.options),
    );
  };
  u.routes[picksPath] = new Error("offline");
  await assert.rejects(sync());
  assert.equal(board().status, "unknown-initial");
  assert.equal(board().candidates.length, 0);
  u.routes[picksPath] = [];
  await sync();
  assert.equal(board().candidates.length, 3);
  assert.deepEqual(board().nextPicks, [1, 28]);
  const own1 = board().candidates[0].id;
  const removed = board().candidates[1].id;
  u.routes[picksPath] = [pick(1, own1)];
  await sync();
  const own28 = board().candidates.find((c) => c.id !== removed).id;
  state = applyLocalAction(state, {
    expectedRevision: state.revision,
    type: "my-pick",
    playerId: own28,
    pickNo: 28,
  });
  assert.deepEqual(board().nextPicks, [29, 56]);
  assert.equal(deriveEffectiveDraft(state, snapshot.config).observedCount, 1);
  const fillers = Object.keys(snapshot.playersById).filter(
    (id) => ![own1, own28, removed].includes(id),
  );
  const rows = Array.from({ length: 27 }, (_, i) =>
    pick(i + 1, i === 0 ? own1 : i === 1 ? removed : fillers[i - 2]),
  );
  u.routes[picksPath] = rows;
  await sync();
  assert.ok(!board().candidates.some((c) => c.id === removed));
  assert.equal(state.corrections.length, 1);
  u.routes[picksPath] = [...rows, pick(28, own28)];
  await sync();
  assert.equal(state.corrections.length, 0);
  assert.equal(
    deriveEffectiveDraft(state, snapshot.config).ownPlayerIds.filter(
      (id) => id === own28,
    ).length,
    1,
  );
  assert.deepEqual(board().nextPicks, [29, 56]);
  const own29 = board().candidates[0].id;
  u.routes[picksPath] = [...u.routes[picksPath], pick(29, own29)];
  await sync();
  assert.deepEqual(board().nextPicks, [56, 57]);
  const saved = structuredClone(state);
  for (const bad of [new Error("upstream failed"), {}, [pick(2, removed)]]) {
    u.routes[picksPath] = bad;
    await assert.rejects(sync());
    assert.deepEqual(state, saved);
  }
  u.routes[picksPath] = rows;
  await sync();
  assert.equal(state.accepted.picks.length, 29);
  assert.equal(state.pending.diff.firstChangedPick, 28);
  assert.throws(() =>
    applyLocalAction(state, {
      expectedRevision: state.revision,
      type: "accept-pending",
      pendingRevision: "old",
    }),
  );
  state = applyLocalAction(state, {
    expectedRevision: state.revision,
    type: "accept-pending",
    pendingRevision: state.pending.revision,
  });
  assert.equal(state.accepted.picks.length, 27);
  assert.deepEqual(board().nextPicks, [28, 29]);
  u.c.draft.status = "complete";
  u.routes[picksPath] = [
    ...rows,
    ...Array.from({ length: 155 }, (_, i) =>
      pick(i + 28, `final-unknown-${i}`),
    ),
  ];
  await sync();
  assert.equal(board().status, "complete");
  assert.deepEqual(board().nextPicks, []);
  assert.deepEqual(board().candidates, []);
  assert.ok(u.log.every((r) => r.method === "GET"));
});
