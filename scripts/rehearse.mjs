import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { runtime } from '../tests/helpers/runtime.mjs';
import { pick, context } from '../tests/fixtures/sleeper.mjs';
import { writeJsonAtomic } from '../src/data/snapshot.mjs';
import { openSession } from '../src/session.mjs';
import { createApp } from '../src/server.mjs';

const STAGES = [0, 1, 27, 28, 29];
export function selectStage({ stage, players, ownRecords, removedPlayerId }) {
  if (!STAGES.includes(stage)) throw new Error('Unknown rehearsal stage.');
  const selected = new Map(ownRecords.map(record => [record.pickNo, record.playerId]));
  for (const required of [1, 28, 29].filter(n => n <= stage))
    if (!selected.has(required)) throw new Error(`Record your pick ${required} before advancing.`);
  const ids = new Set(players.map(player => player.id));
  const selectedIds = [...selected.values()];
  if (new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => !ids.has(id))) throw new Error('Rehearsal choices must be unique known players.');
  const opponents = players.filter(player => !selectedIds.includes(player.id)).map(player => player.id);
  if (opponents.includes(removedPlayerId)) opponents.splice(opponents.indexOf(removedPlayerId), 1), opponents.unshift(removedPlayerId);
  if (stage - [1, 28, 29].filter(n => n <= stage).length > opponents.length) throw new Error('Not enough fixture players.');
  const mapping = context().draft.slot_to_roster_id;
  let opponent = 0;
  return Array.from({ length: stage }, (_, index) => {
    const n = index + 1, row = pick(n, selected.get(n) ?? opponents[opponent++]);
    return { ...row, roster_id: mapping[row.draft_slot] };
  });
}

export async function launchRehearsal({ output = process.stdout } = {}) {
  const cleanups = [];
  let closing;
  const close = () => closing ??= (async () => { for (const cleanup of cleanups.toReversed()) await cleanup(); })();
  try {
    const r = await runtime({ after: cleanup => cleanups.push(cleanup) });
    r.snapshot.leagueName = 'REHEARSAL · Fictional draft';
    await writeJsonAtomic(`${r.dir}/snapshot.json`, r.snapshot);
    // Real fixture HTTP only, with its own real-time poller and isolated files.
    const session = await openSession({ dataDir: r.dir, baseUrl: r.options.baseUrl });
    r.cleanup(() => session.close());
    await session.refresh();
    const app = createApp({ session });
    r.cleanup(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); });
    await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
    const initialCandidates = session.getBoard().candidates.map(player => player.id);
    let stageIndex = 0, opponentRemoval = null;
    const url = `http://127.0.0.1:${app.address().port}`;
    output.write(`Rehearsal URL: ${url}\nIsolated state: ${r.dir}\nREHEARSAL: fictional data, no real Sleeper access. Use the browser's Record my pick.\nStage 0: Choose your preferred available player at pick 1. Enter confirms it, then Enter advances opponents through 27.\nChoose at 28 and 29; press Enter after each. Type q then Enter to quit. Human ten-second choice speed is unmeasured.\n`);
    async function advance() {
      if (stageIndex === STAGES.length - 1) { output.write('Rehearsal complete. Type q to quit and return to your live app.\n'); return; }
      const saved = JSON.parse(await readFile(r.sessionFile, 'utf8'));
      const official = (saved.accepted?.picks ?? []).filter(row => row.rosterId === r.snapshot.config.rosterId);
      const local = saved.corrections.filter(row => row.type === 'my-pick');
      const ownRecords = [...official, ...local];
      opponentRemoval ??= initialCandidates.find(id => !ownRecords.some(row => row.playerId === id)) ?? null;
      const stage = STAGES[stageIndex + 1];
      const picks = selectStage({ stage, players: Object.values(r.snapshot.playersById), ownRecords, removedPlayerId: opponentRemoval });
      r.c.draft.status = 'drafting';
      r.routes[`/v1/draft/${r.snapshot.config.draftId}/picks`] = picks;
      await session.refresh();
      const board = session.getBoard();
      if (board.connection.error || board.pending) throw new Error('Fixture could not advance. Review the local board before retrying.');
      stageIndex++;
      output.write(`Stage ${stage}: ${stage === 1 ? 'Your selected player is confirmed. Enter advances opponents through 27, taking a previous recommendation.' : stage === 27 ? 'Choose at 28 in the browser, then Enter.' : stage === 28 ? 'Choose at 29 in the browser, then Enter.' : 'Your three selections are confirmed. Type q to quit.'}\n`);
    }
    return { url, dataDir: r.dir, advance, close: async () => { await close(); output.write(`Fixture requests: ${r.log.length} GET; real-provider requests: 0\nRehearsal stopped; isolated state removed. Start or return to npm start for your live draft.\n`); } };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rehearsal = await launchRehearsal();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve(), stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true; input.close(); process.stdin.destroy();
    await queue; await rehearsal.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  input.on('line', line => {
    if (line.trim().toLowerCase() === 'q' || line.trim().toLowerCase() === 'quit') { stop(); return; }
    if (stopped) return;
    queue = queue.then(() => rehearsal.advance()).catch(error => process.stdout.write(`${error.message}\n`));
  });
  input.on('close', stop); process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
