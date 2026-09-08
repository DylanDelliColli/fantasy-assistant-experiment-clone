import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, mkdir, rm, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { browserRuntime, readBoard, holdResponse, failureArtifact } from '../helpers/browser.mjs';
import { deferred } from '../helpers/runtime.mjs';
import { pick } from '../fixtures/sleeper.mjs';
import { openSession } from '../../src/session.mjs';

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const cards = page => page.locator('#candidates article');
const playerCard = (page, id) => page.locator(`#candidates article[data-player-id="${id}"]`);
const own = async (page, id) => {
  const button = playerCard(page, id).getByRole('button', { name: /^Record my pick/ });
  await button.focus(); await page.keyboard.press('Enter');
  await page.locator('#roster').getByText(`Fictional Player ${Number(id) - 10000}`, { exact: true }).waitFor();
};
const checkCount = async (page, count) => page.waitForFunction(n => document.querySelector('#observed').textContent === `Observed picks: ${n}`, count);
const waitRevision = async (r, revision = r.s.getBoard().revision) => r.page.waitForFunction(n => Number(document.body.dataset.revision) === n, revision);

test('1 preparation/search/filter/details, keyboard 1/28/29, confirmation, taken/Undo and executable isolated rehearsal', async t => {
  const r = await browserRuntime(t, browser), p = r.page;
  t.after(() => failureArtifact(t, p));
  assert.equal(await cards(p).count(), 3);
  assert.match(await p.locator('#league-summary').innerText(), /14 teams.*Half-PPR.*13 rounds/);
  assert.match(await p.locator('#roster-settings').innerText(), /QB.*RB.*FLEX.*K.*DEF.*BN/);
  assert.equal(await p.locator('#next-picks').innerText(), 'Next picks: 1 · 28');
  await p.getByText('Before the draft', { exact: true }).click();
  assert.match(await p.locator('#preparation').innerText(), /1.*28/);
  await p.getByLabel('Search players').fill('Fictional Player 41');
  await p.getByLabel('Position').selectOption('RB');
  assert.equal(await p.locator('#players [data-player-id]').count(), 1);
  await p.locator('#players').getByRole('button', { name: /Details/ }).focus();
  await p.keyboard.press('Enter');
  assert.match(await p.locator('#player-detail').innerText(), /Sleeper half-PPR projection\s+100/);
  assert.match(await p.locator('#player-detail').innerText(), /Prior actual half-PPR points\s+90/);
  await p.getByLabel('Search players').fill('');
  await p.getByLabel('Position').selectOption('all');
  const firstCandidates = r.s.getBoard().candidates.map(c => c.id);
  const firstChoice = firstCandidates[2]; // Deliberately not the launcher's first candidate.
  await own(p, firstChoice);
  assert.equal(await p.locator('#next-picks').innerText(), 'Next picks: 28 · 29');
  const opponent = firstCandidates[0];
  const picks = Array.from({ length: 27 }, (_, i) => pick(i + 1, i === 0 ? firstChoice : i === 1 ? opponent : String(10000 + 100 + i)));
  r.routes[`/v1/draft/${r.snapshot.config.draftId}/picks`] = picks;
  await r.s.refresh(); await readBoard(r);
  await checkCount(p, 27);
  assert.equal(await playerCard(p, opponent).count(), 0);
  assert.equal(r.s.getBoard().corrections.length, 0);
  const choice28 = r.s.getBoard().candidates[0].id;
  await own(p, choice28);
  assert.equal(await p.locator('#next-picks').innerText(), 'Next picks: 29 · 56');
  assert.equal(r.s.getBoard().draft.observedCount, 27);
  assert.equal(await playerCard(p, choice28).count(), 0);
  const choice29 = r.s.getBoard().candidates[0].id;
  await own(p, choice29);
  assert.equal(await p.locator('#next-picks').innerText(), 'Next picks: 56 · 57');
  picks.push(pick(28, choice28), pick(29, choice29));
  await r.s.refresh(); await readBoard(r);
  assert.equal(r.s.getBoard().ownRecords.length, 3);
  assert.equal(await p.locator('#corrections li').count(), 0);
  assert.match(await p.locator('#notices').innerText(), /confirmed/);
  const taken = r.s.getBoard().candidates[0].id;
  await playerCard(p, taken).getByRole('button', { name: /^Mark taken/ }).focus();
  await p.keyboard.press('Enter');
  await p.locator('#corrections').getByRole('button', { name: /^Undo/ }).waitFor();
  assert.ok(JSON.parse(await readFile(r.sessionFile, 'utf8')).corrections.some(c => c.playerId === taken));
  await p.locator('#corrections').getByRole('button', { name: /^Undo/ }).focus();
  await p.keyboard.press('Enter');
  await playerCard(p, taken).waitFor();

  // Exercise the real terminal entry, its real HTTP/session/files and cleanup.
  const livePath = r.dir + '/.local';
  await mkdir(livePath);
  const liveBefore = 'live state sentinel: never read or alter this';
  await writeFile(livePath + '/snapshot.json', liveBefore);
  // Observe actual fetch destinations without replacing the real HTTP transport.
  const audit = `const realFetch = globalThis.fetch; globalThis.fetch = (url, options) => { const target = new URL(url); console.log('AUDIT ' + JSON.stringify({url:String(url), method:options?.method ?? 'GET'})); if(target.hostname !== '127.0.0.1') throw new Error('Real provider access forbidden in rehearsal'); return realFetch(url, options); };`;
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(audit)}`, new URL('../../scripts/rehearse.mjs', import.meta.url).pathname], { cwd: r.dir, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', stderr = ''; const updates = [];
  child.stdout.on('data', bytes => { output += bytes; for (const wake of updates.splice(0)) wake(); });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const exit = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const line = async re => {
    while (!re.test(output)) await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Missing terminal output ${re}: ${output}\n${stderr}`)), 2500);
      updates.push(() => { clearTimeout(timeout); resolve(); });
    });
    return output.match(re);
  };
  const url = (await line(/Rehearsal URL: (http:\/\/127\.0\.0\.1:\d+)/))[1];
  const stateDir = (await line(/Isolated state: (.+)\n/))[1];
  assert.ok(!stateDir.startsWith(process.cwd() + '/.local'));
  const rp = await r.context.newPage(); await rp.goto(url);
  await rp.getByRole('heading', { name: /^REHEARSAL/ }).waitFor();
  child.stdin.write('\n'); await line(/Record your pick 1 before advancing/);
  let rb = await (await fetch(url + '/api/board')).json();
  const selected = rb.candidates[2].id;
  await own(rp, selected);
  child.stdin.write('\n'); await line(/Stage 1:/);
  child.stdin.write('\n'); await line(/Stage 27:/);
  await rp.evaluate(() => window.dispatchEvent(new Event('focus'))); await checkCount(rp, 27);
  rb = await (await fetch(url + '/api/board')).json();
  assert.equal(rb.ownRecords[0].playerId, selected);
  assert.ok(rb.unavailableIds.includes('10001'));
  await own(rp, rb.candidates[0].id);
  child.stdin.write('\n'); await line(/Stage 28:/);
  await readBoard({ base: url, page: rp });
  rb = await (await fetch(url + '/api/board')).json();
  await own(rp, rb.candidates[0].id);
  child.stdin.write('\n'); await line(/Stage 29:/);
  rb = await (await fetch(url + '/api/board')).json();
  assert.equal(rb.ownRecords.length, 3);
  assert.equal(rb.corrections.length, 0);
  child.stdin.write('q\n');
  let exitTimeout;
  const result = await Promise.race([exit, new Promise((resolve, reject) => {
    exitTimeout = setTimeout(() => reject(new Error(`Rehearsal did not exit: ${output}\n${stderr}`)), 2500);
  })]).finally(() => clearTimeout(exitTimeout));
  assert.deepEqual(result, [0, null]);
  assert.equal(stderr, '');
  assert.match(output, /Fixture requests: \d+ GET; real-provider requests: 0/);
  const requests = output.split('\n').filter(line => line.startsWith('AUDIT ')).map(line => JSON.parse(line.slice(6)));
  assert.ok(requests.length > 10);
  assert.ok(requests.every(request => new URL(request.url).hostname === '127.0.0.1' && request.method === 'GET'));
  await assert.rejects(access(stateDir), { code: 'ENOENT' });
  await assert.rejects(fetch(url));
  assert.equal(await readFile(livePath + '/snapshot.json', 'utf8'), liveBefore);
  assert.ok(r.log.every(row => row.method === 'GET'));
});

