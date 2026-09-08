import { createHash } from "node:crypto";
import { configFingerprint } from "../sleeper/client.mjs";
import { DRAFT_STATE_VERSION } from "../contracts.mjs";

export class DraftError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = "DraftError";
    this.code = code;
    this.status = status;
  }
}

export function createDraftState(snapshot) {
  return {
    version: DRAFT_STATE_VERSION,
    config: snapshot.config,
    playersById: snapshot.playersById,
    configFingerprint:
      snapshot.configFingerprint ?? configFingerprint(snapshot.config),
    revision: 0,
    accepted: null,
    pending: null,
    corrections: [],
    notices: [],
    lastCheckedAt: null,
    lastChangedAt: null,
    error: null,
  };
}

export function ownPickSchedule(config) {
  return Array.from({ length: config.rounds }, (_, index) => {
    const round = index + 1;
    return (
      index * config.teams +
      (round % 2 ? config.slot : config.teams - config.slot + 1)
    );
  });
}

const samePick = (a, b) =>
  a?.pickNo === b?.pickNo &&
  a?.playerId === b?.playerId &&
  a?.rosterId === b?.rosterId;

function boardDiff(before, after) {
  const changes = [];
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    if (!samePick(before[index], after[index])) {
      changes.push({
        pickNo: index + 1,
        before: before[index] ?? null,
        after: after[index] ?? null,
      });
    }
  }
  return { firstChangedPick: changes[0]?.pickNo ?? null, changes };
}

function pendingToken(incoming) {
  // A token names the reviewed board, including across a process restart.
  const picks = incoming.picks.map(({ pickNo, playerId, rosterId }) => [
    pickNo,
    playerId,
    rosterId,
  ]);
  return createHash("sha256")
    .update(JSON.stringify([incoming.configFingerprint, picks]))
    .digest("hex");
}

function reconcileCorrections(corrections, picks, config) {
  const byPlayer = new Map(picks.map((pick) => [pick.playerId, pick]));
  const byNumber = new Map(picks.map((pick) => [pick.pickNo, pick]));
  const retained = [];
  const notices = [];
  for (const correction of corrections) {
    const playerPick = byPlayer.get(correction.playerId);
    const slotPick =
      correction.type === "my-pick" ? byNumber.get(correction.pickNo) : null;
    if (correction.type === "taken" && playerPick) {
      notices.push({
        kind: "confirmed",
        correctionId: correction.id,
        message: `Sleeper confirmed ${correction.playerId} as taken at pick ${playerPick.pickNo}.`,
      });
    } else if (correction.type === "my-pick" && (playerPick || slotPick)) {
      const confirmed =
        playerPick?.pickNo === correction.pickNo &&
        playerPick.rosterId === config.rosterId;
      notices.push({
        kind: confirmed ? "confirmed" : "conflict",
        correctionId: correction.id,
        message: confirmed
          ? `Sleeper confirmed your pick ${correction.pickNo}; the local record was retired.`
          : `Sleeper ownership conflicts with local pick ${correction.pickNo} (${correction.playerId}); the official pick takes precedence.`,
      });
    } else retained.push(correction);
  }
  return { corrections: retained, notices };
}

export function reconcileDraft(previous, incoming) {
  if (
    incoming.baseRevision !== undefined &&
    incoming.baseRevision !== previous.revision
  )
    return previous;
  if (
    incoming.requestSequence !== undefined &&
    incoming.requestSequence < (previous.lastRequestSequence ?? 0)
  )
    return previous;
  if (incoming.error) return { ...previous, error: String(incoming.error) };
  if (
    incoming.configFingerprint !== previous.configFingerprint ||
    incoming.draftId !== previous.config.draftId
  ) {
    throw new DraftError(
      "prepare-required",
      "Draft configuration changed; prepare data again.",
    );
  }
  const current = previous.accepted?.picks ?? [];
  const extension =
    previous.accepted === null ||
    (incoming.picks.length >= current.length &&
      current.every((pick, i) => samePick(pick, incoming.picks[i])));
  const metadata = {
    lastCheckedAt: incoming.fetchedAt,
    error: null,
    lastRequestSequence:
      incoming.requestSequence ?? previous.lastRequestSequence ?? 0,
  };
  if (!extension) {
    return {
      ...previous,
      ...metadata,
      pending: {
        snapshot: incoming,
        revision: pendingToken(incoming),
        diff: boardDiff(current, incoming.picks),
      },
    };
  }
  const changed = incoming.picks.length !== current.length;
  const corrections = reconcileCorrections(
    previous.corrections,
    incoming.picks,
    previous.config,
  );
  const domainChanged =
    previous.accepted === null ||
    changed ||
    corrections.corrections.length !== previous.corrections.length;
  return {
    ...previous,
    ...metadata,
    accepted: incoming,
    pending: null,
    ...corrections,
    // Retain a notice through ordinary unchanged polling so it can be read.
    notices: corrections.notices.length
      ? corrections.notices
      : previous.notices,
    revision: previous.revision + Number(domainChanged),
    lastChangedAt: changed ? incoming.fetchedAt : previous.lastChangedAt,
  };
}

