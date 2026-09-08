import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { runtime, deferred } from './runtime.mjs';
import { createApp } from '../../src/server.mjs';
import { openSession } from '../../src/session.mjs';

export async function browserRuntime(t, browser, { beforeOpen, ready = true } = {}) {
  const r = await runtime(t);
  await beforeOpen?.(r);
  r.s = await openSession(r.sessionOptions);
  r.app = createApp({ session: { getBoard: () => r.s.getBoard(), refresh: options => r.s.refresh(options), act: request => r.s.act(request) } });
  await new Promise(resolve => r.app.listen(0, '127.0.0.1', resolve));
  r.base = `http://127.0.0.1:${r.app.address().port}`;
  r.cleanup(async () => {
    r.app.closeAllConnections();
    await new Promise(resolve => r.app.close(resolve));
    await r.s.close();
  });
  if (ready) await r.s.refresh();
  r.context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  r.context.setDefaultTimeout(2500);
  await r.context.addInitScript(() => {
    window.receivedBoards = [];
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args), json = response.json.bind(response);
      response.json = async () => {
        const body = await json();
        if (body.sessionId) window.receivedBoards.push(`${body.sessionId}:${body.viewRevision}`);
        return body;
      };
      return response;
    };
  });
  r.cleanup(() => r.context.close());
  const errors = [];
  r.context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  t.after(() => assert.deepEqual(errors, [], 'no browser runtime errors'));
  r.page = await r.context.newPage();
  r.cleanup(() => failureArtifact(t, r.page));
  await r.page.clock.install({ time: r.clock.now() });
  await r.page.clock.pauseAt(r.clock.now());
  await r.page.goto(r.base);
  await r.page.waitForFunction(() => document.body.dataset.sessionId);
  r.post = (action, expectedRevision = r.s.getBoard().revision) => fetch(r.base + '/api/actions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision, action }),
  });
  return r;
}
export async function readBoard(r, page = r.page) {
  const response = page.waitForResponse(res => res.url() === r.base + '/api/board');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const b = await (await response).json();
  await page.waitForFunction(({ sessionId, viewRevision }) => document.body.dataset.sessionId === sessionId && Number(document.body.dataset.viewRevision) >= viewRevision, b);
  return b;
}
export async function holdResponse(page, endpoint, { before = false } = {}) {
  const entered = deferred(), release = deferred(), finished = deferred();
  const pattern = `**/api/${endpoint}`;
  let used = false, body;
  const handler = async route => {
    if (used) return route.continue();
    used = true;
    try {
      if (before) { entered.resolve(route.request()); await release.promise; }
      const response = await route.fetch();
      if (!before) { body = await response.json(); entered.resolve(body); await release.promise; }
      await route.fulfill({ response });
      finished.resolve();
    } catch (error) { finished.reject(error); }
  };
  await page.route(pattern, handler);
  return { entered: entered.promise, release: async () => {
    const key = body ? `${body.sessionId}:${body.viewRevision}` : null;
    const previous = key ? await page.evaluate(key => window.receivedBoards.filter(value => value === key).length, key) : 0;
    release.resolve(); await finished.promise;
    if (key) await page.waitForFunction(({ key, previous }) => window.receivedBoards.filter(value => value === key).length > previous, { key, previous });
  }, finished: finished.promise,
    remove: () => page.unroute(pattern, handler) };
}
export async function failureArtifact(t, page) {
  if (t.passed === false && !page.isClosed()) {
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: `test-results/${t.name.slice(0, 30).replaceAll(/\W/g, '-')}.png`, fullPage: true });
  }
}