test('2 upstream/app disconnection retains cards, clock-driven ages, unchanged checks, completed cadence and immediate recovery', async t => {
  const r = await browserRuntime(t, browser), p = r.page;
  t.after(() => failureArtifact(t, p));
  r.routes[`/v1/draft/${r.snapshot.config.draftId}/picks`] = [pick(1, '10003')];
  await r.s.refresh(); await readBoard(r);
  const initialCards = await cards(p).allTextContents(), revision = r.s.getBoard().revision;
  for (let i = 0; i < 4; i++) {
    r.clock.tick(5000); await r.s.refresh(); await p.clock.runFor(5000); await readBoard(r);
    assert.match(await p.locator('#connection').innerText(), /Checked.*Sleeper may lag/);
  }
  assert.equal(r.s.getBoard().revision, revision);
  assert.match(await p.locator('#last-changed').innerText(), /20s ago/);
  assert.match(await p.locator('#last-checked').innerText(), /0s ago/);
  assert.match(await p.locator('#sources').innerText(), /Fetched.*Updated/s);
  r.routes[`/v1/draft/${r.snapshot.config.draftId}/picks`] = new Error('fixture unavailable');
  await r.s.refresh(); await readBoard(r);
  assert.match(await p.locator('#connection').innerText(), /Check failed/);
  assert.deepEqual(await cards(p).allTextContents(), initialCards);
  assert.equal(r.s.getBoard().revision, revision);
  await p.route('**/api/board', route => route.abort('connectionrefused'));
  await p.evaluate(() => window.dispatchEvent(new Event('focus')));
  await p.getByText(/App connection lost/, { exact: false }).waitFor();
  await p.clock.runFor(2000);
  assert.deepEqual(await cards(p).allTextContents(), initialCards);
  assert.match(await p.locator('#last-checked').innerText(), /2s ago/);
  await p.unroute('**/api/board');
  r.routes[`/v1/draft/${r.snapshot.config.draftId}/picks`] = [pick(1, '10003')];
  r.clock.tick(10000); await r.s.refresh(); await p.clock.runFor(8000); await readBoard(r);
  assert.match(await p.locator('#connection').innerText(), /Checked/);
  assert.equal(r.s.getBoard().revision, revision);
  r.c.draft.status = 'complete'; await r.s.refresh(); await readBoard(r);
  const completeRevision = r.s.getBoard().revision;
  r.clock.tick(30000); await r.s.refresh(); await p.clock.runFor(30000); await readBoard(r);
  assert.match(await p.locator('#connection').innerText(), /Checked/);
  assert.equal(r.s.getBoard().revision, completeRevision);
  // Hold app replies to prove local elapsed display crosses 40s independently.
  const held = await holdResponse(p, 'board');
  await p.evaluate(() => window.dispatchEvent(new Event('focus'))); await held.entered;
  await p.clock.setFixedTime(new Date(Date.parse(r.s.getBoard().lastCheckedAt) + 39999));
  await p.clock.runFor(1000);
  assert.doesNotMatch(await p.locator('#connection').innerText(), /Overdue/);
  await p.clock.setFixedTime(new Date(Date.parse(r.s.getBoard().lastCheckedAt) + 40000));
  await p.clock.runFor(1000);
  assert.match(await p.locator('#connection').innerText(), /Overdue/);
  await held.release(); await held.finished; await held.remove();
  r.clock.tick(41000); await r.s.refresh(); await p.clock.setFixedTime(r.clock.now()); await readBoard(r);
  r.c.draft.status = 'drafting'; await r.s.refresh(); await readBoard(r);
  const heldActive = await holdResponse(p, 'board');
  await p.evaluate(() => window.dispatchEvent(new Event('focus'))); await heldActive.entered;
  await p.clock.setFixedTime(new Date(Date.parse(r.s.getBoard().lastCheckedAt) + 15000));
  await p.clock.runFor(1000);
  assert.match(await p.locator('#connection').innerText(), /Overdue/);
  await heldActive.release(); await heldActive.finished; await heldActive.remove();
});

