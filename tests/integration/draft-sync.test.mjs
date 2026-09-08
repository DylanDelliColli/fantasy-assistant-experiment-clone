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

test("real HTTP malformed and long Retry-After retain the board and honor a safely scheduled deadline", async (t) => {
  const { runtime } = await import("../helpers/runtime.mjs");
  const { openSession } = await import("../../src/session.mjs");
  const r = await runtime(t),
    armed = [];
  const scheduler = {
    ...r.clock,
    setTimeout(fn, delay) {
      armed.push(delay);
      return r.clock.setTimeout(fn, delay);
    },
  };
  const s = await openSession({ ...r.sessionOptions, scheduler });
  r.cleanup(() => s.close());
  await s.refresh();
  const before = s.getBoard(),
    route = `/v1/draft/${r.snapshot.config.draftId}/picks`;
  r.routes[route] = Object.assign(new Error("limited"), {
    status: 429,
    retryAfter: "999999999999999",
  });
  await s.refresh();
  assert.equal(s.getBoard().revision, before.revision);
  assert.deepEqual(s.getBoard().candidates, before.candidates);
  assert.equal(
    Date.parse(s.getBoard().connection.retryAt) - r.clock.milliseconds(),
    10000,
  );
  r.routes[route] = [];
  r.clock.tick(10000);
  await s.refresh();
  const delay = 30 * 24 * 60 * 60 * 1000,
    max = 2147483647;
  r.routes[route] = Object.assign(new Error("limited"), {
    status: 429,
    retryAfter: String(delay / 1000),
  });
  await s.refresh();
  assert.equal(
    Date.parse(s.getBoard().connection.retryAt) - r.clock.milliseconds(),
    delay,
  );
  assert.ok(
    armed.every((ms) => ms <= max),
    "timer delay exceeds Node native timer limit",
  );
  const count = r.log.filter((x) => x.url === route).length;
  r.clock.tick(max);
  await s.refresh();
  assert.equal(r.log.filter((x) => x.url === route).length, count);
  r.clock.tick(delay - max - 1);
  await s.refresh();
  assert.equal(r.log.filter((x) => x.url === route).length, count);
  r.routes[route] = [];
  r.clock.tick(1);
  assert.equal(s.getBoard().connection.inFlight, true);
  await s.refresh();
  assert.equal(r.log.filter((x) => x.url === route).length, count + 1);
  assert.equal(s.getBoard().connection.status, "checked");
});

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

test("real session retains availability through500/429/malformed/gaps and adopts only reviewed pending token", async (t) => {
  const { runtime, deferred } = await import("../helpers/runtime.mjs");
  const { openSession } = await import("../../src/session.mjs");
  const r = await runtime(t),
    picksPath = `/v1/draft/${r.snapshot.config.draftId}/picks`;
  r.routes[picksPath] = new Error("offline");
  const s = await openSession(r.sessionOptions);
  r.cleanup(() => s.close());
  await s.refresh();
  assert.equal(s.getBoard().availabilityKnown, false);
  r.clock.tick(10000);
  r.routes[picksPath] = [];
  await s.refresh();
  assert.equal(s.getBoard().availabilityKnown, true);
  assert.equal(s.getBoard().candidates.length, 3);
  r.routes[picksPath] = [pick(1, "10001")];
  await s.refresh();
  const revision = s.getBoard().revision;
  for (const value of [
    Object.assign(new Error("error"), { status: 500 }),
    Object.assign(new Error("limited"), { status: 429, retryAfter: "60" }),
    "{bad",
    [pick(2, "10002")],
  ]) {
    r.routes[picksPath] = value;
    await s.refresh();
    assert.equal(s.getBoard().draft.observedCount, 1);
    assert.equal(s.getBoard().revision, revision);
    assert.equal(s.getBoard().connection.status, "error");
    r.clock.tick(
      Date.parse(s.getBoard().connection.retryAt) - r.clock.milliseconds(),
    );
  }
  r.routes[picksPath] = [];
  await s.refresh();
  assert.equal(s.getBoard().draft.observedCount, 1);
  const token = s.getBoard().pending.revision;
  await assert.rejects(
    s.act({
      expectedRevision: s.getBoard().revision,
      action: { type: "accept-pending", pendingRevision: "old" },
    }),
  );
  await s.act({
    expectedRevision: s.getBoard().revision,
    action: { type: "accept-pending", pendingRevision: token },
  });
  assert.equal(s.getBoard().draft.observedCount, 0);
  assert.ok(r.log.every((x) => x.method === "GET"));
});

