import test from 'node:test';
import assert from 'node:assert/strict';
import { valueText, dateText, ageText, freshness, injuryText, correctionText, actionRequest, responseOrder, availabilityText } from '../../web/app.mjs';

const at = Date.parse('2026-09-08T18:00:00Z');
const board = (extra = {}) => ({
  sessionId: 'a', revision: 7, viewRevision: 10, nextPicks: [28, 29],
  draft: { status: 'drafting' }, lastCheckedAt: new Date(at).toISOString(),
  lastChangedAt: new Date(at - 60000).toISOString(), connection: { status: 'checked' }, ...extra,
});
test('availability labels follow known state and exclusions without deriving recommendations', () => {
  assert.equal(availabilityText({ availabilityKnown: false, unavailableIds: [] }, 'x'), 'Availability unknown');
  assert.equal(availabilityText({ availabilityKnown: true, unavailableIds: [] }, 'x'), 'Available');
  assert.equal(availabilityText({ availabilityKnown: true, unavailableIds: ['x'] }, 'x'), 'Unavailable');
  assert.equal(availabilityText({ availabilityKnown: false, unavailableIds: ['x'] }, 'x'), 'Unavailable');
});
test('presentation separates source/check/change ages, zero, missing, and unknown injury', () => {
  assert.equal(valueText(0), '0');
  for (const value of [null, undefined, NaN]) assert.equal(valueText(value), '—');
  assert.equal(ageText(new Date(at - 120000).toISOString(), at), '2m ago');
  assert.equal(ageText(null, at), 'not available');
  assert.equal(dateText(at), '2026-09-08T18:00:00.000Z');
  assert.equal(dateText(null), 'not available');
  assert.equal(ageText(at - 4000, at), '4s ago');
  const labels = freshness(board(), at + 4000);
  assert.match(labels.checked, /4s ago/);
  assert.match(labels.changed, /1m ago/);
  assert.match(labels.status, /Checked.*Sleeper may lag/);
  assert.equal(injuryText(null), 'Injury status not provided');
  assert.equal(injuryText({ status: null }), 'Injury status not provided');
  assert.match(injuryText({ status: 'Questionable', bodyPart: 'Ankle' }), /Questionable.*Ankle/);
  assert.match(correctionText({ type: 'taken', playerId: 'x' }, 'Player X'), /Player X.*taken.*local/i);
  assert.match(correctionText({ type: 'my-pick', playerId: 'x', pickNo: 28 }, 'Player X'), /28.*Player X.*local/i);
});
test('elapsed health respects active 15s and complete 40s boundaries without revision changes', () => {
  for (const status of ['pre_draft', 'drafting', 'complete']) {
    const b = board({ draft: { status } });
    const boundary = status === 'complete' ? 40000 : 15000;
    assert.match(freshness(b, at + boundary - 1).status, /Checked/);
    assert.match(freshness(b, at + boundary).status, /Overdue/);
    assert.match(freshness(b, at, true).status, /App connection lost/);
    assert.match(freshness({ ...b, connection: { status: 'error', error: { message: 'Retry later' } } }, at).status, /Check failed.*Retry later/);
    assert.match(freshness({ ...b, connection: { status: 'stale' } }, at).status, /Stale/);
  }
  assert.match(freshness(board({ lastCheckedAt: null }), at, false, at).status, /Checking/);
  assert.match(freshness(board({ lastCheckedAt: null }), at + 15000, false, at).status, /Overdue/);
});
test('action bodies carry durable revision and the displayed selection, not viewRevision', () => {
  assert.deepEqual(actionRequest(board(), 'my-pick', { playerId: 'x' }), { expectedRevision: 7, action: { type: 'my-pick', playerId: 'x', pickNo: 28 } });
  assert.deepEqual(actionRequest(board(), 'accept-pending', { pendingRevision: 'reviewed-token' }), { expectedRevision: 7, action: { type: 'accept-pending', pendingRevision: 'reviewed-token' } });
});
test('response ordering accepts both asymmetric races and never lowers the maximum request sequence', () => {
  const order = responseOrder();
  assert.equal(order.accept(board(), 1), true);
  assert.equal(order.accept(board({ viewRevision: 12 }), 3), true);
  assert.equal(order.accept(board({ viewRevision: 11 }), 2), false);
  // Action 4 commits after metadata GET 5; the same-session view token wins.
  assert.equal(order.accept(board({ viewRevision: 13 }), 5), true);
  assert.equal(order.accept(board({ viewRevision: 14 }), 4), true);
  assert.equal(order.accept(board({ sessionId: 'unseen-old', viewRevision: 100 }), 5), false);
  assert.equal(order.accept(board({ sessionId: 'b', viewRevision: 1 }), 6), true);
  assert.equal(order.accept(board({ sessionId: 'a', viewRevision: 999 }), 7), false);
  assert.equal(order.accept(board({ sessionId: 'b', viewRevision: 1 }), 8), false);
});
test('a never-before-seen old session cannot replace the first newer response', () => {
  const order = responseOrder();
  assert.equal(order.accept(board({ sessionId: 'new', viewRevision: 1 }), 2), true);
  assert.equal(order.accept(board({ sessionId: 'never-seen', viewRevision: 50 }), 1), false);
});
