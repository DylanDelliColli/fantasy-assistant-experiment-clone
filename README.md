```doc-meta
role: working
lifecycle: active
```

# Local Sleeper draft assistant

Prepare private, validated draft inputs for Kijuuu's 2026 league and open a compact
three-player shortlist beside Sleeper. The browser shows your roster, next two
picks, source values and honest freshness. All corrections stay in this assistant;
make every official selection in Sleeper. No picks or other changes are sent there.

Use Node **24.13.1 or newer**. Install the pinned development dependency without
running the npm `prepare` lifecycle (which is the explicit live-data command):

```sh
npm ci --ignore-scripts --cache .local/npm-cache
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/playwright-browsers"
export PLAYWRIGHT_SKIP_BROWSER_GC=1
npx playwright install chromium
npm test
```

Keep both exported variables set for installation and tests. Choose a private
browser directory and use the same path each time. The experiment uses
`/tmp/fantasy-experiment-b/playwright-browsers` and an arm-local npm cache instead
of the portable paths above. Never install or garbage-collect another user's or
arm's browser cache. `npm test` exercises the actual Chromium executable; an
existing file alone does not verify browser setup. Production needs no framework,
external fonts, analytics, paid service or browser automation dependency.

Prepare the supplied live league:

```sh
npm run prepare
npm run prepare -- --without-ecr
npm run prepare -- --league 1389330057733865472 --user Kijuuu --data-dir .local
```

`--players-file PATH --players-fetched-at ISO_TIMESTAMP` imports an already-fetched
player map and retains its original fetch time. The flags must be supplied
together; the map must be less than 24 hours old. On 2026-09-08 the first import
can reuse the approved research player map, fetched around 16:28 UTC, if available.
Later imports use the private cache; missing research files do not prevent normal
operation. Tests use fictional players, real loopback HTTP, and temporary files.
The complete `npm test` wall-clock budget is 30 seconds.

The ignored `.local/` directory contains raw sources in `sources/` and the atomic
`snapshot.json`. Failed required imports preserve the previous snapshot byte for
byte. Do not commit or publish provider data, caches, browser artifacts, or local
session state. A custom `--data-dir` is also private and must be excluded from any
repository or publication destination chosen by the operator.

Sources are Sleeper's GET-only league/user/draft/rosters/picks/traded-picks and
player endpoints, expanded season projections, optional previous-season actual
stats, and optional FantasyPros half-PPR ECR. Years come from the league season.
Projection/stat routes are undocumented and validated on each import. The compact
projection endpoint and FFC are unused. No paid service is required.

Candidate identity requires an active player, current NFL team, supported fantasy
eligibility, and usable ADP or a validated ECR rank. The separate ADP coverage gate
requires at least 400 eligible identities plus the position floors in the accepted
[design](docs/adr/0001-local-draft-assistant.md). Fixed ADP bands contain 12 ordinal
places; rank-only players have no ADP band. ECR never changes policy position.
Any unresolved top-400 ECR join selects explicit `adp-only` mode for the whole
import; lower unmatched rows are quarantined. Historical-stat failure leaves
current sources usable. Import warnings and quarantine reasons are retained.

Provider half-PPR projection/history points are labeled context, not exact custom
league scoring or cross-position draft value. Numeric zero is real; missing values
remain null. No per-game value is derived from `gp`. Snapshots keep source URLs,
seasons, scoring, fetch times and separate original update times. The league display
name is stored outside the configuration fingerprint for offline presentation.

Start the local process after preparation:

```sh
npm start
npm start -- --port 3001 --data-dir .local
```

Open **http://127.0.0.1:3000** beside Sleeper (or the port printed at startup).
The server binds to loopback only. The board returns immediately while one shared background
cycle checks Sleeper. A successful check does not prove Sleeper is current.
Active drafts poll five seconds after success; completed drafts poll every
30 seconds. Each upstream operation has a four-second deadline. Failures retain
the board, show an immediate error, and retry after 10/20/40/60 seconds, honoring
a longer Retry-After. Manual refresh cannot bypass an error retry deadline.

`POST /api/refresh` accepts JSON `{}` or `{"context":true}` and returns 202.
The latter also rechecks the league/user/roster context. `POST /api/actions`
accepts `{"expectedRevision": NUMBER, "action": ACTION}`; action types are
`taken`, `my-pick`, `undo`, and `accept-pending`. A successful action is saved
before its response. Use the current domain `revision`; `sessionId` and
`viewRevision` are separate display-order fields. These routes require the local
Host and, when supplied, exact local Origin. No provider write/proxy route exists.

