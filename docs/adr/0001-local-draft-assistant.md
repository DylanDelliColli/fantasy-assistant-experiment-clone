```doc-meta
role: contract
lifecycle: active
```

# ADR 0001: Local Sleeper draft assistance

Status: Accepted and reviewed 2026-09-08; local application and isolated rehearsal implemented.
Authority: operator-approved FRAMING, revised RESEARCH at `308192c`,
ARCHITECTURE at `50973fe`, and TEST-STRATEGY at `dbb58c3`.
The operator approved architecture and then authorized completion of all
remaining planning phases without further approval pauses. The archived
sections are available with `git show <commit>:PLANNING-fantasy-p55.md`.

## Purpose and smallest release

The local application and isolated fixture rehearsal now run from this repository.
This decision defines their source, roster, and draft-state rules.
The beneficiary is Kijuuu, drafting on Sleeper. Human choice speed remains unmeasured.

No NORTH-STAR.md exists. Scope authority is the approved framing, not an
invented thesis: “Prioritize draft assistance and fast consultation during the
draft” and “Recommendations only. The operator makes picks in Sleeper.”
The smallest release is a browser shortlist beside Sleeper, using actual
league settings, three available candidates with reasons, the own roster,
next two picks, and honest freshness with a retained usable board on failure.

Stories: US-DRAFT-01 preparation, US-DRAFT-02 rapid consultation and turn
updates, US-DRAFT-03 freshness/recovery. US-SEASON-01 is future direction.
No automatic picks/transactions, weekly lineups/waivers/trades, other formats,
multi-user hosting, multi-league dashboard, or new projection model.

The product metric is a preferred available choice within ten seconds in
each human rehearsal at picks 1,28,29, including an opponent taking a previous
recommendation. Automated checks do not measure human choice speed.

## Confirmed league

League `1389330057733865472`; draft `1389330057733865473`;
user `1264288993504149504` / Kijuuu; owner roster 5; draft slot 1.
Season 2026; 14-team half-PPR; four-point passing touchdowns; snake, 13 rounds;
QB, RB, RB, WR, WR, TE, FLEX, K, DEF, four bench, one reserve.
The active draft's rounds=13 is authoritative; league draft_rounds=3 is a
different field. Reserve does not add a draft selection. Verified own picks:
1,28,29,56,57,84,85,112,113,140,141,168,169.

Read actual configuration at preparation/startup, retain its scoring map,
and reject unsupported shape, ownership changes, assigned keepers or traded
picks with an explicit reason. A fingerprint covers league/draft/user/roster
IDs, season/sport/type, teams/rounds/reversal, ordered roster slots, scoring
map, draft-order and slot mappings, keeper assignments and traded picks.
Canonicalize map keys; omit display labels, fetch times, pick counts and status.

## Runtime and ownership

Use Node 24 ESM with built-in HTTP/filesystem support and a plain browser at
`http://127.0.0.1:3000`. Production has no framework, database, subscription
or model-call dependency. `npm run prepare` prepares private data;
`npm start` runs the single local process. Bind to loopback.

| Planned owner | Contract |
| --- | --- |
| scripts/prepare-data.mjs; src/data/sources.mjs | prepareData(options): retrieve, normalize, validate, then publish one snapshot or retain the old one. |
| src/data/identity.mjs | matchEcrPlayers: deterministic source-to-Sleeper joins and quarantine. |
| src/data/snapshot.mjs | loadSnapshot and writeJsonAtomic: schema checks and same-directory temporary-file rename. |
| src/sleeper/client.mjs | loadContext and fetchDraftSnapshot: real HTTP, identifiers/configuration, complete pick validation, deadlines. |
| src/draft/state.mjs | reconcileDraft, applyLocalAction, deriveEffectiveDraft: accepted and pending snapshots, corrections and schedule. |
| src/draft/roster.mjs; src/draft/recommend.mjs | assignRoster and recommend: deterministic matching, completion checks, ranked shortlist and evidence. |
| src/session.mjs | openSession -> getBoard/refresh/act/close: single owner of revisions, polling, locking, durable state and board construction. |
| src/server.mjs | createApp({session}): fixed HTTP routes and static files; no duplicated domain calculations. |
| src/contracts.mjs | Shared JSDoc record shapes and schema/policy versions; not a second validation engine. |
| web/index.html; web/app.mjs; web/styles.css | Render BoardView, filters and local actions; no independent roster/ranking logic. |