test("real session healthy completed30s checks, hanging4s deadline, and observed reopen restore active cadence", async (t) => {
  const { runtime, deferred } = await import("../helpers/runtime.mjs");
  const { openSession } = await import("../../src/session.mjs");
  const r = await runtime(t);
  r.c.draft.status = "complete";
  const s = await openSession(r.sessionOptions);
  r.cleanup(() => s.close());
  await s.refresh();
  r.clock.tick(30000);
  await s.refresh();
  assert.equal(s.getBoard().connection.overdue, false);
  assert.equal(
    Date.parse(s.getBoard().connection.retryAt) - r.clock.milliseconds(),
    30000,
  );
  r.c.draft.status = "drafting";
  await s.refresh();
  assert.equal(
    Date.parse(s.getBoard().connection.retryAt) - r.clock.milliseconds(),
    5000,
  );
  const gate = deferred(),
    entered = deferred();
  r.routes[`/v1/draft/${r.snapshot.config.draftId}/picks`] = async () => {
    entered.resolve();
    await gate.promise;
    return [];
  };
  const pending = s.refresh();
  await entered.promise;
  r.clock.tick(3999);
  assert.notEqual(s.getBoard().connection.status, "error");
  r.clock.tick(1);
  await pending;
  assert.equal(s.getBoard().connection.error.code, "upstream-timeout");
  gate.resolve();
});
test("close aborts and settles real held HTTP requests without advancing fake time", async (t) => {
  const { runtime, deferred } = await import("../helpers/runtime.mjs");
  const { openSession } = await import("../../src/session.mjs");
  const r = await runtime(t),
    entered = deferred(),
    aborted = deferred(),
    gate = deferred();
  r.routes[`/v1/draft/${r.snapshot.config.draftId}/picks`] = async (req) => {
    req.once("close", () => aborted.resolve());
    entered.resolve();
    await gate.promise;
    return [];
  };
  const s = await openSession(r.sessionOptions);
  const pending = s.refresh();
  await entered.promise;
  await s.close();
  await pending;
  await aborted.promise;
  assert.equal(r.clock.count(), 0);
  gate.resolve();
});
test("session retains accepted picks and disables advice when polled season_type drifts", async (t) => {
  const { runtime } = await import("../helpers/runtime.mjs");
  const { openSession } = await import("../../src/session.mjs");
  const r = await runtime(t);
  r.routes[`/v1/draft/${r.snapshot.config.draftId}/picks`] = [pick(1, "10001")];
  const s = await openSession(r.sessionOptions);
  r.cleanup(() => s.close());
  await s.refresh();
  const before = s.getBoard();
  r.c.draft.season_type = "post";
  await s.refresh();
  assert.equal(s.getBoard().status, "prepare-required");
  assert.equal(s.getBoard().draft.observedCount, 1);
  assert.equal(s.getBoard().revision, before.revision);
  assert.equal(s.getBoard().candidates.length, 0);
});
test("explicit context recheck and startup drift retain saved board and require prepare", async (t) => {
  const { runtime } = await import("../helpers/runtime.mjs");
  const { openSession } = await import("../../src/session.mjs");
  const { readFile } = await import("node:fs/promises");
  const r = await runtime(t);
  let s = await openSession(r.sessionOptions);
  r.cleanup(() => s.close());
  await s.refresh();
  const before = s.getBoard(),
    bytes = await readFile(r.sessionFile);
  r.c.league.scoring_settings.sack = 2;
  await s.refresh({ context: true });
  assert.equal(s.getBoard().status, "prepare-required");
  assert.equal(s.getBoard().availabilityKnown, true);
  assert.equal(s.getBoard().revision, before.revision);
  assert.equal(s.getBoard().candidates.length, 0);
  assert.ok(s.getBoard().players.length >= 400);
  assert.deepEqual(await readFile(r.sessionFile), bytes);
  await s.close();
  s = await openSession(r.sessionOptions);
  assert.equal(s.getBoard().connection.status, "stale");
  await s.refresh();
  assert.equal(s.getBoard().status, "prepare-required");
  assert.deepEqual(await readFile(r.sessionFile), bytes);
});