State lives in `.local/drafts/<draftId>/session.json`. Restart restores saved
picks/corrections as stale until a successful check. No prior accepted board
means unknown availability; a validated saved empty draft means known empty.
Configuration drift, including season type, requires preparation and restart.
Corrupt or mismatched session files remain unchanged with a recovery message;
stop the process and restore a valid file, or preserve a copy outside the active
session path before deliberately starting a fresh session. Do not remove a live
process's ownership records.

`session.lock/` contains numbered ownership claims. A dead PID permits a new
atomic claim; permission-denied PID checks never imply death. Close replaces only
its own claim with a released marker. Small generation markers remain so late
stale observers cannot overwrite a newer owner. SIGINT/SIGTERM stop the server,
abort and settle active HTTP work, drain pending saves, and release ownership.

## Using the board

The shortlist contains up to three available players, with source rank/ADP and a
roster reason supplied by the draft engine. An unavailable or incomplete source
state can show fewer candidates and an explicit explanation. Search by name/team
or filter by position; the first 40 matches are shown, so narrow the search for
long lists. Details separate Sleeper half-PPR projection, prior actual points,
expert rank/tier, and provider injury information. Missing injury information is
unknown, never a healthy designation.

Use **Record my pick** for the displayed next own selection. At 28, a saved local
pick immediately changes the next picks to 29 and 56 and recomputes the shortlist,
even before the feed confirms it. **Mark taken** only excludes a player locally.
**Undo** removes a local correction; it cannot reverse an official Sleeper pick.
These labeled controls work with Tab and Enter. A second tab shares the same
server poller and corrections.

Official confirmation retires matching local records without duplicating the
roster. Conflicting official ownership takes precedence and produces a notice.
A smaller or changed earlier feed remains pending: review the displayed pick diff
and choose **Use this Sleeper board** only for the version you intend to adopt.
Adoption can clear affected own corrections and all unassigned taken markers.
An obsolete action refetches the board for your review and is never retried
automatically. A validation or save failure shows an explanation; a failed disk
write never receives saved feedback. If the connection drops during a save,
inspect current corrections after reconnecting before attempting it again.

The page reads the local board once per second while visible and on window focus
or visibility return. Unchanged checks preserve controls and keyboard focus.
Source **Updated** and **Fetched**, **App board read**, **Last successful check**,
and **Last changed picks** have separate meanings and timestamps. Ages continue
advancing on the page without a domain change. Checked means a successful request,
and Sleeper may still lag. An upstream or app connection failure keeps the usable
cards visible. Active/pre-draft checks become overdue after 15 seconds; completed
drafts use 40 seconds to allow their 30-second cadence. No live-feed guarantee,
scheduled-start countdown or survival probability is inferred.

## Isolated rehearsal

```sh
npm run rehearse
```

Open the printed free loopback URL. The heading starts **REHEARSAL**. This launcher
uses fictional players and rankings under the approved league shape, its own
fixture HTTP server, and temporary files outside `.local`. It never reads or writes
your live state or requests real providers. It runs the same browser, session and
draft engine as the normal app; this is a manual test fixture, not a strategy simulator.

1. Choose any available player at pick 1 using **Record my pick**; press Enter in
   the terminal to confirm that chosen player in the fixture feed.
2. Press Enter again to advance opponent picks through 27. An opponent takes a
   previous recommendation. Review the changed shortlist.
3. Choose at 28 in the browser. Review the immediate roster and next-pick change,
   then press Enter in the terminal to confirm. Read the refreshed board.
4. Choose at 29 and press Enter to confirm. Type `q` and Enter, or press Ctrl+C,
   to close the owned servers and remove the temporary state.

Advancing before the required own choice prints an instruction and preserves the
stage. The fixture reads the actual selected player from its saved state. To return
to live use, close the rehearsal tab and reopen the normal `npm start` URL; if that
process is stopped, run it again with your prepared private data directory.

The product target is a preferred available choice within ten seconds at each of
1, 28 and 29. **Human choice speed remains unmeasured.** Automated browser/test
duration does not measure that target.

## Pre-draft checklist and verification

- Prepare current data and inspect warnings, season, ranking mode and source ages.
- Start the app; verify the displayed team count, scoring, roster slots and own
  pick schedule against Sleeper. A configuration change requires prepare/restart.
- Run the rehearsal, including the opponent removal and consecutive turns.
- Return to the live tab, use Refresh and read connection/check status. Keep
  Sleeper available for official picks and verify local correction notices.

`npm test` runs unit tests and real HTTP/filesystem/process/Chromium integration
with fictional fixtures and one browser launch. The complete wall-clock budget is
30 seconds. Browser response races use barriers, and cadence tests use logical
clocks; no fixed sleep decides success. Failure screenshots are ignored under
`test-results/`. Documentation changes also use `docs-doctor --repo . --json`,
`br lint --status all` and `git diff --check`.