export function deriveEffectiveDraft(state, config = state.config) {
  const picks = state.accepted?.picks ?? [];
  const officialOwn = picks.filter((pick) => pick.rosterId === config.rosterId);
  const localOwn = state.corrections.filter(
    (correction) => correction.type === "my-pick",
  );
  const occupied = new Set([
    ...officialOwn.map((pick) => pick.pickNo),
    ...localOwn.map((pick) => pick.pickNo),
  ]);
  const ownRecords = [
    ...officialOwn.map((pick) => ({ ...pick, local: false })),
    ...localOwn.map((pick) => ({
      ...pick,
      rosterId: config.rosterId,
      local: true,
    })),
  ].sort((a, b) => a.pickNo - b.pickNo);
  const remainingPicks = ownPickSchedule(config).filter(
    (pick) => !occupied.has(pick),
  );
  return {
    availabilityKnown: state.accepted !== null,
    configFingerprint: state.configFingerprint,
    prepareRequired:
      state.prepareRequired === true ||
      state.configFingerprint !== configFingerprint(config),
    ownPlayerIds: ownRecords.map((pick) => pick.playerId),
    ownRecords,
    unavailableIds: [
      ...new Set([
        ...picks.map((pick) => pick.playerId),
        ...state.corrections.map((pick) => pick.playerId),
      ]),
    ],
    observedCount: picks.length,
    remainingPicks,
    nextPicks: remainingPicks.slice(0, 2),
    status: state.accepted?.status ?? null,
    corrections: state.corrections,
    pending: state.pending,
    notices: state.notices,
  };
}

export function applyLocalAction(state, action) {
  if (!action || !Number.isInteger(action.expectedRevision)) {
    throw new DraftError("invalid-action", "An expectedRevision is required.");
  }
  if (action.expectedRevision !== state.revision) {
    throw new DraftError(
      "obsolete-revision",
      "The board changed. Review the current board before acting.",
      409,
    );
  }
  const next = { ...state, revision: state.revision + 1, notices: [] };
  if (action.type === "undo") {
    if (
      !state.corrections.some(
        (correction) => correction.id === action.correctionId,
      )
    ) {
      throw new DraftError(
        "invalid-action",
        "That local correction no longer exists; official picks cannot be undone here.",
      );
    }
    return {
      ...next,
      corrections: state.corrections.filter(
        (correction) => correction.id !== action.correctionId,
      ),
    };
  }
  if (action.type === "accept-pending") {
    if (!state.pending || action.pendingRevision !== state.pending.revision) {
      throw new DraftError(
        "invalid-action",
        "The pending board changed. Review its current version.",
      );
    }
    const { snapshot, diff } = state.pending;
    const cleared = state.corrections.filter(
      (correction) =>
        correction.type === "taken" ||
        correction.pickNo >= diff.firstChangedPick,
    );
    const remaining = state.corrections.filter(
      (correction) => !cleared.includes(correction),
    );
    const official = reconcileCorrections(
      remaining,
      snapshot.picks,
      state.config,
    );
    return {
      ...next,
      accepted: snapshot,
      pending: null,
      corrections: official.corrections,
      lastChangedAt: snapshot.fetchedAt,
      notices: [
        ...cleared.map((correction) => ({
          kind: "cleared",
          correctionId: correction.id,
          message: `Cleared local ${correction.type} for ${correction.playerId} while adopting the reviewed Sleeper board.`,
        })),
        ...official.notices,
      ],
    };
  }
  if (!["taken", "my-pick"].includes(action.type))
    throw new DraftError("invalid-action", "Unknown local action.");
  if (
    typeof action.playerId !== "string" ||
    !Object.hasOwn(state.playersById, action.playerId)
  ) {
    throw new DraftError(
      "invalid-action",
      "Unknown player identity. Prepare current player data.",
    );
  }
  const effective = deriveEffectiveDraft(state);
  if (effective.unavailableIds.includes(action.playerId))
    throw new DraftError("invalid-action", "That player is already taken.");
  if (
    action.type === "my-pick" &&
    (!Number.isInteger(action.pickNo) ||
      action.pickNo !== effective.remainingPicks[0])
  ) {
    throw new DraftError(
      "invalid-action",
      "Record only your next unfilled own selection.",
    );
  }
  const correction = {
    id: `local-${next.revision}`,
    type: action.type,
    playerId: action.playerId,
    pickNo: action.type === "my-pick" ? action.pickNo : null,
  };
  return { ...next, corrections: [...state.corrections, correction] };
}
