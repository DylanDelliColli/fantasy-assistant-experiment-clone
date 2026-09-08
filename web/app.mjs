// Presentation and transport only. The session supplies all ranking, roster,
// availability, correction validation and selection numbers.
export const valueText = value => value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value)) ? '—' : String(value);
export function dateText(value) {
  if (value === null || value === undefined) return 'not available';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'not available';
}
export function ageText(timestamp, now = Date.now()) {
  if (dateText(timestamp) === 'not available') return 'not available';
  const seconds = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
}
const stamp = (label, timestamp, now) => `${label}: ${dateText(timestamp)}${timestamp !== null && timestamp !== undefined ? ` (${ageText(timestamp, now)})` : ''}`;
export function freshness(board, now = Date.now(), disconnected = false, firstReadAt = now) {
  const health = board.connection ?? {};
  const since = board.lastCheckedAt ? Date.parse(board.lastCheckedAt) : firstReadAt;
  const overdue = health.overdue || now - since >= (board.draft?.status === 'complete' ? 40000 : 15000);
  const status = disconnected ? 'App connection lost — displayed board retained.'
    : health.error ? `Check failed — ${health.error.message}`
    : health.status === 'stale' ? 'Stale saved board — awaiting a successful check.'
    : overdue ? 'Overdue — no recent successful check; displayed board retained.'
    : board.lastCheckedAt ? 'Checked — Sleeper may lag.' : 'Checking — availability is not yet confirmed.';
  return { status, warning: disconnected || Boolean(health.error) || health.status === 'stale' || overdue,
    checked: stamp('Last successful check', board.lastCheckedAt, now), changed: stamp('Last changed picks', board.lastChangedAt, now) };
}
export function injuryText(injury) {
  if (!injury?.status) return 'Injury status not provided';
  return [injury.status, injury.bodyPart, injury.notes].filter(Boolean).join(' · ');
}
export function correctionText(correction, name = correction.playerId) {
  return correction.type === 'my-pick' ? `Pick ${correction.pickNo}: ${name} · local` : `${name} · marked taken · local`;
}
export function availabilityText(board, playerId) {
  return board.unavailableIds.includes(playerId) ? 'Unavailable' : board.availabilityKnown ? 'Available' : 'Availability unknown';
}
export function actionRequest(board, type, fields = {}) {
  return { expectedRevision: board.revision, action: { type, ...fields, ...(type === 'my-pick' ? { pickNo: board.nextPicks[0] } : {}) } };
}
export function responseOrder() {
  let sessionId = null, viewRevision = -1, maxAppliedRequestSequence = -1;
  const retired = new Set();
  return { accept(board, sequence) {
    if (retired.has(board.sessionId)) return false;
    if (board.sessionId === sessionId) {
      if (board.viewRevision <= viewRevision) return false;
    } else {
      if (sequence <= maxAppliedRequestSequence) return false;
      if (sessionId !== null) retired.add(sessionId);
      sessionId = board.sessionId;
    }
    viewRevision = board.viewRevision;
    maxAppliedRequestSequence = Math.max(maxAppliedRequestSequence, sequence);
    return true;
  } };
}