`Snapshot` version 1 contains snapshotId, preparedAt, config/fingerprint,
sources, playersById, rankingMode and importReport. Players retain all fantasy
eligibility, canonical policyPosition, source-specific values/times, and
nullable ECR/ADP/projection/history/injury fields. `DraftState.accepted` is null
until a validated or saved snapshot exists. An accepted snapshot with picks=[]
is known empty and supports normal pick-1 recommendations. State also contains
pending non-extension, corrections, revision and freshness/error metadata.
`BoardView` carries schema version, revision, sessionId, viewRevision, source mode, league/draft summary, own
roster/next picks, candidates/reasons, searchable players, corrections, pending
change and distinct source/check/change/connection information.

The persisted `revision` is the domain token used by action expectedRevision.
Each openSession creates a new sessionId and viewRevision counter. Every
observable board change advances viewRevision, including unchanged successful
checks, immediate error/recovery, pending metadata and committed actions.
Metadata-only updates leave the durable revision unchanged, avoiding action
conflicts caused by freshness display updates.

## Source preparation

Sleeper is primary for identity, context, picks, ADP, projections and history.
Use [documented v1 state routes](https://docs.sleeper.com/), the verified
[expanded 2026 projection route](https://api.sleeper.app/projections/nfl/2026?season_type=regular)
and optional [2025 actual-stat route](https://api.sleeper.app/stats/nfl/2025?season_type=regular).
The projection/stat routes are undocumented: validate responses and retain
last usable data. Derive requested season from the league; preserve row update
times separately from fetch times. No derived per-game statistic from gp.

Cache the player map for 24 hours, retaining original fetch time even when
importing today's research download. Keep all identities for interpreting
picks. Automatic candidates require active=true, a current NFL team, supported
fantasy eligibility and a usable rank/ADP. DEF identity is its team key.
Missing/nonfinite/nonpositive/sentinel-999 ADP is null; missing points are null,
numeric zero remains zero. Provider half-PPR points are labeled context, not
an exact custom-league score or cross-position draft value.

Require at least 400 eligible usable-ADP identities and minima of 14 QB,
42 RB,42 WR,14 TE,14 K,14 DEF. Failure preserves the previous snapshot.
Keep raw sources and normalized data in Git-ignored `.local/`, never public
assets; atomic publication must not expose partial JSON.

An optional private [FantasyPros half-PPR snapshot](https://www.fantasypros.com/nfl/rankings/half-point-ppr-cheatsheets.php)
supplies independent ECR ranks/tiers. Extract JSON without executing scripts;
validate year/week/scoring, unique IDs/ranks and unique top-400 joins. Any
unresolved or ambiguous top-400 join invalidates the entire optional ECR
import, selecting labeled ADP-only mode; only lower ranks are quarantined.
Normalize names/suffixes/diacritics, position/team aliases, and DEF team keys;
never fuzzy-match ambiguity. Reviewed aliases: FP18226 -> Sleeper5848
(Hollywood/Marquise Brown), FP24901 -> Sleeper8122 (Bam/Zonovan Knight).
Quarantine unresolved lower ranks. Invalid/unavailable optional ECR selects
explicit ADP-only mode; historical-stat failure does not invalidate current
ADP. Do not redistribute private provider snapshots or introduce paid access.

## Recommendation policy draft-v1

Exclude accepted picks and local taken/own-pick corrections. Use every fantasy
position for maximum roster matching: one player fills one slot, FLEX accepts
RB/WR/TE, dedicated slots precede FLEX on equal matches, then stable ties.
A candidate must permit all starters to be filled with remaining selections
and distinct remaining players. Never pad with rejected candidates.

Each player has one policyPosition: eligible supported Sleeper primary
position, else first supported eligible QB,RB,WR,TE,K,DEF. Caps count this once:
do not add a second K/DEF or third QB/TE; existing excess does not reject an
unrelated position. Defer backup QB/TE while offense has holes unless the
candidate fills an offensive starter. Defer K/DEF until the last two selections,
unless completion forces them earlier; deferral is ordering, not exclusion.

Deferral is the outermost key: ordinary, backup QB/TE, then early K/DEF.
Within each group, order ECR by tier, starter fit, ECR rank, ADP, ID.
Missing ECR follows ranked candidates within that group by ADP; no fabricated tier.
ADP-only mode uses fixed groups of 12 ordinal places over the prepared eligible
ADP pool, then starter fit, exact ADP, ID. Exclusions never move the bands.
Show at most three distinct surviving candidates with source values and roster
reasons. Projections/history/injury labels are context; no invented health
claims, injury penalties, survival percentages or raw-points draft ordering.

Unknown initial pick availability or unresolved own identity/configuration
disables confident personalized advice while preserving browsing. No feasible
completion returns a specific unavailable reason. No remaining own selections
returns a completed summary. A local own-pick at 28 immediately recomputes
roster and next selections [29,56], without fabricating missing opponent picks.

## Accepted state and correction rules

Read full draft/pick snapshots; normalize IDs as strings and structural numbers
as validated integers. Pick roster_id is authoritative; absent roster_id uses
verified slot mapping, never picked_by alone. Validate unique pick numbers and
players, legal round/slot/range and contiguous picks; sort unordered rows, reject
actual gaps. Unknown opponent IDs are still unavailable.

Accept an initial snapshot or a strict unchanged-prefix extension. An unchanged
response updates check metadata, not proof of live feed freshness. Smaller or
changed earlier picks remain pending with a diff because cached data and an
actual commissioner undo cannot be distinguished. “Use this Sleeper board”
accepts only the exact reviewed pending revision; shape changes require prepare.

Local actions carry expectedRevision: taken(playerId), my-pick(playerId,pickNo),
undo(correctionId), accept-pending(pendingRevision). Taken excludes only; an own
pick must occupy the next unfilled own selection and affects effective roster
and next picks. Reject duplicate/unknown players, invalid or out-of-order slots
and obsolete revisions. Official confirmation retires a correction once.
Conflicting accepted official ownership wins with a specific notice. On reviewed
rollback adoption, clear own corrections at/after first changed pick and all
unassigned taken markers, reporting what was cleared. Undo never reverses an
official Sleeper pick. Every upstream operation is GET-only.

Poll one shared cycle every five seconds after success; four-second deadlines
per draft/picks request; failures delay 10,20,40,60 seconds capped at 60, honoring
a longer valid Retry-After. Manual requests join the cycle and respect retry
deadlines. Complete drafts poll every 30 seconds to detect reopen. Discard an
obsolete fetch completed after a newer action/revision. A 200 does not guarantee
Sleeper freshness; no countdown is inferred from scheduled start.

Serialize actions, accepted state and persistence under one session owner.
Persist version/config/revision/picks/corrections to
`.local/drafts/<draftId>/session.json`. A process lock excludes a second writer;
reclaim only after proving its PID dead. Restart restores valid saved state as
stale before refreshing. Invalid files are preserved with a recovery message.
Failed writes retain prior durable state and never acknowledge an unsaved action.

## Browser and local HTTP

The page shows actual league/roster settings, three cards with brief reasons,
own roster, next two picks, source ages and observed count. Search/position
filters, detail values, Mark taken, Record my pick, Undo, Refresh and pending
change review are keyboard-operable. Render provider strings as text.

GET /api/board returns the in-memory BoardView immediately with no-store;
POST /api/refresh starts/joins bounded work and returns promptly;
POST /api/actions persists a valid action and returns the new board, with 409
for obsolete revision, 422 for invalid action and structured disk failure.
Bodies are limited to 16KiB. Allow only /, /index.html, /app.mjs, /styles.css as
static paths. Reject foreign Host/Origin on mutations, malformed bodies,
unknown methods/routes, path traversal and private file access. No generic proxy.

The visible browser reads the board each second with one read in flight
and on window focus/visibility return, coalescing overlapping triggers. Reads
and actions have increasing client request sequences. For the current
sessionId, apply only newer viewRevision regardless of request start order.
Reject retired session IDs. Switch to an unseen session only if its request
sequence exceeds the maximum applied request sequence, permitting a lower
view counter and retiring the old session ID. Maintain that maximum with
Math.max so a slow newer same-session action cannot lower it. This prevents
old responses across restart without discarding a committed action behind a
later-started metadata read. Preserve focus on unchanged content and retain
cards on connection failure. Separately
show source update/fetch times, last successful check, last changed picks and
connection health. Failure is immediate. Without a successful check, pre-draft
and active boards are overdue at 15 seconds; completed boards at 40 seconds
to accommodate their healthy 30-second polling cadence and request deadlines.
Observed reopen restores the 15-second threshold. Normal status says checked
and that Sleeper may lag.

## Verification and tradeoffs

Every code child requires test-first unit and real-composition integration
coverage, as specified in its bead. Ten unit files cover source/identity/context/
snapshot/state/roster/recommendation/session/presentation/rehearsal; five integration files
cover import, sync, disk/process ownership, HTTP and Chromium. Fixtures use
fictional data shaped like the approved league; routine tests use loopback HTTP
and real temp files, not live providers. The complete strategy is archived at
`dbb58c3:PLANNING-fantasy-p55.md` and is carried into implementation beads.

Use one Node test runner plus the Playwright library as a pinned dev dependency.
Full suite budget: 30 seconds including process/browser startup and shutdown.
Empty-runner baseline measured 0.046365766s with zero application tests; proposed
suite estimated 20.796365766s, including the rehearsal helper. Re-measure after implementation. Separate human
rehearsal timing remains unmeasured until performed.

The tradeoffs are explicit: prepared local data gives immediate consultation;
polling permits recovery but cannot remove upstream caching; one process/private
files fit one local user; deterministic ordinal ranking is explainable but does
not estimate true replacement value or an optimized season outcome. Revisit
hosting, season management and richer valuation only with new scope.

## Review evidence

Bloat review ran first in a fresh Claude CLI context (tools disabled),
using the provider-neutral role card; the output reported model
`claude-fable-5-1`. No NORTH-STAR.md exists, so this review explicitly used
the quoted approved frame rather than claiming a north-star clause.

Seven proposed cuts were reviewed under the operator's delegated authority.
All were retained for concrete current costs: removing optional ECR loses the
independent value opinion; removing Chromium loses DOM/action/focus verification;
the projection route is required for Sleeper ADP, and injury/history fields
supply labeled decision context; removing the lock risks two launches writing
the same correction file; removing rollback adoption leaves persisted held
state unrecoverable by a mere restart; ignoring Retry-After harms recovery from
rate limits and completed polling detects reopen; removing order/keeper/trade
fingerprints can silently produce the wrong own-pick schedule.

This was one subtraction review pass, not a mandate to accept every cut.
Automatic approval review initially rejected full-record and de-identified
specification exports; neither rejected call ran. The operator subsequently
authorized the limited de-identified architecture export. A fresh tools-disabled
Claude specification review then completed successfully, reporting
`claude-fable-5-1` and no permission denials.

Its three findings are resolved in this record and implementation tests:
completed polling uses a 40-second overdue threshold instead of the active
15-second threshold; deferral is the outermost rank key, including unranked
candidates; and any unresolved top-400 ECR join selects ADP-only mode for the
whole optional import. The review confirmed schedule and next-pick arithmetic,
test counts/budget arithmetic, and domain/view revisions with HTTP/browser rules.

Review scope was internal consistency of the de-identified technical contract.
It did not inspect implementation, live routes, withheld planning history,
identities or timing measurements. Local checks separately confirmed league/
draft/user ownership, roster/scoring and all own picks against cached research,
and checked child contracts against the approved scope. No live freshness,
application coverage or human timing is claimed by this planning review.

A separate fresh-context backlog reviewer read the durable ADR and all four
implementation contracts without conversation history. Dependency direction,
serial shared footprints and test sequencing passed. Three refinements were
incorporated: null versus accepted-empty availability; separate durable and
presentation revisions with restart/response ordering; and explicit window-focus
refresh. Unit and real browser/HTTP assertions cover each distinction. The
source task also declares README corpus/index registration. This local
same-lineage review and the subsequent Claude specification review cover
different scopes; both are complete with their findings resolved.
