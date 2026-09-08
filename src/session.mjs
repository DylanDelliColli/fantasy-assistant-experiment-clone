import { readFile, mkdir, readdir, link, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadSnapshot, writeJsonAtomic } from "./data/snapshot.mjs";
import {
  loadContext,
  fetchDraftSnapshot,
  normalizePicks,
} from "./sleeper/client.mjs";
import {
  createDraftState,
  reconcileDraft,
  applyLocalAction,
  deriveEffectiveDraft,
  ownPickSchedule,
  DraftError,
} from "./draft/state.mjs";
import { recommend } from "./draft/recommend.mjs";
import { BOARD_VERSION, DRAFT_STATE_VERSION } from "./contracts.mjs";

export class SessionError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.status = status;
  }
}
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const dateOrNull = (value) =>
  value === null ||
  (typeof value === "string" && Number.isFinite(Date.parse(value)));
const safeError = (error) => ({
  code: error.code ?? "upstream-failed",
  message: error.message,
});

export function pidIsDead(pid, probe = process.kill) {
  try {
    probe(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

// Append-only generation reservations prevent the stale read/unlink race. Every
// contender for a dead/released generation atomically links the SAME next path.
// Close replaces only its own claim with a released tombstone; paths are never
// reused, so a delayed contender cannot remove or replace a later live owner.
async function acquireLock(directory) {
  const lockDir = path.join(directory, "session.lock");
  await mkdir(lockDir, { recursive: true });
  const token = randomUUID();
  for (;;) {
    const generations = (await readdir(lockDir))
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) => Number(name.slice(0, -5)));
    const current = generations.length ? Math.max(...generations) : -1;
    if (current >= 0) {
      let owner;
      try {
        owner = JSON.parse(
          await readFile(path.join(lockDir, `${current}.json`), "utf8"),
        );
      } catch {
        throw new SessionError(
          "session-locked",
          "The session lock cannot be verified.",
          409,
        );
      }
      if (
        !record(owner) ||
        owner.generation !== current ||
        (!owner.released &&
          (!Number.isSafeInteger(owner.pid) ||
            owner.pid <= 0 ||
            typeof owner.token !== "string"))
      )
        throw new SessionError(
          "session-locked",
          "The session lock cannot be verified.",
          409,
        );
      if (owner.released !== true && !pidIsDead(owner.pid))
        throw new SessionError(
          "session-locked",
          "Another process owns this draft session.",
          409,
        );
    }
    const generation = current + 1,
      claim = path.join(lockDir, `${generation}.json`),
      temporary = path.join(lockDir, `.claim-${token}.json`);
    await writeJsonAtomic(temporary, { generation, pid: process.pid, token });
    try {
      await link(temporary, claim);
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return async () => {
      const owner = JSON.parse(await readFile(claim, "utf8"));
      if (owner.token === token && owner.pid === process.pid)
        await writeJsonAtomic(claim, { generation, released: true });
    };
  }
}

function durable(state) {
  return {
    version: DRAFT_STATE_VERSION,
    draftId: state.config.draftId,
    configFingerprint: state.configFingerprint,
    revision: state.revision,
    accepted: state.accepted,
    pending: state.pending,
    corrections: state.corrections,
    notices: state.notices,
    lastCheckedAt: state.lastCheckedAt,
    lastChangedAt: state.lastChangedAt,
  };
}
function validateSavedSnapshot(incoming, snapshot) {
  if (
    !record(incoming) ||
    incoming.draftId !== snapshot.config.draftId ||
    incoming.configFingerprint !== snapshot.configFingerprint ||
    !["pre_draft", "drafting", "paused", "complete"].includes(
      incoming.status,
    ) ||
    !dateOrNull(incoming.fetchedAt) ||
    incoming.fetchedAt === null ||
    !Array.isArray(incoming.picks)
  )
    throw new Error("Invalid saved draft");
  const normalized = normalizePicks(
    incoming.picks.map((p) => ({
      pick_no: p.pickNo,
      round: p.round,
      draft_slot: p.slot,
      roster_id: p.rosterId,
      player_id: p.playerId,
      picked_by: p.pickedBy,
    })),
    snapshot.config,
  );
  if (JSON.stringify(normalized) !== JSON.stringify(incoming.picks))
    throw new Error("Invalid saved picks");
  return {
    draftId: incoming.draftId,
    configFingerprint: incoming.configFingerprint,
    status: incoming.status,
    picks: normalized,
    fetchedAt: incoming.fetchedAt,
  };
}
function restoreState(saved, snapshot) {
  if (
    !record(saved) ||
    saved.version !== DRAFT_STATE_VERSION ||
    saved.draftId !== snapshot.config.draftId ||
    saved.configFingerprint !== snapshot.configFingerprint ||
    !Number.isSafeInteger(saved.revision) ||
    saved.revision < 0 ||
    !Array.isArray(saved.corrections) ||
    !Array.isArray(saved.notices) ||
    !dateOrNull(saved.lastCheckedAt) ||
    !dateOrNull(saved.lastChangedAt)
  )
    throw new Error("Invalid saved session");
  let state = createDraftState(snapshot);
  if (saved.accepted !== null)
    state = reconcileDraft(
      state,
      validateSavedSnapshot(saved.accepted, snapshot),
    );
  if (saved.pending !== null) {
    const pending = validateSavedSnapshot(saved.pending?.snapshot, snapshot);
    state = reconcileDraft(state, pending);
    if (
      !state.pending ||
      state.pending.revision !== saved.pending.revision ||
      JSON.stringify(state.pending.diff) !== JSON.stringify(saved.pending.diff)
    )
      throw new Error("Invalid pending board");
  }
  const ids = new Set(),
    players = new Set(state.accepted?.picks.map((p) => p.playerId) ?? []),
    occupied = new Set(state.accepted?.picks.map((p) => p.pickNo) ?? []),
    ownPicks = new Set(ownPickSchedule(snapshot.config));
  for (const correction of saved.corrections) {
    if (
      !record(correction) ||
      typeof correction.id !== "string" ||
      !/^local-\d+$/.test(correction.id) ||
      !Number.isSafeInteger(Number(correction.id.slice(6))) ||
      Number(correction.id.slice(6)) < 1 ||
      Number(correction.id.slice(6)) > saved.revision ||
      ids.has(correction.id) ||
      !["taken", "my-pick"].includes(correction.type) ||
      typeof correction.playerId !== "string" ||
      !Object.hasOwn(snapshot.playersById, correction.playerId) ||
      players.has(correction.playerId) ||
      (correction.type === "taken" && correction.pickNo !== null) ||
      (correction.type === "my-pick" &&
        (!ownPicks.has(correction.pickNo) || occupied.has(correction.pickNo)))
    )
      throw new Error("Invalid saved correction");
    ids.add(correction.id);
    players.add(correction.playerId);
    if (correction.type === "my-pick") occupied.add(correction.pickNo);
  }
  // Undo can leave gaps or reverse chronological pick order. Saved records
  // must satisfy state invariants, not the next-pick rule for a new action.
  if (saved.revision < state.revision + saved.corrections.length)
    throw new Error("Invalid saved revision");
  if (
    !saved.notices.every(
      (n) =>
        record(n) &&
        typeof n.kind === "string" &&
        typeof n.correctionId === "string" &&
        typeof n.message === "string",
    )
  )
    throw new Error("Invalid saved notices");
  return {
    ...state,
    revision: saved.revision,
    corrections: saved.corrections,
    notices: saved.notices,
    lastCheckedAt: saved.lastCheckedAt,
    lastChangedAt: saved.lastChangedAt,
    error: null,
  };
}

export function connectionHealth(
  { status, lastCheckedAt, openedAt, restored = false, error = null },
  now,
) {
  const since =
    lastCheckedAt === null || lastCheckedAt === undefined
      ? openedAt
      : Date.parse(lastCheckedAt);
  const overdue = now - since >= (status === "complete" ? 40000 : 15000);
  return {
    status: error
      ? "error"
      : restored
        ? "stale"
        : overdue
          ? "overdue"
          : lastCheckedAt
            ? "checked"
            : "checking",
    overdue,
    error,
  };
}
function retryDelay(error, failures, now) {
  const backoff = Math.min(60000, 10000 * 2 ** Math.min(failures - 1, 3));
  const raw = error.retryAfter;
  let provider = 0;
  if (typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw.trim()))
    provider = Number(raw) * 1000;
  else if (typeof raw === "string" && Number.isFinite(Date.parse(raw)))
    provider = Date.parse(raw) - now;
  const delay = Math.max(backoff, provider);
  return Number.isFinite(delay) &&
    Number.isFinite(new Date(now + delay).getTime())
    ? delay
    : backoff;
}

export async function openSession(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? ".local");
  const snapshot = await loadSnapshot(path.join(dataDir, "snapshot.json"));
  const directory = path.join(dataDir, "drafts", snapshot.config.draftId);
  await mkdir(directory, { recursive: true });
  const releaseLock = await acquireLock(directory),
    file = path.join(directory, "session.json");
  const now = options.now ?? (() => new Date()),
    scheduler = options.scheduler ?? { setTimeout, clearTimeout };
  const openedAt = now().getTime(),
    sessionId = randomUUID();
  let state = createDraftState(snapshot),
    restored = false,
    recovery = null;
  try {
    state = restoreState(JSON.parse(await readFile(file, "utf8")), snapshot);
    restored = true;
  } catch (error) {
    if (error.code !== "ENOENT")
      recovery = new SessionError(
        "state-recovery",
        "Saved session is invalid. Preserve it and restore or remove it before saving changes.",
        409,
      );
  }
  let closed = false,
    closing = null,
    flight = null,
    timer = null,
    retryAt = null,
    failures = 0,
    sequence = 0,
    contextNeeded = true,
    error = recovery ? safeError(recovery) : null;
  let queue = Promise.resolve(),
    viewRevision = 0,
    lastBoard = null,
    healthKey = null,
    cachedRecommendation = null,
    recommendationKey = null;
  const controllers = new Set();
  const serialize = (operation) => {
    const pending = queue.then(operation);
    queue = pending.catch(() => {});
    return pending;
  };
  function buildBoard() {
    const effective = deriveEffectiveDraft(state),
      key = `${state.revision}:${state.prepareRequired === true}`;
    if (recommendationKey !== key) {
      cachedRecommendation = recommend(snapshot, effective);
      recommendationKey = key;
    }
    const connection = {
      ...connectionHealth(
        {
          status: state.accepted?.status,
          lastCheckedAt: state.lastCheckedAt,
          openedAt,
          restored,
          error,
        },
        now().getTime(),
      ),
      inFlight: flight !== null,
      retryAt: retryAt === null ? null : new Date(retryAt).toISOString(),
    };
    const currentHealth = JSON.stringify(connection);
    if (healthKey !== currentHealth) {
      healthKey = currentHealth;
      viewRevision++;
    }
    lastBoard = {
      ...cachedRecommendation,
      version: BOARD_VERSION,
      revision: state.revision,
      sessionId,
      viewRevision,
      rankingMode: snapshot.rankingMode,
      preparedAt: snapshot.preparedAt,
      sources: snapshot.sources,
      league: { name: snapshot.leagueName, ...snapshot.config },
      draft: {
        draftId: snapshot.config.draftId,
        status: state.accepted?.status ?? null,
        observedCount: effective.observedCount,
      },
      availabilityKnown: effective.availabilityKnown,
      ownRecords: effective.ownRecords,
      unavailableIds: effective.unavailableIds,
      corrections: state.corrections,
      pending: state.pending,
      notices: state.notices,
      lastCheckedAt: state.lastCheckedAt,
      lastChangedAt: state.lastChangedAt,
      connection,
    };
    return lastBoard;
  }
  function publish() {
    viewRevision++;
    return buildBoard();
  }
  function getBoard() {
    return structuredClone(buildBoard());
  }
  async function persist(next) {
    if (recovery) throw recovery;
    try {
      await options.beforePersist?.(durable(next));
      await writeJsonAtomic(file, durable(next));
    } catch (cause) {
      throw new SessionError(
        "persistence-failed",
        "The change could not be saved. Previous durable state was retained.",
      );
    }
  }
  function bounded(operation) {
    const controller = new AbortController();
    controllers.add(controller);
    const deadline = scheduler.setTimeout(
      () =>
        controller.abort(
          new SessionError(
            "upstream-timeout",
            "Sleeper did not respond within four seconds.",
          ),
        ),
      4000,
    );
    // The transport receives this signal and must settle on abort. Await it so
    // deadlines and close cannot leave live HTTP work behind a settled race.
    return Promise.resolve()
      .then(() => operation(controller.signal))
      .catch((cause) => {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw cause;
      })
      .finally(() => {
        scheduler.clearTimeout(deadline);
        controllers.delete(controller);
      });
  }
  function schedule(delay) {
    if (timer !== null) scheduler.clearTimeout(timer);
    const dueAt = now().getTime() + delay;
    retryAt = dueAt;
    // Node overflows delays above 2^31-1ms. Keep the full deadline and arm
    // bounded portions so a long valid Retry-After cannot retry early or stall.
    const arm = () => {
      if (closed) return;
      timer = scheduler.setTimeout(
        () => {
          timer = null;
          if (now().getTime() < dueAt) arm();
          else refresh();
        },
        Math.min(2147483647, Math.max(0, dueAt - now().getTime())),
      );
    };
    arm();
  }
  function refresh({ context = false } = {}) {
    if (closed) return Promise.resolve(getBoard());
    if (context) contextNeeded = true;
    if (flight) return flight;
    if (failures > 0 && retryAt !== null && now().getTime() < retryAt)
      return Promise.resolve(getBoard());
    if (timer !== null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
    const baseRevision = state.revision,
      requestSequence = ++sequence;
    const run = async () => {
      try {
        if (closed) return getBoard();
        if (contextNeeded) {
          const contextResult = await bounded((signal) =>
            (options.readContext ?? loadContext)({
              ...options,
              league: snapshot.config.leagueId,
              user: snapshot.config.userId,
              signal,
            }),
          );
          if (contextResult.configFingerprint !== snapshot.configFingerprint)
            throw new SessionError(
              "prepare-required",
              "League or draft configuration changed. Prepare data again.",
              422,
            );
          contextNeeded = false;
        }
        const incoming = await bounded((signal) =>
          (options.readDraft ?? fetchDraftSnapshot)(snapshot.config, {
            ...options,
            now,
            signal,
          }),
        );
        await serialize(async () => {
          if (closed) return;
          if (!recovery && baseRevision === state.revision) {
            const next = reconcileDraft(state, {
              ...incoming,
              baseRevision,
              requestSequence,
            });
            await persist(next);
            state = next;
            restored = false;
            error = null;
            publish();
          }
          failures = 0;
          schedule(state.accepted?.status === "complete" ? 30000 : 5000);
        });
      } catch (cause) {
        await serialize(async () => {
          if (closed) return;
          if (!recovery) {
            const needsPrepare = cause.code === "prepare-required";
            if (needsPrepare) {
              state = { ...state, prepareRequired: true };
              error = {
                code: "prepare-required",
                message:
                  "League or draft configuration changed. Prepare data again.",
              };
            } else
              error =
                cause instanceof SessionError
                  ? safeError(cause)
                  : {
                      code: "upstream-failed",
                      message:
                        "Sleeper could not be checked. The previous board is retained.",
                    };
          }
          failures++;
          schedule(retryDelay(cause, failures, now().getTime()));
          publish();
        });
      } finally {
        flight = null;
        publish();
      }
      return getBoard();
    };
    // Defer run one microtask so every synchronous caller joins this same promise.
    flight = Promise.resolve().then(run);
    publish();
    return flight;
  }
  async function act(request) {
    return serialize(async () => {
      if (closed)
        throw new SessionError(
          "session-closed",
          "This session is closed.",
          409,
        );
      if (recovery) throw recovery;
      if (state.prepareRequired)
        throw new SessionError(
          "prepare-required",
          "Prepare current configuration before recording changes.",
          422,
        );
      const next = applyLocalAction(state, {
        ...request?.action,
        expectedRevision: request?.expectedRevision,
      });
      try {
        await persist(next);
      } catch (cause) {
        error = safeError(cause);
        publish();
        throw cause;
      }
      state = next;
      if (error?.code === "persistence-failed") error = null;
      publish();
      return getBoard();
    });
  }
  function close() {
    if (closing) return closing;
    closed = true;
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = null;
    for (const controller of controllers)
      controller.abort(
        new SessionError("session-closed", "Session closed.", 409),
      );
    closing = (async () => {
      await flight;
      await queue;
      await releaseLock();
    })();
    return closing;
  }
  buildBoard();
  refresh({ context: true });
  return { getBoard, refresh, act, close };
}
