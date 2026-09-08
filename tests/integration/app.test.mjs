import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { createApp } from "../../src/server.mjs";
import { openSession } from "../../src/session.mjs";
import { runtime, deferred } from "../helpers/runtime.mjs";
async function setup(t) {
  const r = await runtime(t),
    assets = path.join(r.dir, "assets");
  await mkdir(assets);
  for (const name of ["index.html", "app.mjs", "styles.css"])
    await writeFile(
      path.join(assets, name),
      name === "index.html"
        ? "<h1>Harmless test fixture</h1>"
        : "/* fixture */",
    );
  const s = await openSession(r.sessionOptions);
  const app = createApp({ session: s, assetsDirectory: assets });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  r.cleanup(async () => {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    await s.close();
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (route, body, headers = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { ...r, s, app, base, post };
}
test("HTTP board returns during held upstream and multiple refresh calls join one cycle; actions commit before200", async (t) => {
  const r = await setup(t);
  await r.s.refresh();
  const gate = deferred(),
    entered = deferred();
  let calls = 0;
  r.routes[`/v1/draft/${r.snapshot.config.draftId}/picks`] = async () => {
    calls++;
    entered.resolve();
    await gate.promise;
    return [];
  };
  const poll = r.s.refresh();
  await entered.promise;
  const board = await fetch(r.base + "/api/board");
  assert.equal(board.status, 200);
  assert.equal(board.headers.get("cache-control"), "no-store");
  assert.equal((await board.json()).availabilityKnown, true);
  for (let i = 0; i < 3; i++) {
    const res = await r.post("/api/refresh", {});
    assert.equal(res.status, 202);
    assert.equal((await res.json()).inFlight, true);
  }
  assert.equal(calls, 1);
  gate.resolve();
  await poll;
  const old = r.s.getBoard();
  const res = await r.post("/api/actions", {
    expectedRevision: old.revision,
    action: { type: "taken", playerId: "10001" },
  });
  assert.equal(res.status, 200);
  const accepted = await res.json();
  assert.equal(
    JSON.parse(await readFile(r.sessionFile, "utf8")).revision,
    accepted.revision,
  );
  assert.equal(
    (
      await r.post("/api/actions", {
        expectedRevision: old.revision,
        action: { type: "taken", playerId: "10002" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await r.post("/api/actions", {
        expectedRevision: accepted.revision,
        action: { type: "taken", playerId: "missing" },
      })
    ).status,
    422,
  );
  await rename(r.sessionFile, r.sessionFile + ".saved");
  await mkdir(r.sessionFile);
  const failed = await r.post("/api/actions", {
    expectedRevision: accepted.revision,
    action: { type: "taken", playerId: "10002" },
  });
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).error.code, "persistence-failed");
  assert.equal(r.s.getBoard().revision, accepted.revision);
  assert.ok(r.log.every((r) => r.method === "GET"));
});
test("complete HTTP negative surface rejects before mutation and static files use only fixed mappings", async (t) => {
  const r = await setup(t);
  await r.s.refresh();
  const revision = r.s.getBoard().revision;
  for (const [body, headers, status] of [
    ["{", {}, 400],
    ["x".repeat(16385), {}, 413],
    ["{}", { "content-type": "text/plain" }, 415],
    ["{}", { origin: "https://foreign.test" }, 403],
    ["{}", { host: "foreign.test" }, 403],
    ["{}", { origin: "null" }, 403],
  ]) {
    const res = headers.host
      ? await new Promise((resolve, reject) => {
          const req = http.request(
            r.base + "/api/actions",
            {
              method: "POST",
              headers: { "content-type": "application/json", ...headers },
            },
            (response) => {
              const chunks = [];
              response.on("data", (b) => chunks.push(b));
              response.on("end", () =>
                resolve({
                  status: response.statusCode,
                  json: async () => JSON.parse(Buffer.concat(chunks)),
                }),
              );
            },
          );
          req.on("error", reject);
          req.end(body);
        })
      : await r.post("/api/actions", body, headers);
    assert.equal(res.status, status);
    const error = await res.json();
    assert.equal(error.revision, revision);
    assert.equal(typeof error.error.code, "string");
    assert.equal(typeof error.error.message, "string");
    assert.ok(!JSON.stringify(error).includes(r.dir));
  }
  for (const route of [
    "/api/proxy",
    "/.local/snapshot.json",
    "/sources/players.json",
    "/api/picks",
    "/unknown",
  ])
    assert.equal((await fetch(r.base + route)).status, 404);
  for (const [route, method] of [
    ["/api/board", "POST"],
    ["/api/actions", "GET"],
    ["/api/refresh", "PUT"],
    ["/index.html", "DELETE"],
  ])
    assert.equal((await fetch(r.base + route, { method })).status, 405);
  for (const route of ["/", "/index.html", "/app.mjs", "/styles.css"])
    assert.equal((await fetch(r.base + route)).status, 200);
  for (const route of [
    "/../.local/snapshot.json",
    "/%2e%2e/.local/snapshot.json",
    "/app.mjs%00",
    "//api/board",
  ]) {
    const status = await new Promise((resolve, reject) => {
      const req = http.get(r.base, { path: route }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
    });
    assert.equal(status, 404);
  }
  assert.equal(r.s.getBoard().revision, revision);
  assert.ok(r.log.every((r) => r.method === "GET"));
});
test("chunked oversized request returns413 before end and local actions do not hide upstream failure", async (t) => {
  const r = await setup(t);
  await r.s.refresh();
  const result = await new Promise((resolve, reject) => {
    const request = http.request(
      r.base + "/api/actions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (b) => chunks.push(b));
        response.on("end", () => {
          request.end();
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks)),
          });
        });
      },
    );
    request.on("error", reject);
    request.write("x".repeat(17000));
  });
  assert.equal(result.status, 413);
  const revision = r.s.getBoard().revision;
  r.routes[`/v1/draft/${r.snapshot.config.draftId}/picks`] = new Error(
    "offline",
  );
  await r.s.refresh();
  const response = await r.post("/api/actions", {
    expectedRevision: revision,
    action: { type: "taken", playerId: "10001" },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).connection.status, "error");
});
