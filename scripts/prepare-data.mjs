import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { prepareData } from "../src/data/sources.mjs";
export async function runPrepare(argv = process.argv.slice(2), options = {}) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      league: { type: "string" },
      user: { type: "string" },
      "data-dir": { type: "string" },
      "players-file": { type: "string" },
      "players-fetched-at": { type: "string" },
      "without-ecr": { type: "boolean", default: false },
    },
  });
  if (Boolean(values["players-file"]) !== Boolean(values["players-fetched-at"]))
    throw new Error(
      "--players-file and --players-fetched-at are required together",
    );
  if (
    values["players-fetched-at"] &&
    !Number.isFinite(Date.parse(values["players-fetched-at"]))
  )
    throw new Error("Invalid --players-fetched-at");
  return prepareData({
    ...options,
    ...(values.league ? { league: values.league } : {}),
    ...(values.user ? { user: values.user } : {}),
    dataDir: values["data-dir"] ?? options.dataDir,
    playersFile: values["players-file"],
    playersFetchedAt: values["players-fetched-at"],
    withoutEcr: values["without-ecr"],
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runPrepare()
    .then((s) => {
      console.log(
        `Prepared ${s.importReport.coverage.total} eligible players (${s.rankingMode}) at ${s.preparedAt}`,
      );
      for (const warning of s.importReport.warnings) console.warn(warning);
    })
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
