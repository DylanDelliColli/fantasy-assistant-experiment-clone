import http from "node:http";
import { context, pool } from "../fixtures/sleeper.mjs";
import { rankings, html } from "../fixtures/rankings.mjs";
export async function upstream(t) {
  const c = context(),
    p = pool(),
    log = [];
  const routes = {
    "/v1/user/Kijuuu": c.user,
    [`/v1/league/${c.league.league_id}`]: c.league,
    [`/v1/league/${c.league.league_id}/rosters`]: c.rosters,
    [`/v1/draft/${c.draft.draft_id}`]: c.draft,
    [`/v1/draft/${c.draft.draft_id}/picks`]: c.picks,
    [`/v1/draft/${c.draft.draft_id}/traded_picks`]: c.tradedPicks,
    "/v1/players/nfl": p.players,
    "/projections/nfl/2026?season_type=regular": p.projections,
    "/stats/nfl/2025?season_type=regular": p.history,
    "/ecr": html(rankings(p.players)),
  };
  const server = http.createServer((req, res) => {
    log.push({ method: req.method, url: req.url });
    const value = routes[req.url];
    if (value === undefined || value instanceof Error) {
      res.writeHead(value?.status ?? 503);
      res.end("upstream unavailable");
    } else {
      res.setHeader(
        "content-type",
        typeof value === "string" ? "text/html" : "application/json",
      );
      res.end(typeof value === "string" ? value : JSON.stringify(value));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    c,
    p,
    routes,
    log,
    options: {
      baseUrl: base,
      ecrUrl: `${base}/ecr`,
      now: () => new Date("2026-09-08T18:00:00Z"),
      researchPlayersFile: null,
    },
  };
}
