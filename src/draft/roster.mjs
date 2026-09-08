import { POSITIONS } from "../data/identity.mjs";

export const POLICY_CAPS = { QB: 2, TE: 2, K: 1, DEF: 1 };
export const OFFENSIVE_SLOTS = new Set(["QB", "RB", "WR", "TE", "FLEX"]);
const slotsOf = (config) =>
  (Array.isArray(config) ? config : config.rosterPositions).filter(
    (slot) => POSITIONS.includes(slot) || slot === "FLEX",
  );
const fits = (player, slot) =>
  slot === "FLEX"
    ? player.fantasyPositions.some((position) =>
        ["RB", "WR", "TE"].includes(position),
      )
    : player.fantasyPositions.includes(slot);
const uniquePlayers = (players) => [
  ...new Map(players.map((player) => [player.id, player])).values(),
];

export function policyCounts(players) {
  const counts = Object.fromEntries(POSITIONS.map((position) => [position, 0]));
  for (const player of uniquePlayers(players))
    if (Object.hasOwn(counts, player.policyPosition))
      counts[player.policyPosition]++;
  return counts;
}

function maximumSize(players, slots) {
  const owners = new Map();
  function assign(slotIndex, seen) {
    for (const player of players) {
      if (!fits(player, slots[slotIndex]) || seen.has(player.id)) continue;
      seen.add(player.id);
      if (!owners.has(player.id) || assign(owners.get(player.id), seen)) {
        owners.set(player.id, slotIndex);
        return true;
      }
    }
    return false;
  }
  for (let index = 0; index < slots.length; index++) assign(index, new Set());
  return owners.size;
}

export function assignRoster(inputPlayers, config) {
  const players = uniquePlayers(inputPlayers).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const positions = slotsOf(config);
  const order = positions
    .map((position, index) => ({ position, index }))
    .sort(
      (a, b) =>
        Number(a.position === "FLEX") - Number(b.position === "FLEX") ||
        a.index - b.index,
    );
  const slots = positions.map((position, index) => ({
    id: `slot-${index}`,
    position,
    playerId: null,
  }));
  let remaining = players;
  let needed = maximumSize(
    remaining,
    order.map((slot) => slot.position),
  );
  // Fix each deterministic tie only when the rest can still achieve maximum coverage.
  for (let index = 0; index < order.length; index++) {
    const slot = order[index];
    const rest = order.slice(index + 1).map((next) => next.position);
    for (const player of remaining) {
      if (!fits(player, slot.position)) continue;
      const available = remaining.filter(
        (candidate) => candidate.id !== player.id,
      );
      if (1 + maximumSize(available, rest) < needed) continue;
      slots[slot.index].playerId = player.id;
      remaining = available;
      needed--;
      break;
    }
  }
  return {
    slots,
    filled: slots.filter((slot) => slot.playerId !== null).length,
    missing: slots.filter((slot) => slot.playerId === null),
    bench: remaining,
  };
}

export function completionFeasible(
  inputOwned,
  inputAvailable,
  selections,
  config,
) {
  const owned = uniquePlayers(inputOwned);
  const ownedIds = new Set(owned.map((player) => player.id));
  const available = uniquePlayers(inputAvailable).filter(
    (player) => player.eligible && !ownedIds.has(player.id),
  );
  const positions = slotsOf(config);
  if (!Number.isInteger(selections) || selections < 0) return false;
  if (maximumSize(owned, positions) === positions.length) return true;
  if (owned.length + selections < positions.length) return false;
  const counts = policyCounts(owned);
  // Min-cost flow: owned players cost zero, new selections cost one. Position
  // gates enforce canonical caps while each player and starter has capacity one.
  const graph = [];
  const node = () => (graph.push([]), graph.length - 1);
  const edge = (from, to, capacity, cost = 0) => {
    const forward = { to, capacity, cost, reverse: graph[to].length };
    const reverse = {
      to: from,
      capacity: 0,
      cost: -cost,
      reverse: graph[from].length,
    };
    graph[from].push(forward);
    graph[to].push(reverse);
  };
  const source = node(),
    sink = node();
  const slotNodes = positions.map(() => node());
  for (const slot of slotNodes) edge(slot, sink, 1);
  const groups = new Map();
  for (const position of POSITIONS) {
    const group = node();
    groups.set(position, group);
    const capacity =
      POLICY_CAPS[position] === undefined
        ? available.length
        : Math.max(0, POLICY_CAPS[position] - counts[position]);
    edge(source, group, capacity);
  }
  function addPlayer(player, from, cost) {
    const playerNode = node();
    edge(from, playerNode, 1, cost);
    positions.forEach((slot, index) => {
      if (fits(player, slot)) edge(playerNode, slotNodes[index], 1);
    });
  }
  owned.forEach((player) => addPlayer(player, source, 0));
  available.forEach((player) => {
    if (groups.has(player.policyPosition))
      addPlayer(player, groups.get(player.policyPosition), 1);
  });
  let totalCost = 0;
  for (let flow = 0; flow < positions.length; flow++) {
    const distance = Array(graph.length).fill(Infinity);
    const previous = Array(graph.length).fill(null);
    const queue = [source],
      queued = new Set([source]);
    distance[source] = 0;
    for (let head = 0; head < queue.length; head++) {
      const from = queue[head];
      queued.delete(from);
      graph[from].forEach((link, index) => {
        const candidate = distance[from] + link.cost;
        if (link.capacity <= 0 || candidate >= distance[link.to]) return;
        distance[link.to] = candidate;
        previous[link.to] = [from, index];
        if (!queued.has(link.to)) {
          queue.push(link.to);
          queued.add(link.to);
        }
      });
    }
    if (!previous[sink]) return false;
    totalCost += distance[sink];
    let current = sink;
    while (current !== source) {
      const [from, index] = previous[current];
      const link = graph[from][index];
      link.capacity--;
      graph[current][link.reverse].capacity++;
      current = from;
    }
  }
  return totalCost <= selections;
}