export function initBrowser({ document = globalThis.document, window = globalThis.window } = {}) {
  const $ = id => document.getElementById(id);
  let board = null, requestSequence = 0, readFlight = null, readAgain = false;
  let firstReadAt = null, lastReadAt = null, disconnected = false, selectedId = null, closed = false;
  let actionFlight = false, healthSequence = -1;
  const order = responseOrder(), sections = new Map(), controllers = new Set();
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const text = (id, value) => { const element = $(id); if (element.textContent !== value) element.textContent = value; };
  const rebuild = (id, data, build) => {
    const key = JSON.stringify(data);
    if (sections.get(id) === key) return;
    sections.set(id, key); $(id).replaceChildren(...build());
  };
  const button = (label, fn, primary = false) => {
    const element = node('button', label, primary ? 'primary' : ''); element.type = 'button';
    element.addEventListener('click', fn); return element;
  };
  const message = (value, error = false) => { text('action-message', value); $('action-message').dataset.error = String(error); };
  const playerName = id => board.players.find(p => p.id === id)?.name ?? id;
  function actions(player, details = true) {
    const controls = node('div', undefined, 'actions');
    if (board.nextPicks.length) controls.append(button(`Record my pick ${board.nextPicks[0]}`, () => act('my-pick', { playerId: player.id }), true));
    controls.append(button('Mark taken', () => act('taken', { playerId: player.id })));
    if (details) controls.append(button('Details', () => { selectedId = player.id; renderDetail(); $('player-detail').scrollIntoView({ block: 'nearest' }); }));
    return controls;
  }
  function renderDetail() {
    const player = board.players.find(p => p.id === selectedId);
    $('player-detail').hidden = !player;
    if (!player) return;
    rebuild('player-detail', [player, board.nextPicks], () => {
      const values = node('dl');
      for (const [label, value] of [
        ['Sleeper ADP', valueText(player.adp)], ['Expert rank / tier', `${valueText(player.ecr?.rank)} / ${valueText(player.ecr?.tier)}`],
        ['Sleeper half-PPR projection', valueText(player.projection?.points)], ['Projection updated', dateText(player.projection?.updatedAt)],
        ['Prior actual half-PPR points', valueText(player.history?.points)], ['Prior actual updated', dateText(player.history?.updatedAt)],
        ['Injury', injuryText(player.injury)], ['Injury updated', dateText(player.injury?.updatedAt)],
      ]) values.append(node('dt', label), node('dd', value));
      return [node('h3', player.name), node('p', `${player.team ?? 'No team'} · ${player.fantasyPositions.join('/')}`, 'player-meta'), values, actions(player, false), button('Close details', () => { selectedId = null; $('player-detail').hidden = true; $('search').focus(); })];
    });
  }
  function renderPlayers() {
    if (!board) return;
    const query = $('search').value.trim().toLocaleLowerCase(), position = $('position').value;
    const players = board.players.filter(player => (!query || `${player.name} ${player.team ?? ''}`.toLocaleLowerCase().includes(query)) && (position === 'all' || player.fantasyPositions.includes(position)));
    text('search-count', `${players.length} matching players${players.length > 40 ? ' · showing first 40; narrow your search' : ''}`);
    const shown = players.slice(0, 40);
    rebuild('players', [shown, board.unavailableIds, board.availabilityKnown], () => shown.map(player => {
      const row = node('li'); row.dataset.playerId = player.id;
      const name = node('div'); name.append(node('span', player.name, 'player-name'), node('span', `${player.team ?? 'No team'} · ${player.fantasyPositions.join('/')} · ${availabilityText(board, player.id)}`, 'player-meta'));
      row.append(name, button(`Details · ${player.name}`, () => { selectedId = player.id; renderDetail(); })); return row;
    }));
  }
  function render() {
    document.body.dataset.sessionId = board.sessionId;
    document.body.dataset.viewRevision = String(board.viewRevision);
    document.body.dataset.revision = String(board.revision);
    const league = board.league;
    const title = document.querySelector('h1');
    if (title.textContent !== league.name) title.textContent = league.name || 'Your draft';
    text('league-summary', `${league.teams} teams · ${league.scoring.rec === 0.5 ? 'Half-PPR' : `${league.scoring.rec ?? 0} points / reception`} · ${league.rounds} rounds · ${league.scoring.pass_td} points / passing TD · ${league.season}`);
    text('roster-settings', `Roster: ${league.rosterPositions.join(' · ')}${league.reserveSlots ? ` · ${league.reserveSlots} reserve` : ''}`);
    text('next-picks', `Next picks: ${board.nextPicks.length ? board.nextPicks.join(' · ') : 'Complete'}`);
    text('observed', `Observed picks: ${board.draft.observedCount}`);
    text('ranking-mode', board.rankingMode === 'ecr' ? 'Expert ranks + Sleeper ADP' : 'Sleeper ADP-only');
    text('board-status', board.status === 'ready' ? '' : board.reason ?? board.status);
    rebuild('candidates', [board.candidates, board.nextPicks], () => board.candidates.map((player, index) => {
      const card = node('article', undefined, 'candidate'); card.dataset.playerId = player.id;
      const reasons = node('ul', undefined, 'reasons'); reasons.append(...player.reasons.map(reason => node('li', reason)));
      card.append(node('span', `0${index + 1}`, 'number'), node('h3', player.name), node('p', `${player.team ?? 'No team'} · ${player.fantasyPositions.join('/')}`, 'player-meta'), reasons, actions(player)); return card;
    }));
    rebuild('roster', [board.roster, board.ownRecords], () => [
      ...board.roster.slots.map(slot => {
        const row = node('div', undefined, 'roster-row'); row.append(node('strong', slot.position), node('span', slot.playerId ? playerName(slot.playerId) : 'Open')); return row;
      }),
      ...board.roster.bench.map(player => { const row = node('div', undefined, 'roster-row'); row.append(node('strong', 'Bench'), node('span', player.name)); return row; }),
      ...board.ownRecords.filter(record => !board.players.some(p => p.id === record.playerId)).map(record => node('p', `Unknown player ${record.playerId} · pick ${record.pickNo}`)),
    ]);
    rebuild('corrections', board.corrections, () => board.corrections.map(correction => {
      const row = node('li'); row.append(node('span', correctionText(correction, playerName(correction.playerId))), button(`Undo ${correction.type === 'my-pick' ? `pick ${correction.pickNo}` : playerName(correction.playerId)}`, () => act('undo', { correctionId: correction.id }))); return row;
    }));
    rebuild('notices', board.notices, () => board.notices.map(notice => node('p', notice.message)));
    $('pending').hidden = !board.pending;
    if (board.pending) rebuild('pending', board.pending, () => {
      const reviewed = board.pending.revision, list = node('ul');
      for (const change of board.pending.diff.changes) list.append(node('li', `Pick ${change.pickNo}: ${change.before?.playerId ?? 'empty'} → ${change.after?.playerId ?? 'empty'}`));
      return [node('h2', 'Sleeper returned a changed board'), node('p', 'Your accepted board is retained. Review these changes; adopting them can clear local corrections.'), list, button('Use this Sleeper board', () => act('accept-pending', { pendingRevision: reviewed }))];
    });
    renderPlayers(); renderDetail(); renderTime();
  }
  function renderTime() {
    if (!board) return;
    const now = Date.now(), labels = freshness(board, now, disconnected, firstReadAt);
    text('connection', labels.status);
    $('connection').parentElement.dataset.state = labels.warning ? 'warning' : 'checked';
    text('last-read', stamp('App board read', lastReadAt, now));
    text('last-checked', labels.checked); text('last-changed', labels.changed);
    text('prepared-at', stamp('Prepared', board.preparedAt, now));
    rebuild('sources', [board.sources, Math.floor(now / 1000)], () => Object.entries(board.sources).map(([name, source]) => {
      const section = node('div'); section.append(node('strong', `${name} · ${source.season ?? 'season not provided'}${source.scoring ? ` · ${source.scoring}` : ''}`), node('span', source.url), node('span', stamp('Fetched', source.fetchedAt, now)), node('span', stamp('Updated', source.updatedAt, now))); return section;
    }));
  }
  async function request(path, options = {}) {
    const controller = new AbortController(); controllers.add(controller);
    const timer = window.setTimeout(() => controller.abort(), 5000);
    try { return await window.fetch(path, { cache: 'no-store', ...options, signal: controller.signal }); }
    finally { window.clearTimeout(timer); controllers.delete(controller); }
  }
  function connectionResult(sequence, failed) {
    if (sequence >= healthSequence) { healthSequence = sequence; disconnected = failed; }
  }
  function apply(value, sequence) {
    if (!order.accept(value, sequence)) return;
    board = value; firstReadAt ??= Date.now(); render();
  }
  function read({ afterAction = false } = {}) {
    if (closed || document.visibilityState === 'hidden') return Promise.resolve();
    if (readFlight) { readAgain ||= afterAction; return readFlight; }
    const sequence = ++requestSequence;
    readFlight = (async () => {
      try {
        const response = await request('/api/board');
        if (!response.ok) throw new Error('Could not read the local board.');
        const value = await response.json();
        connectionResult(sequence, false); lastReadAt = new Date().toISOString();
        apply(value, sequence); renderTime();
      } catch {
        connectionResult(sequence, true);
        if (!board) text('connection', 'App connection lost — start the local server and try Refresh.');
        else renderTime();
      } finally {
        readFlight = null;
        if (readAgain && !closed) { readAgain = false; read(); }
      }
    })();
    return readFlight;
  }
  async function act(type, fields) {
    if (!board || actionFlight || closed) return;
    actionFlight = true;
    const body = actionRequest(board, type, fields), sequence = ++requestSequence;
    message('Saving local change…');
    try {
      const response = await request('/api/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json(); connectionResult(sequence, false);
      if (!response.ok) {
        message(response.status === 409 ? 'Board changed. Review the current board before trying again.' : result.error?.message ?? 'The change could not be saved.', true);
      } else { apply(result, sequence); message('Saved locally. Confirm official picks in Sleeper.'); }
    } catch {
      connectionResult(sequence, true);
      message('App connection lost. Save outcome is unknown; check the current board before trying again.', true);
    } finally { actionFlight = false; renderTime(); read({ afterAction: true }); }
  }
  async function refresh() {
    const sequence = ++requestSequence;
    try {
      const response = await request('/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: true }) });
      if (!response.ok) throw new Error('Refresh request failed.');
      connectionResult(sequence, false);
    } catch { connectionResult(sequence, true); }
    await read({ afterAction: true }); renderTime();
  }
  const regain = () => { if (document.visibilityState !== 'hidden') read(); };
  $('search').addEventListener('input', renderPlayers);
  $('position').addEventListener('change', renderPlayers);
  $('refresh').addEventListener('click', refresh);
  window.addEventListener('focus', regain); document.addEventListener('visibilitychange', regain);
  const timer = window.setInterval(() => { renderTime(); read(); }, 1000);
  function close() {
    closed = true; window.clearInterval(timer); for (const controller of controllers) controller.abort();
    window.removeEventListener('focus', regain); document.removeEventListener('visibilitychange', regain);
    $('search').removeEventListener('input', renderPlayers); $('position').removeEventListener('change', renderPlayers); $('refresh').removeEventListener('click', refresh);
    window.removeEventListener('pagehide', close);
  }
  window.addEventListener('pagehide', close, { once: true });
  read();
  return { close };
}