test('3 reviewed diff, both response races, restart ordering, focus/coalescing and 409/422/persistence feedback', async t => {
  const r = await browserRuntime(t, browser), p = r.page;
  t.after(() => failureArtifact(t, p));
  await p.getByLabel('Search players').fill('Fictional');
  const focused = p.getByLabel('Search players'); await focused.focus();
  await p.evaluate(() => { window.originalSearch = document.activeElement; });
  r.clock.tick(5000); await r.s.refresh(); await readBoard(r);
  assert.equal(await p.evaluate(() => document.activeElement === window.originalSearch), true);
  await cards(p).first().getByRole('button', { name: 'Details', exact: true }).focus();
  await p.evaluate(() => { window.originalCardControl = document.activeElement; });
  r.clock.tick(5000); await r.s.refresh(); await readBoard(r);
  assert.equal(await p.evaluate(() => document.activeElement === window.originalCardControl), true);
  // Visible-window focus and visibility regain are separate trigger groups.
  for (const trigger of ['focus', 'visibilitychange']) {
    const held = await holdResponse(p, 'board'); let requests = 0;
    const count = request => { if (request.url().endsWith('/api/board')) requests++; };
    p.on('request', count);
    if (trigger === 'visibilitychange') {
      await p.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await p.clock.runFor(2000);
      assert.equal(requests, 0, 'hidden pages do not poll');
    }
    await p.evaluate(type => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      for (let i = 0; i < 4; i++) (type === 'focus' ? window : document).dispatchEvent(new Event(type));
    }, trigger);
    await held.entered;
    assert.equal(requests, 1);
    await held.release(); await held.finished; await held.remove(); p.off('request', count);
  }
  // Older read cannot replace a committed action.
  let held = await holdResponse(p, 'board');
  await p.evaluate(() => window.dispatchEvent(new Event('focus'))); const old = await held.entered;
  await playerCard(p, '10001').getByRole('button', { name: /^Mark taken/ }).click();
  await p.locator('#corrections li').waitFor(); const newer = r.s.getBoard();
  assert.ok(newer.viewRevision > old.viewRevision);
  await held.release(); await held.finished; await held.remove(); await waitRevision(r);
  assert.equal(await playerCard(p, '10001').count(), 0);
  // Earlier action commits later than a later metadata GET; same-session newer view wins.
  held = await holdResponse(p, 'actions', { before: true });
  const id = r.s.getBoard().candidates[0].id;
  await playerCard(p, id).getByRole('button', { name: /^Mark taken/ }).click(); await held.entered;
  r.clock.tick(5000); await r.s.refresh(); const metadata = await readBoard(r);
  await held.release(); await held.finished; await held.remove(); await waitRevision(r);
  assert.ok(r.s.getBoard().viewRevision > metadata.viewRevision);
  assert.equal(await playerCard(p, id).count(), 0);
  // Changed official pick is reviewed using the exact displayed token.
  const route = `/v1/draft/${r.snapshot.config.draftId}/picks`;
  r.routes[route] = [pick(1, '10003')]; await r.s.refresh(); await readBoard(r);
  r.routes[route] = [pick(1, '10004')]; await r.s.refresh(); await readBoard(r);
  assert.match(await p.locator('#pending').innerText(), /Pick 1.*10003.*10004/s);
  const pendingToken = r.s.getBoard().pending.revision;
  const request = p.waitForRequest(req => req.url().endsWith('/api/actions'));
  await p.getByRole('button', { name: 'Use this Sleeper board' }).focus(); await p.keyboard.press('Enter');
  assert.equal((await request).postDataJSON().action.pendingRevision, pendingToken);
  await p.locator('#pending').waitFor({ state: 'hidden' });
  assert.equal(r.s.getBoard().ownRecords[0].playerId, '10004');
  // A server change outside this page makes the next browser action obsolete.
  const displayed = r.s.getBoard().candidates[0].id;
  await r.post({ type: 'taken', playerId: '10200' });
  let actionCount = 0; const countAction = req => { if (req.url().endsWith('/api/actions')) actionCount++; };
  p.on('request', countAction);
  await playerCard(p, displayed).getByRole('button', { name: /^Mark taken/ }).click();
  await p.locator('#action-message').getByText(/Board changed.*Review/).waitFor();
  await waitRevision(r); assert.equal(actionCount, 1);
  assert.ok(!r.s.getBoard().unavailableIds.includes(displayed));
  p.off('request', countAction);
  // Browsing an official player allows the server's 422 explanation to be surfaced.
  await p.getByLabel('Search players').fill('Fictional Player 4');
  await p.locator('#players [data-player-id="10004"]').getByRole('button', { name: /Details/ }).click();
  await p.locator('#player-detail').getByRole('button', { name: /^Mark taken/ }).click();
  await p.locator('#action-message').getByText('That player is already taken.').waitFor();
  // Real filesystem failure; no saved feedback and no optimistic correction.
  await rename(r.sessionFile, r.sessionFile + '.saved'); await mkdir(r.sessionFile);
  const beforeFailure = r.s.getBoard();
  await playerCard(p, displayed).getByRole('button', { name: /^Mark taken/ }).click();
  await p.locator('#action-message').getByText(/could not be saved/).waitFor();
  assert.equal(r.s.getBoard().revision, beforeFailure.revision);
  assert.equal(await playerCard(p, displayed).count(), 1);
  assert.doesNotMatch(await p.locator('#action-message').innerText(), /^Saved/);
  await rm(r.sessionFile, { recursive: true }); await rename(r.sessionFile + '.saved', r.sessionFile);
  // Restart changes session and resets the view counter; hold a real prior-session response.
  for (let i = 0; i < 4; i++) await r.s.refresh(); await readBoard(r);
  const oldSession = r.s.getBoard();
  held = await holdResponse(p, 'board');
  await p.evaluate(() => window.dispatchEvent(new Event('focus'))); await held.entered;
  await r.s.close(); r.s = await openSession(r.sessionOptions); await r.s.refresh();
  assert.ok(r.s.getBoard().viewRevision < oldSession.viewRevision);
  await playerCard(p, displayed).getByRole('button', { name: /^Mark taken/ }).click();
  await waitRevision(r);
  await p.waitForFunction(id => document.body.dataset.sessionId === id, r.s.getBoard().sessionId);
  await held.release(); await held.finished; await held.remove();
  assert.equal(await p.locator('body').getAttribute('data-session-id'), r.s.getBoard().sessionId);
  // The displayed page has NEVER seen this intermediate session: hold its GET N.
  await r.s.close(); r.s = await openSession(r.sessionOptions); await r.s.refresh();
  const unseenId = r.s.getBoard().sessionId;
  assert.notEqual(await p.locator('body').getAttribute('data-session-id'), unseenId);
  const newHeld = await holdResponse(p, 'board');
  await p.evaluate(() => window.dispatchEvent(new Event('focus'))); await newHeld.entered;
  await r.s.close(); r.s = await openSession(r.sessionOptions); await r.s.refresh();
  const current = r.s.getBoard();
  await playerCard(p, current.candidates[0].id).getByRole('button', { name: /^Mark taken/ }).click();
  await p.waitForFunction(id => document.body.dataset.sessionId === id, current.sessionId);
  await newHeld.release(); await newHeld.finished; await newHeld.remove();
  assert.equal(await p.locator('body').getAttribute('data-session-id'), current.sessionId);
});