test("HTTP failure aborts a held companion request before refresh settles", async (t) => {
  const { runtime, deferred } = await import("../helpers/runtime.mjs");
  const { openSession } = await import("../../src/session.mjs");
  const r = await runtime(t),
    entered = deferred(),
    closed = deferred(),
    gate = deferred();
  const s = await openSession({ ...r.sessionOptions, timeoutMs: 60000 });
  r.cleanup(() => s.close());
  await s.refresh();
  const draftPath = `/v1/draft/${r.snapshot.config.draftId}`;
  r.routes[draftPath] = async () => {
    await entered.promise;
    return Object.assign(new Error("failed"), { status: 500 });
  };
  r.routes[draftPath + "/picks"] = async (req) => {
    req.once("close", () => closed.resolve());
    entered.resolve();
    await gate.promise;
    return [];
  };
  await s.refresh();
  await closed.promise;
  assert.equal(s.getBoard().connection.status, "error");
  gate.resolve();
});
test("failed context429 cancels held user HTTP and preserves server retry deadline", async (t) => {
  const { runtime, deferred } = await import("../helpers/runtime.mjs");
  const { openSession } = await import("../../src/session.mjs");
  const r = await runtime(t),
    entered = deferred(),
    closed = deferred(),
    gate = deferred();
  r.routes[`/v1/user/${r.snapshot.config.userId}`] = async (req) => {
    req.once("close", () => closed.resolve());
    entered.resolve();
    await gate.promise;
    return r.c.user;
  };
  r.routes[`/v1/league/${r.snapshot.config.leagueId}`] = async () => {
    await entered.promise;
    return Object.assign(new Error("limited"), {
      status: 429,
      retryAfter: "120",
    });
  };
  const s = await openSession({ ...r.sessionOptions, timeoutMs: 60000 });
  r.cleanup(() => s.close());
  await s.refresh();
  await closed.promise;
  assert.equal(
    Date.parse(s.getBoard().connection.retryAt) - r.clock.milliseconds(),
    120000,
  );
  assert.equal(s.getBoard().availabilityKnown, false);
  await s.close();
  assert.equal(r.clock.count(), 0);
  gate.resolve();
});
test("unsupported trades and owner-slot mismatch require prepare while a network outage retains usable advice", async (t) => {
  const { runtime } = await import("../helpers/runtime.mjs");
  const { openSession } = await import("../../src/session.mjs");
  const { readFile } = await import("node:fs/promises");
  for (const change of [
    (c) => c.tradedPicks.push({ round: 1 }),
    (c) => (c.draft.slot_to_roster_id["1"] = 1),
  ]) {
    const r = await runtime(t),
      s = await openSession(r.sessionOptions);
    r.cleanup(() => s.close());
    await s.refresh();
    const before = s.getBoard(),
      bytes = await readFile(r.sessionFile),
      picks = `/v1/draft/${r.snapshot.config.draftId}/picks`;
    r.routes[picks] = new Error("offline");
    await s.refresh();
    assert.equal(s.getBoard().status, "ready");
    assert.equal(s.getBoard().candidates.length, 3);
    r.routes[picks] = [];
    change(r.c);
    r.clock.tick(10000);
    await s.refresh({ context: true });
    assert.equal(s.getBoard().status, "prepare-required");
    assert.equal(s.getBoard().connection.error.code, "prepare-required");
    assert.equal(s.getBoard().revision, before.revision);
    assert.equal(s.getBoard().candidates.length, 0);
    assert.equal(s.getBoard().availabilityKnown, true);
    assert.deepEqual(await readFile(r.sessionFile), bytes);
    await assert.rejects(
      s.act({
        expectedRevision: before.revision,
        action: { type: "taken", playerId: "10001" },
      }),
      (e) => e.code === "prepare-required",
    );
    await s.close();
  }
});
