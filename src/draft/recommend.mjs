import { configFingerprint } from "../sleeper/client.mjs";
import { POLICY_VERSION } from "../contracts.mjs";
import {
  assignRoster,
  completionFeasible,
  policyCounts,
  POLICY_CAPS,
  OFFENSIVE_SLOTS,
} from "./roster.mjs";

const numeric = (value) => (Number.isFinite(value) ? value : Infinity);
const compareId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function recommend(snapshot, effective) {
  const players = Object.values(snapshot.playersById);
  const own = effective.ownPlayerIds
    .map((id) => snapshot.playersById[id])
    .filter(Boolean);
  const roster = assignRoster(own, snapshot.config);
  const base = {
    policyVersion: POLICY_VERSION,
    candidates: [],
    players,
    roster,
    nextPicks: effective.nextPicks,
    remainingPicks: effective.remainingPicks,
  };
  const unavailable = (status, reason) => ({ ...base, status, reason });
  if (
    effective.prepareRequired ||
    effective.configFingerprint !== configFingerprint(snapshot.config)
  ) {
    return unavailable(
      "prepare-required",
      "League or draft configuration changed. Prepare data again.",
    );
  }
  if (!effective.availabilityKnown)
    return unavailable(
      "unknown-initial",
      "Pick availability is unknown until a valid Sleeper board is checked.",
    );
  if (effective.remainingPicks.length === 0)
    return unavailable("complete", "All of your draft selections are filled.");
  if (own.length !== effective.ownPlayerIds.length)
    return unavailable(
      "unknown-own-player",
      "An own pick has an unknown player identity. Prepare current player data.",
    );
  const taken = new Set(effective.unavailableIds);
  const pool = players.filter(
    (player) => player.eligible && !taken.has(player.id),
  );
  const counts = policyCounts(own);
  const offense = snapshot.config.rosterPositions.filter((slot) =>
    OFFENSIVE_SLOTS.has(slot),
  );
  const offensiveFilled = assignRoster(own, offense).filled;
  const survivors = [];
  for (const player of pool) {
    if (
      counts[player.policyPosition] >=
      (POLICY_CAPS[player.policyPosition] ?? Infinity)
    )
      continue;
    const withCandidate = [...own, player];
    const after = assignRoster(withCandidate, snapshot.config);
    const fillsStarter = after.filled > roster.filled;
    const fillsOffense =
      assignRoster(withCandidate, offense).filled > offensiveFilled;
    const earlySpecialist =
      ["K", "DEF"].includes(player.policyPosition) &&
      effective.remainingPicks.length > 2;
    const backup =
      ["QB", "TE"].includes(player.policyPosition) &&
      offensiveFilled < offense.length &&
      !fillsOffense;
    const deferral = earlySpecialist ? 2 : backup ? 1 : 0;
    const filledSlot = after.slots.find(
      (slot) => slot.playerId === player.id,
    )?.position;
    survivors.push({ player, fillsStarter, deferral, filledSlot });
  }
  survivors.sort((a, b) => {
    if (a.deferral !== b.deferral) return a.deferral - b.deferral;
    const left = a.player,
      right = b.player;
    if (snapshot.rankingMode === "ecr") {
      const leftRanked = left.ecr !== null,
        rightRanked = right.ecr !== null;
      if (leftRanked !== rightRanked) return leftRanked ? -1 : 1;
      if (leftRanked) {
        return (
          numeric(left.ecr.tier) - numeric(right.ecr.tier) ||
          Number(b.fillsStarter) - Number(a.fillsStarter) ||
          left.ecr.rank - right.ecr.rank ||
          numeric(left.adp) - numeric(right.adp) ||
          compareId(left.id, right.id)
        );
      }
      return (
        numeric(left.adp) - numeric(right.adp) || compareId(left.id, right.id)
      );
    }
    return (
      numeric(left.adpBand) - numeric(right.adpBand) ||
      Number(b.fillsStarter) - Number(a.fillsStarter) ||
      numeric(left.adp) - numeric(right.adp) ||
      compareId(left.id, right.id)
    );
  });
  // Feasibility does not change rank keys. Check in rank order and stop once the
  // three displayed choices are proven, rather than solving the entire pool.
  const selected = [];
  for (const entry of survivors) {
    if (
      !completionFeasible(
        [...own, entry.player],
        pool.filter((player) => player.id !== entry.player.id),
        effective.remainingPicks.length - 1,
        snapshot.config,
      )
    )
      continue;
    selected.push(entry);
    if (selected.length === 3) break;
  }
  if (!selected.length)
    return unavailable(
      "unavailable",
      "No available candidate permits all starters to be completed with the remaining selections.",
    );
  return {
    ...base,
    status: "ready",
    reason: null,
    candidates: selected.map(
      ({ player, fillsStarter, deferral, filledSlot }) => ({
        ...player,
        reasons: [
          snapshot.rankingMode === "ecr" && player.ecr
            ? `Expert rank ${player.ecr.rank}${player.ecr.tier === null ? "" : `, tier ${player.ecr.tier}`}${player.adp === null ? "" : `; Sleeper ADP ${player.adp}`}.`
            : `Sleeper ADP ${player.adp}${snapshot.rankingMode === "adp-only" ? `; fixed band ${player.adpBand + 1}` : "; no expert rank"}.`,
          fillsStarter
            ? `Fills a ${filledSlot} starter while preserving roster completion.`
            : deferral === 2
              ? `K/DEF depth is deferred until the final two selections; completion remains possible.`
              : deferral === 1
                ? `Backup ${player.policyPosition} is deferred while offensive starters remain open.`
                : `Adds ${player.policyPosition} depth while preserving roster completion.`,
        ],
      }),
    ),
  };
}
