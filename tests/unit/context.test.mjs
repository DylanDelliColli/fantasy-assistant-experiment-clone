import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeContext,
  normalizePicks,
  configFingerprint,
} from "../../src/sleeper/client.mjs";
import { context, pick } from "../fixtures/sleeper.mjs";
test("context resolves roster5, slot1 and active draft rounds13; fingerprint canonicalizes maps, excludes names/status", () => {
  const c = context(),
    a = normalizeContext(c);
  assert.equal(a.rosterId, "5");
  assert.equal(a.slot, 1);
  assert.equal(a.rounds, 13);
  assert.equal(a.season, "2026");
  c.draft.status = "complete";
  c.league.name = "Changed";
  c.league.scoring_settings = { pass_td: 4, rec: 0.5 };
  assert.equal(configFingerprint(a), configFingerprint(normalizeContext(c)));
  c.league.scoring_settings.sack = 2;
  assert.notEqual(configFingerprint(a), configFingerprint(normalizeContext(c)));
});
test("each unsupported context fails explicitly", () => {
  for (const change of [
    (c) => (c.user.user_id = "someone"),
    (c) => (c.league.sport = "nba"),
    (c) => (c.draft.type = "linear"),
    (c) => (c.draft.settings.teams = 12),
    (c) => (c.draft.settings.rounds = 3),
    (c) => (c.draft.settings.reversal_round = 3),
    (c) => c.league.roster_positions.pop(),
    (c) => (c.rosters[0].keepers = ["123"]),
    (c) => c.tradedPicks.push({ round: 1 }),
    (c) => (c.draft.season = "2025"),
    (c) => (c.league.settings.reserve_slots = 2),
    (c) => (c.draft.slot_to_roster_id["1"] = 1),
    (c) => delete c.draft.draft_order[c.user.user_id],
    (c) => (c.league.scoring_settings.rec = 1),
    (c) => (c.league.settings.type = 2),
  ]) {
    const c = context();
    change(c);
    assert.throws(() => normalizeContext(c));
  }
});
test("picks allow empty picked_by, normalize unknown IDs and sorted contiguous rows; illegal fields reject", () => {
  const c = normalizeContext(context());
  const rows = Array.from({ length: 15 }, (_, i) => pick(i + 1));
  const p = normalizePicks(rows.toReversed(), c);
  assert.equal(p[0].rosterId, "5");
  assert.equal(p[14].slot, 14);
  assert.equal(p[0].playerId, "unknown-1");
  for (const change of [
    (r) => r.splice(0, 1),
    (r) => r.push(r[0]),
    (r) => (r[1].player_id = r[0].player_id),
    (r) => (r[0].round = 2),
    (r) => (r[0].draft_slot = 2),
    (r) => (r[0].player_id = ""),
    (r) => (r[0].player_id = 9007199254740992),
    (r) => (r[0].roster_id = 88),
    (r) => (r[0].pick_no = 183),
    (r) => (r[0].pick_no = 1.5),
  ]) {
    const r = structuredClone(rows);
    change(r);
    assert.throws(() => normalizePicks(r, c));
  }
});
test("fingerprint explicitly excludes added presentation labels, timestamps and status; all enumerated rule maps affect it", () => {
  const c = normalizeContext(context()),
    hash = configFingerprint(c);
  assert.equal(
    configFingerprint({
      ...c,
      name: "Other",
      status: "complete",
      fetchedAt: "later",
    }),
    hash,
  );
  for (const change of [
    (c) => (c.scoring.sack = 2),
    (c) => (c.keeperAssignments["5"] = ["123"]),
    (c) => (c.slotToRosterId["1"] = "1"),
    (c) => c.rosterPositions.reverse(),
    (c) => (c.reversal = 3),
  ]) {
    const changed = structuredClone(c);
    change(changed);
    assert.notEqual(configFingerprint(changed), hash);
  }
});
test("unsupported assigned draft keepers, draft slot shape and league taxi/best-ball settings reject", () => {
  for (const change of [
    (c) => (c.draft.keepers = { 10001: 1 }),
    (c) => (c.draft.settings.slots_qb = 2),
    (c) => (c.league.settings.taxi_slots = 1),
    (c) => (c.league.settings.best_ball = 1),
  ]) {
    const c = context();
    change(c);
    assert.throws(() => normalizeContext(c));
  }
});