test('4 provider strings are text, named controls, unknown versus empty availability, two pages share one upstream poller', async t => {
  const gate = deferred(), entered = deferred();
  const r = await browserRuntime(t, browser, { ready: false, beforeOpen: async r => {
    r.snapshot.leagueName = '<script>window.injected=true</script> League';
    r.snapshot.playersById['10001'].name = '<img src=x onerror="window.injected=true">';
    await writeFile(r.dir + '/snapshot.json', JSON.stringify(r.snapshot));
    r.routes[`/v1/draft/${r.snapshot.config.draftId}/picks`] = async () => { entered.resolve(); await gate.promise; return []; };
  } });
  const p = r.page; t.after(() => failureArtifact(t, p));
  await entered.promise;
  assert.match(await p.locator('#board-status').innerText(), /availability is unknown/);
  assert.equal(await cards(p).count(), 0);
  assert.match(await p.locator('#players li').first().innerText(), /Availability unknown/);
  assert.ok(await p.locator('#players [data-player-id]').count() > 0);
  assert.equal(await p.evaluate(() => window.injected), undefined);
  assert.match(await p.locator('h1').innerText(), /<script>/);
  const second = await r.context.newPage(); await second.goto(r.base);
  await second.waitForFunction(() => document.body.dataset.sessionId);
  const calls = () => r.log.filter(row => row.url.endsWith('/picks')).length;
  assert.equal(calls(), 1);
  const firstRefresh = p.waitForResponse(res => res.url().endsWith('/api/refresh'));
  const secondRefresh = second.waitForResponse(res => res.url().endsWith('/api/refresh'));
  await p.getByRole('button', { name: 'Refresh' }).click();
  await second.getByRole('button', { name: 'Refresh' }).click();
  await Promise.all([firstRefresh, secondRefresh]); assert.equal(calls(), 1);
  gate.resolve(); await r.s.refresh(); await readBoard(r); await readBoard(r, second);
  assert.equal(await cards(p).count(), 3);
  assert.equal(await cards(second).count(), 3);
  assert.equal(await p.locator('#next-picks').innerText(), 'Next picks: 1 · 28');
  assert.match(await cards(p).first().innerText(), /<img src=x/);
  assert.equal(await cards(p).locator('img, script').count(), 0);
  assert.equal(await p.evaluate(() => window.injected), undefined);
  assert.doesNotMatch(await p.locator('#players').innerText(), /Availability unknown/);
  const firstRow = p.locator('#players li').first();
  assert.match(await firstRow.innerText(), /Available/);
  await firstRow.getByRole('button').focus();
  await p.evaluate(() => { window.focusedPlayerDetails = document.activeElement; });
  assert.deepEqual(await p.locator('button,input,select').evaluateAll(nodes => nodes.filter(n => !n.textContent.trim() && !n.labels?.length && !n.getAttribute('aria-label')).map(n => n.outerHTML)), []);
  r.clock.tick(5000); await r.s.refresh(); await readBoard(r); await readBoard(r, second);
  assert.equal(calls(), 2);
  assert.equal(await p.evaluate(() => document.activeElement === window.focusedPlayerDetails), true);
  await playerCard(p, '10001').getByRole('button', { name: /^Mark taken/ }).click();
  await p.locator('#corrections li').waitFor();
  assert.match(await firstRow.innerText(), /Unavailable/);
  assert.ok(r.log.every(row => row.method === 'GET'));
});
