import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { context, pool } from "../fixtures/sleeper.mjs";
import {
  normalizeContext,
  configFingerprint,
} from "../../src/sleeper/client.mjs";
import { normalizePlayers, validateCoverage } from "../../src/data/sources.mjs";
import { upstream } from "./upstream.mjs";

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function fakeClock(start = Date.parse("2026-09-08T18:00:00Z")) {
  let time = start,
    next = 0;
  const tasks = new Map();
  return {
    now: () => new Date(time),
    milliseconds: () => time,
    setTimeout(fn, delay) {
      const id = ++next;
      tasks.set(id, { at: time + delay, fn });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    tick(ms) {
      const target = time + ms;
      for (;;) {
        const due = [...tasks]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        time = due[1].at;
        tasks.delete(due[0]);
        due[1].fn();
      }
      time = target;
    },
    count: () => tasks.size,
  };
}
export function fixtureSnapshot() {
  const raw = pool(),
    config = normalizeContext(context());
  const playersById = normalizePlayers(
    raw.players,
    raw.projections,
    raw.history,
    "2026",
  );
  return {
    version: 1,
    snapshotId: "fictional-runtime",
    preparedAt: "2026-09-08T18:00:00Z",
    leagueName: "Fictional Draft",
    config,
    configFingerprint: configFingerprint(config),
    playersById,
    rankingMode: "adp-only",
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
    importReport: {
      coverage: validateCoverage(playersById),
      warnings: [],
      quarantine: [],
    },
  };
}
export async function runtimeFiles(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "session-runtime-"));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.toReversed()) await cleanup();
    await rm(dir, { recursive: true, force: true });
  });
  const snapshot = fixtureSnapshot();
  await writeFile(path.join(dir, "snapshot.json"), JSON.stringify(snapshot));
  return {
    dir,
    cleanup: (fn) => cleanups.push(fn),
    snapshot,
    sessionDir: path.join(dir, "drafts", snapshot.config.draftId),
    sessionFile: path.join(
      dir,
      "drafts",
      snapshot.config.draftId,
      "session.json",
    ),
  };
}
export async function runtime(t) {
  const u = await upstream(t),
    files = await runtimeFiles(t),
    clock = fakeClock();
  u.routes[`/v1/user/${files.snapshot.config.userId}`] = u.c.user;
  return {
    ...u,
    ...files,
    clock,
    sessionOptions: {
      dataDir: files.dir,
      baseUrl: u.options.baseUrl,
      now: clock.now,
      scheduler: clock,
    },
  };
}
export function unitUpstream(snapshot, clock) {
  let calls = 0;
  const waiting = [];
  let value = {
    draftId: snapshot.config.draftId,
    configFingerprint: snapshot.configFingerprint,
    status: "pre_draft",
    picks: [],
  };
  return {
    calls: () => calls,
    waitForCalls(count) {
      if (calls >= count) return Promise.resolve();
      return new Promise((resolve) => waiting.push({ count, resolve }));
    },
    set(next) {
      value = next;
    },
    options: {
      readContext: async () => ({
        config: snapshot.config,
        configFingerprint: snapshot.configFingerprint,
      }),
      readDraft: async (_config, options) => {
        calls++;
        for (const waiter of waiting)
          if (calls >= waiter.count) waiter.resolve();
        if (typeof value === "function") {
          return new Promise((resolve, reject) => {
            const aborted = () => reject(options.signal.reason);
            options.signal.addEventListener("abort", aborted, { once: true });
            Promise.resolve(value(options))
              .then(resolve, reject)
              .finally(() =>
                options.signal.removeEventListener("abort", aborted),
              );
          });
        }
        if (value instanceof Error) throw value;
        return { ...value, fetchedAt: clock.now().toISOString() };
      },
    },
  };
}
