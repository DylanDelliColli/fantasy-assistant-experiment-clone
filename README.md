```doc-meta
role: working
lifecycle: active
```

# Local Sleeper draft assistant

Prepare private, validated draft inputs for Kijuuu's 2026 league. This release
stage implements source preparation; the dependent session/browser work supplies
`npm start` and `npm run rehearse`. No picks or other changes are sent to Sleeper.

Use Node **24.13.1 or newer**. Install the pinned development dependency without
running the npm `prepare` lifecycle (which is the explicit live-data command):

```sh
npm ci --ignore-scripts
export PLAYWRIGHT_BROWSERS_PATH=/tmp/fantasy-experiment-b/playwright-browsers
export PLAYWRIGHT_SKIP_BROWSER_GC=1
npx playwright install chromium
npm test
```

Arm B browser installation and all later Chromium checks must retain both exported
variables. The browser directory is private to this arm. Do not run installation
or garbage collection against the shared default Playwright cache. A successful
isolated browser launch, not merely an existing executable, verifies setup.
Normal installations outside the experiment may choose their own private browser
path and must use that same path during tests.

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
