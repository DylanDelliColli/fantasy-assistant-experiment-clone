import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { openSession } from "../../src/session.mjs";
import { runtime, deferred } from "../helpers/runtime.mjs";
import { pick } from "../fixtures/sleeper.mjs";
test("real HTTP saved Undo gap restores exact corrections and accepts the gap before official confirmation once", async (t) => {
  const r = await runtime(t);
  const picksPath = `/v1/draft/${r.snapshot.config.draftId}/picks`;
  r.routes[picksPath] = [pick(1, "10001")];
  let s = await openSession(r.sessionOptions);
  r.cleanup(() => s.close());
  await s.refresh();
  for (const [pickNo, playerId] of [
    [28, "10015"],
    [29, "10100"],
  ]) {
    await s.act({
      expectedRevision: s.getBoard().revision,
      action: { type: "my-pick", pickNo, playerId },
    });
  }
  await s.act({
    expectedRevision: s.getBoard().revision,
    action: { type: "undo", correctionId: s.getBoard().corrections[0].id },
  });
  const before = s.getBoard();
  await s.close();
  s = await openSession(r.sessionOptions);
  const restored = s.getBoard();
  assert.equal(restored.connection.status, "stale");
  assert.equal(restored.revision, before.revision);
  assert.deepEqual(restored.corrections, before.corrections);
  assert.deepEqual(restored.nextPicks, [28, 56]);
  await s.refresh();
  await s.act({
    expectedRevision: s.getBoard().revision,
    action: { type: "my-pick", pickNo: 28, playerId: "10016" },
  });
  const refilled = s.getBoard();
  await s.close();
  s = await openSession(r.sessionOptions);
  assert.deepEqual(s.getBoard().corrections, refilled.corrections);
  assert.deepEqual(s.getBoard().nextPicks, [56, 57]);
  await s.refresh();
  const filler = Object.keys(r.snapshot.playersById).filter(
    (id) => !["10001", "10016", "10100"].includes(id),
  );
  r.routes[picksPath] = [
    pick(1, "10001"),
    ...filler.slice(0, 26).map((id, i) => pick(i + 2, id)),
    pick(28, "10016"),
    pick(29, "10100"),
  ];
  await s.refresh();
  assert.deepEqual(s.getBoard().corrections, []);
  assert.deepEqual(s.getBoard().nextPicks, [56, 57]);
  assert.equal(
    s.getBoard().ownRecords.filter((p) => p.playerId === "10100").length,
    1,
  );
});
test("saved corrections still reject unknown or duplicate players, invalid own slots and occupied official picks without rewriting", async (t) => {
  for (const corrupt of [
    (saved) => (saved.corrections[0].playerId = "missing"),
    (saved) => (saved.corrections[1].playerId = saved.corrections[0].playerId),
    (saved) => (saved.corrections[1].pickNo = 28),
    (saved) => (saved.corrections[0].pickNo = 2),
    (saved) => (saved.corrections[0].pickNo = 1),
    (saved) => (saved.corrections[0].playerId = "10001"),
    (saved) => (saved.corrections[0].type = "invalid"),
    (saved) => (saved.corrections[0].playerId = 10015),
  ]) {
    const r = await runtime(t);
    r.routes[`/v1/draft/${r.snapshot.config.draftId}/picks`] = [
      pick(1, "10001"),
    ];
    let s = await openSession(r.sessionOptions);
    r.cleanup(() => s.close());
    await s.refresh();
    for (const [pickNo, playerId] of [
      [28, "10015"],
      [29, "10100"],
    ])
      await s.act({
        expectedRevision: s.getBoard().revision,
        action: { type: "my-pick", pickNo, playerId },
      });
    await s.close();
    const saved = JSON.parse(await readFile(r.sessionFile, "utf8"));
    corrupt(saved);
    const bytes = JSON.stringify(saved);
    await writeFile(r.sessionFile, bytes);
    s = await openSession(r.sessionOptions);
    await s.refresh();
    assert.equal(s.getBoard().connection.error.code, "state-recovery");
    assert.equal(await readFile(r.sessionFile, "utf8"), bytes);
    await s.close();
  }
});
test("save/close/restart restores revision and corrections stale with new sessionId; official confirmation retires once", async (t) => {
  const r = await runtime(t);
  let s = await openSession(r.sessionOptions);
  r.cleanup(() => s.close());
  await s.refresh();
  await s.act({
    expectedRevision: s.getBoard().revision,
    action: { type: "my-pick", playerId: "10001", pickNo: 1 },
  });
  const before = s.getBoard(),
    disk = JSON.parse(await readFile(r.sessionFile, "utf8"));
  assert.equal(disk.config, undefined);
  assert.equal(disk.playersById, undefined);
  assert.equal(disk.sessionId, undefined);
  await s.close();
  const gate = deferred();
  r.routes[`/v1/draft/${r.snapshot.config.draftId}/picks`] = async () => {
    await gate.promise;
    return [pick(1, "10001")];
  };
  s = await openSession(r.sessionOptions);
  const restored = s.getBoard();
  assert.equal(restored.revision, before.revision);
  assert.notEqual(restored.sessionId, before.sessionId);
  assert.equal(restored.connection.status, "stale");
  assert.equal(restored.availabilityKnown, true);
  assert.equal(restored.corrections.length, 1);
  gate.resolve();
  await s.refresh();
  assert.equal(s.getBoard().corrections.length, 0);
  assert.equal(
    s.getBoard().ownRecords.filter((p) => p.playerId === "10001").length,
    1,
  );
});
test("a real second process cannot acquire ownership; stale dead PID lock recovers and live ownership remains", async (t) => {
  const r = await runtime(t),
    s = await openSession(r.sessionOptions);
  r.cleanup(() => s.close());
  await s.refresh();
  const before = await readFile(r.sessionFile);
  const script = `import {openSession} from './src/session.mjs';try{await openSession({dataDir:${JSON.stringify(r.dir)}});process.exitCode=8;}catch(e){console.log(e.code);process.exitCode=e.code==='session-locked'?0:9;}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.match(out, /session-locked/);
  assert.deepEqual(await readFile(r.sessionFile), before);
  await s.close();
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(dead, "exit");
  await mkdir(path.join(r.sessionDir, "session.lock"), { recursive: true });
  await writeFile(
    path.join(r.sessionDir, "session.lock", "999.json"),
    JSON.stringify({ pid: dead.pid, token: "dead-owner", generation: 999 }),
  );
  const recovered = await openSession(r.sessionOptions);
  await recovered.close();
});
test("corrupt JSON/wrong schema/config preserve bytes; recovery blocks writes without losing browsing", async (t) => {
  for (const text of [
    "{broken",
    JSON.stringify({ version: 99 }),
    JSON.stringify({
      version: 1,
      configFingerprint: "foreign",
      revision: 1,
      accepted: null,
      corrections: [],
    }),
  ]) {
    const r = await runtime(t);
    await mkdir(r.sessionDir, { recursive: true });
    await writeFile(r.sessionFile, text);
    const s = await openSession(r.sessionOptions);
    r.cleanup(() => s.close());
    await s.refresh();
    assert.ok(s.getBoard().players.length >= 400);
    assert.equal(s.getBoard().connection.error.code, "state-recovery");
    await assert.rejects(
      s.act({
        expectedRevision: s.getBoard().revision,
        action: { type: "taken", playerId: "10001" },
      }),
      (e) => e.code === "state-recovery",
    );
    assert.equal(await readFile(r.sessionFile, "utf8"), text);
    await s.close();
  }
});
test("real rename conflict rejects action and retains prior durable board; deferred persistence serializes arriving poll", async (t) => {
  const r = await runtime(t),
    gate = deferred(),
    entered = deferred();
  let block = false;
  const s = await openSession({
    ...r.sessionOptions,
    beforePersist: async () => {
      if (block) {
        entered.resolve();
        await gate.promise;
      }
    },
  });
  r.cleanup(() => s.close());
  await s.refresh();
  const before = s.getBoard(),
    saved = await readFile(r.sessionFile);
  await rename(r.sessionFile, r.sessionFile + ".saved");
  await mkdir(r.sessionFile);
  await writeFile(path.join(r.sessionFile, "existing"), "kept");
  await assert.rejects(
    s.act({
      expectedRevision: before.revision,
      action: { type: "taken", playerId: "10001" },
    }),
    (e) => e.code === "persistence-failed",
  );
  assert.equal(s.getBoard().revision, before.revision);
  assert.equal(s.getBoard().corrections.length, 0);
  assert.deepEqual(await readFile(r.sessionFile + ".saved"), saved);
  await rm(r.sessionFile, { recursive: true });
  await rename(r.sessionFile + ".saved", r.sessionFile);
  const response = deferred(),
    arrived = deferred();
  r.routes[`/v1/draft/${r.snapshot.config.draftId}/picks`] = async () => {
    arrived.resolve();
    await response.promise;
    return [pick(1, "10002")];
  };
  const poll = s.refresh();
  await arrived.promise;
  block = true;
  const action = s.act({
    expectedRevision: before.revision,
    action: { type: "taken", playerId: "10001" },
  });
  await entered.promise;
  response.resolve();
  assert.equal(s.getBoard().revision, before.revision);
  gate.resolve();
  await action;
  await poll;
  assert.equal(s.getBoard().corrections.length, 1);
  assert.equal(s.getBoard().draft.observedCount, 0);
  assert.equal(
    JSON.parse(await readFile(r.sessionFile, "utf8")).revision,
    before.revision + 1,
  );
});
test("two real simultaneous stale-lock reclaimers cannot remove the winner or both enter", async (t) => {
  const r = await runtime(t);
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(dead, "exit");
  await mkdir(path.join(r.sessionDir, "session.lock"), { recursive: true });
  await writeFile(
    path.join(r.sessionDir, "session.lock", "0.json"),
    JSON.stringify({ pid: dead.pid, token: "stale", generation: 0 }),
  );
  const script = `import {openSession} from './src/session.mjs';try{const s=await openSession({dataDir:${JSON.stringify(r.dir)},baseUrl:${JSON.stringify(r.options.baseUrl)}});console.log('owned');process.stdin.once('data',async()=>{await s.close();process.exit(0);});process.stdin.resume();}catch(e){console.log(e.code);process.exit(e.code==='session-locked'?0:9);}`;
  const children = [0, 1].map(() =>
    spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  t.after(() => {
    for (const c of children) if (c.exitCode === null) c.kill();
  });
  const signals = await Promise.all(
    children.map(
      (c) =>
        new Promise((resolve) =>
          c.stdout.once("data", (b) => resolve(b.toString().trim())),
        ),
    ),
  );
  assert.deepEqual(signals.toSorted(), ["owned", "session-locked"]);
  const winner = children[signals.indexOf("owned")];
  await assert.rejects(
    openSession(r.sessionOptions),
    (e) => e.code === "session-locked",
  );
  winner.stdin.end("close");
  await once(winner, "exit");
});
test("future correction IDs and invalid saved pick fields preserve the corrupt file instead of restoring actions", async (t) => {
  for (const corrupt of [
    (saved) => (saved.corrections[0].id = "local-999999"),
    (saved) =>
      (saved.accepted.picks = [
        {
          pickNo: 2,
          round: 1,
          slot: 2,
          rosterId: "1",
          playerId: "10002",
          pickedBy: null,
        },
      ]),
  ]) {
    const r = await runtime(t);
    let s = await openSession(r.sessionOptions);
    r.cleanup(() => s.close());
    await s.refresh();
    await s.act({
      expectedRevision: s.getBoard().revision,
      action: { type: "taken", playerId: "10001" },
    });
    await s.close();
    const saved = JSON.parse(await readFile(r.sessionFile, "utf8"));
    corrupt(saved);
    const bytes = JSON.stringify(saved);
    await writeFile(r.sessionFile, bytes);
    s = await openSession(r.sessionOptions);
    await s.refresh();
    assert.equal(s.getBoard().connection.error.code, "state-recovery");
    assert.equal(await readFile(r.sessionFile, "utf8"), bytes);
    await s.close();
  }
});
