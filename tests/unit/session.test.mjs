import test from "node:test";
import assert from "node:assert/strict";
import { openSession } from "../../src/session.mjs";
import {
  runtimeFiles,
  fakeClock,
  unitUpstream,
  deferred,
} from "../helpers/runtime.mjs";
async function setup(t) {
  const files = await runtimeFiles(t),
    clock = fakeClock(),
    provider = unitUpstream(files.snapshot, clock);
  const session = await openSession({
    dataDir: files.dir,
    now: clock.now,
    scheduler: clock,
    ...provider.options,
  });
  files.cleanup(() => session.close());
  return { ...files, clock, provider, session };
}
test("startup/manual callers coalesce; successful empty is known and metadata-only checks advance only view revision", async (t) => {
  const files = await runtimeFiles(t),
    clock = fakeClock(),
    provider = unitUpstream(files.snapshot, clock),
    gate = deferred();
  provider.set(() => gate.promise);
  const s = await openSession({
    dataDir: files.dir,
    now: clock.now,
    scheduler: clock,
    ...provider.options,
  });
  files.cleanup(() => s.close());
  assert.equal(s.getBoard().availabilityKnown, false);
  const a = s.refresh(),
    b = s.refresh();
  assert.equal(a, b);
  await provider.waitForCalls(1);
  assert.equal(provider.calls(), 1);
  gate.resolve({
    draftId: files.snapshot.config.draftId,
    configFingerprint: files.snapshot.configFingerprint,
    status: "pre_draft",
    picks: [],
    fetchedAt: clock.now().toISOString(),
  });
  await a;
  const first = s.getBoard();
  assert.equal(first.availabilityKnown, true);
  assert.equal(first.candidates.length, 3);
  assert.equal(first.revision, 1);
  provider.set({
    draftId: files.snapshot.config.draftId,
    configFingerprint: files.snapshot.configFingerprint,
    status: "pre_draft",
    picks: [],
  });
  clock.tick(4999);
  assert.equal(provider.calls(), 1);
  clock.tick(1);
  await s.refresh();
  const second = s.getBoard();
  assert.equal(provider.calls(), 2);
  assert.equal(second.revision, first.revision);
  assert.ok(second.viewRevision > first.viewRevision);
  const result = await s.act({
    expectedRevision: second.revision,
    action: { type: "taken", playerId: "10001" },
  });
  assert.equal(result.revision, second.revision + 1);
  assert.ok(result.viewRevision > second.viewRevision);
});
test("failure backoff10/20/40/60/60, Retry-After and success reset cannot be bypassed manually", async (t) => {
  const { session: s, provider, clock, snapshot } = await setup(t);
  await s.refresh();
  let previous = s.getBoard();
  for (const delay of [10000, 20000, 40000, 60000, 60000]) {
    provider.set(new Error("offline"));
    await s.refresh();
    const board = s.getBoard();
    assert.equal(board.connection.status, "error");
    assert.equal(
      Date.parse(board.connection.retryAt) - clock.milliseconds(),
      delay,
    );
    assert.equal(board.revision, previous.revision);
    assert.ok(board.viewRevision > previous.viewRevision);
    const calls = provider.calls();
    clock.tick(delay - 1);
    await s.refresh();
    assert.equal(provider.calls(), calls);
    clock.tick(1);
    previous = board;
  }
  const error = new Error("limited");
  error.status = 429;
  error.retryAfter = "90";
  provider.set(error);
  await s.refresh();
  assert.equal(
    Date.parse(s.getBoard().connection.retryAt) - clock.milliseconds(),
    90000,
  );
  clock.tick(90000);
  provider.set({
    draftId: snapshot.config.draftId,
    configFingerprint: snapshot.configFingerprint,
    status: "pre_draft",
    picks: [],
  });
  await s.refresh();
  assert.equal(s.getBoard().connection.status, "checked");
  assert.equal(
    Date.parse(s.getBoard().connection.retryAt) - clock.milliseconds(),
    5000,
  );
});
test("exact4s timeout is immediate; healthy complete uses30s and reopen resets cadence", async (t) => {
  const { session: s, provider, clock, snapshot } = await setup(t);
  await s.refresh();
  let gate = deferred();
  provider.set(() => gate.promise);
  const pending = s.refresh();
  await provider.waitForCalls(2);
  clock.tick(3999);
  assert.notEqual(s.getBoard().connection.status, "error");
  clock.tick(1);
  await pending;
  assert.equal(s.getBoard().connection.error.code, "upstream-timeout");
  assert.equal(s.getBoard().revision, 1);
  clock.tick(10000);
  provider.set({
    draftId: snapshot.config.draftId,
    configFingerprint: snapshot.configFingerprint,
    status: "complete",
    picks: [],
  });
  gate.resolve({
    draftId: snapshot.config.draftId,
    configFingerprint: snapshot.configFingerprint,
    status: "pre_draft",
    picks: [],
    fetchedAt: clock.now().toISOString(),
  });
  await s.refresh();
  assert.equal(
    Date.parse(s.getBoard().connection.retryAt) - clock.milliseconds(),
    30000,
  );
  clock.tick(30000);
  await s.refresh();
  assert.equal(s.getBoard().connection.overdue, false);
  provider.set({
    draftId: snapshot.config.draftId,
    configFingerprint: snapshot.configFingerprint,
    status: "drafting",
    picks: [],
  });
  await s.refresh();
  assert.equal(
    Date.parse(s.getBoard().connection.retryAt) - clock.milliseconds(),
    5000,
  );
});
test("pure clock boundaries and restart stale flags are independent of upstream unchanged success", async (t) => {
  const { connectionHealth } = await import("../../src/session.mjs");
  const at = Date.parse("2026-09-08T18:00:00Z");
  for (const status of ["pre_draft", "drafting"]) {
    assert.equal(
      connectionHealth(
        { status, lastCheckedAt: new Date(at).toISOString(), openedAt: at },
        at + 14999,
      ).overdue,
      false,
    );
    assert.equal(
      connectionHealth(
        { status, lastCheckedAt: new Date(at).toISOString(), openedAt: at },
        at + 15000,
      ).overdue,
      true,
    );
  }
  assert.equal(
    connectionHealth(
      { status: "complete", lastCheckedAt: new Date(at).toISOString() },
      at + 39999,
    ).overdue,
    false,
  );
  assert.equal(
    connectionHealth(
      { status: "complete", lastCheckedAt: new Date(at).toISOString() },
      at + 40000,
    ).overdue,
    true,
  );
  assert.equal(
    connectionHealth(
      {
        status: "complete",
        lastCheckedAt: new Date(at).toISOString(),
        error: { code: "offline", message: "offline" },
      },
      at,
    ).status,
    "error",
  );
  assert.equal(
    connectionHealth(
      {
        status: "pre_draft",
        lastCheckedAt: new Date(at).toISOString(),
        restored: true,
      },
      at,
    ).status,
    "stale",
  );
});
test("PID EPERM is not proof of death; only ESRCH permits stale recovery", async () => {
  const { pidIsDead } = await import("../../src/session.mjs");
  assert.equal(
    pidIsDead(123, () => {}),
    false,
  );
  assert.equal(
    pidIsDead(123, () => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    }),
    false,
  );
  assert.equal(
    pidIsDead(123, () => {
      throw Object.assign(new Error("absent"), { code: "ESRCH" });
    }),
    true,
  );
});
test("a saved local action preserves an outstanding upstream failure until a successful check; HTTP-date Retry-After is honored", async (t) => {
  const { session: s, provider, clock } = await setup(t);
  await s.refresh();
  const before = s.getBoard();
  const failure = new Error("upstream");
  failure.retryAfter = new Date(clock.milliseconds() + 120000).toUTCString();
  provider.set(failure);
  await s.refresh();
  assert.equal(
    Date.parse(s.getBoard().connection.retryAt) - clock.milliseconds(),
    120000,
  );
  const acted = await s.act({
    expectedRevision: before.revision,
    action: { type: "taken", playerId: "10001" },
  });
  assert.equal(acted.connection.status, "error");
  assert.equal(acted.connection.error.code, "upstream-failed");
  assert.equal(acted.lastCheckedAt, before.lastCheckedAt);
});
test("failed poll and both context groups cancel companions while preserving original Retry-After", async (t) => {
  const { context } = await import("../fixtures/sleeper.mjs");
  for (const phase of ["poll", "context-initial", "context-details"]) {
    await t.test(phase, async (child) => {
      const files = await runtimeFiles(child),
        clock = fakeClock(),
        c = context();
      let aborted = false;
      child.mock.method(globalThis, "fetch", async (url, { signal }) => {
        url = String(url);
        const held =
          phase === "poll"
            ? url.endsWith("/picks")
            : phase === "context-initial"
              ? url.includes("/user/")
              : url.endsWith("/rosters");
        if (held)
          return new Promise((resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        const failing =
          phase === "poll"
            ? url.includes("/draft/")
            : phase === "context-initial"
              ? url.includes("/league/")
              : url.includes("/draft/") && !url.endsWith("/traded_picks");
        if (failing)
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "90" },
          });
        return new Response(
          JSON.stringify(
            url.includes("/user/")
              ? c.user
              : url.includes("/league/")
                ? c.league
                : [],
          ),
        );
      });
      const s = await openSession({
        dataDir: files.dir,
        now: clock.now,
        scheduler: clock,
        ...(phase === "poll"
          ? {
              readContext: async () => ({
                config: files.snapshot.config,
                configFingerprint: files.snapshot.configFingerprint,
              }),
            }
          : {}),
      });
      files.cleanup(() => s.close());
      await s.refresh();
      assert.equal(aborted, true);
      assert.equal(
        Date.parse(s.getBoard().connection.retryAt) - clock.milliseconds(),
        90000,
      );
      assert.equal(s.getBoard().connection.error.code, "upstream-failed");
      await s.close();
      assert.equal(clock.count(), 0);
    });
  }
});
test("typed unsupported-context failures disable advice and actions; ordinary upstream failure retains advice", async (t) => {
  const { context } = await import("../fixtures/sleeper.mjs");
  const { normalizeContext, configFingerprint } = await import(
    "../../src/sleeper/client.mjs"
  );
  for (const change of [
    (c) => c.tradedPicks.push({ round: 1 }),
    (c) => (c.draft.slot_to_roster_id["1"] = 1),
  ]) {
    const files = await runtimeFiles(t),
      clock = fakeClock(),
      provider = unitUpstream(files.snapshot, clock),
      c = context();
    const s = await openSession({
      dataDir: files.dir,
      now: clock.now,
      scheduler: clock,
      ...provider.options,
      readContext: async () => {
        const config = normalizeContext(c);
        return { config, configFingerprint: configFingerprint(config) };
      },
    });
    files.cleanup(() => s.close());
    await s.refresh();
    const before = s.getBoard();
    change(c);
    await s.refresh({ context: true });
    assert.equal(s.getBoard().status, "prepare-required");
    assert.equal(s.getBoard().candidates.length, 0);
    assert.equal(s.getBoard().revision, before.revision);
    assert.ok(s.getBoard().players.length >= 400);
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
