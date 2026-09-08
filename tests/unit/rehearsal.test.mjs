import test from 'node:test';
import assert from 'node:assert/strict';
import { selectStage } from '../../scripts/rehearse.mjs';
import { fixtureSnapshot } from '../helpers/runtime.mjs';
import { normalizePicks } from '../../src/sleeper/client.mjs';

test('stages 0/1/27/28/29 preserve actual choices, remove an opponent candidate, and are legal immutable fixtures', () => {
  const snapshot = fixtureSnapshot();
  const input = { stage: 0, players: Object.values(snapshot.playersById), ownRecords: [
    { pickNo: 1, playerId: '10003' }, { pickNo: 28, playerId: '10080' }, { pickNo: 29, playerId: '10160' },
  ], removedPlayerId: '10001' };
  const original = structuredClone(input);
  let previous = [];
  for (const stage of [0, 1, 27, 28, 29]) {
    const picks = selectStage({ ...input, stage });
    assert.equal(picks.length, stage);
    assert.equal(new Set(picks.map(p => p.player_id)).size, stage);
    assert.deepEqual(picks.map(p => p.pick_no), Array.from({ length: stage }, (_, i) => i + 1));
    assert.deepEqual(picks.slice(0, previous.length), previous);
    const normalized = normalizePicks(picks, snapshot.config);
    for (const [pickNo, playerId] of [[1, '10003'], [28, '10080'], [29, '10160']]) {
      if (stage < pickNo) continue;
      assert.equal(normalized[pickNo - 1].playerId, playerId);
      assert.equal(normalized[pickNo - 1].rosterId, '5');
      assert.equal(normalized[pickNo - 1].slot, 1);
    }
    if (stage >= 27) assert.equal(picks[1].player_id, '10001');
    previous = picks;
  }
  assert.deepEqual(input, original);
  assert.throws(() => selectStage({ ...input, stage: 1, ownRecords: [] }), /Record.*1/);
  assert.throws(() => selectStage({ ...input, stage: 28, ownRecords: input.ownRecords.slice(0, 1) }), /Record.*28/);
  assert.throws(() => selectStage({ ...input, stage: 29, ownRecords: input.ownRecords.slice(0, 2) }), /Record.*29/);
  assert.throws(() => selectStage({ ...input, stage: 2 }), /stage/i);
});
