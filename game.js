// Pure game rules. Every function mutates the game object it is given
// and throws an Error with a user-facing message when a move is illegal.

export const uid = () => Math.random().toString(36).slice(2, 10);

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const newCode = () =>
  Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

export function newGame(code, pin) {
  return {
    code, pin,
    status: 'lobby',          // lobby | playing | ended
    round: 1, maxRounds: 3, maxSteals: 3,
    order: [], turnIdx: 0,
    activePlayerId: null,
    blockedGiftId: null,      // gift the active player may not take straight back
    endReason: null,
    players: {}, gifts: {},
    log: [], history: [],
    createdAt: Date.now(),
  };
}

// Firebase drops empty objects/arrays and nulls, and may hand arrays back as objects.
const toArr = v => Array.isArray(v) ? v.filter(x => x != null)
  : v ? Object.keys(v).sort((a, b) => a - b).map(k => v[k]) : [];

export function normalize(g) {
  if (!g) return null;
  g.players ||= {};
  g.gifts ||= {};
  g.order = toArr(g.order);
  g.log = toArr(g.log);
  g.history = toArr(g.history);
  g.activePlayerId ??= null;
  g.blockedGiftId ??= null;
  g.endReason ??= null;
  for (const [id, p] of Object.entries(g.players)) { p.id = id; p.giftId ??= null; p.satisfied ??= false; }
  for (const [id, x] of Object.entries(g.gifts)) { x.id = id; x.steals ??= 0; x.locked ??= false; x.holderId ??= null; }
  return g;
}

const fail = msg => { throw new Error(msg); };
const pname = (g, id) => g.players[id]?.name ?? '?';

function log(g, text) {
  g.log.push({ t: Date.now(), text });
  if (g.log.length > 200) g.log = g.log.slice(-200);
}

// Wraps an undoable move: snapshot first, then mutate.
function move(g, fn) {
  const { history, ...rest } = g;
  const snap = JSON.stringify(rest);
  fn();
  g.history = [...history, snap].slice(-20);
}

export function undo(g) {
  if (!g.history.length) fail('Nothing to undo');
  const history = g.history.slice(0, -1);
  const restored = normalize(JSON.parse(g.history[g.history.length - 1]));
  for (const k of Object.keys(g)) delete g[k];
  Object.assign(g, restored, { history });
}

// ---------- Lobby ----------

export function addPlayer(g, rawName) {
  const name = String(rawName || '').trim().slice(0, 30);
  if (!name) fail('Enter a name');
  const existing = Object.values(g.players).find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id; // same name = rejoin as that player
  if (g.status !== 'lobby') fail('Game already started. Ask the gift master, or just watch.');
  const id = uid();
  g.players[id] = { id, name, giftId: null, satisfied: false };
  g.order.push(id);
  log(g, `${name} joined`);
  return id;
}

export function removePlayer(g, id) {
  if (g.status !== 'lobby') fail('Players can only be removed in the lobby');
  delete g.players[id];
  g.order = g.order.filter(x => x !== id);
}

export function movePlayer(g, id, dir) {
  const i = g.order.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= g.order.length) return;
  [g.order[i], g.order[j]] = [g.order[j], g.order[i]];
}

export function shufflePlayers(g) {
  for (let i = g.order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [g.order[i], g.order[j]] = [g.order[j], g.order[i]];
  }
}

export function setSetting(g, key, value) {
  if (g.status !== 'lobby') fail('Settings are locked once the game starts');
  const n = Math.max(1, Math.min(10, parseInt(value, 10) || 1));
  if (key === 'maxSteals' || key === 'maxRounds') g[key] = n;
}

export function start(g) {
  if (g.status !== 'lobby') fail('Game already started');
  if (g.order.length < 2) fail('Need at least 2 players');
  move(g, () => {
    g.status = 'playing';
    g.round = 1;
    g.turnIdx = 0;
    g.activePlayerId = g.order[0];
    log(g, `Game started. ${pname(g, g.order[0])} goes first.`);
  });
}

// ---------- Turn logic ----------

const unlockedGifts = g => Object.values(g.gifts).filter(x => !x.locked);
const canStealAny = (g, pid) => unlockedGifts(g).some(x => x.holderId && x.holderId !== pid);
const eligibleLater = (g, pid) => !g.players[pid]?.satisfied && canStealAny(g, pid);

function end(g, reason) {
  g.status = 'ended';
  g.activePlayerId = null;
  g.blockedGiftId = null;
  g.endReason = reason;
  log(g, `Game over: ${reason}`);
}

function endReasonNow(g) {
  const ps = Object.values(g.players);
  if (ps.every(p => p.satisfied)) return 'everyone is happy with their gift';
  if (!unlockedGifts(g).length) return 'every gift reached its steal limit';
  return 'no more steals are possible';
}

function nextRound(g) {
  g.round++;
  if (g.round > g.maxRounds) { g.round = g.maxRounds; return end(g, `all ${g.maxRounds} rounds played`); }
  log(g, `Round ${g.round} begins: swap for an unlocked gift or keep yours.`);
  g.turnIdx = -1;
  advanceLater(g);
}

// Round 1: next player in order who has no gift yet.
function advanceRound1(g) {
  let i = g.turnIdx + 1;
  while (i < g.order.length && g.players[g.order[i]].giftId) i++;
  if (i < g.order.length) {
    g.turnIdx = i;
    g.activePlayerId = g.order[i];
  } else {
    nextRound(g);
  }
}

// Rounds 2+: next player who is not satisfied and has something to steal.
function advanceLater(g) {
  g.blockedGiftId = null;
  for (let i = g.turnIdx + 1; i < g.order.length; i++) {
    if (eligibleLater(g, g.order[i])) { g.turnIdx = i; g.activePlayerId = g.order[i]; return; }
  }
  if (g.order.some(id => eligibleLater(g, id))) return nextRound(g);
  end(g, endReasonNow(g));
}

function requirePlaying(g) {
  if (g.status !== 'playing' || !g.activePlayerId) fail('Game is not in progress');
}

// Returns why this gift cannot be stolen right now, or null if it can.
export function stealBlock(g, giftId) {
  const x = g.gifts[giftId];
  if (g.status !== 'playing' || !g.activePlayerId) return 'Game not in progress';
  if (!x) return 'Unknown gift';
  if (x.locked) return 'Locked';
  if (x.holderId === g.activePlayerId) return 'Already theirs';
  if (g.round === 1 && giftId === g.blockedGiftId) return 'No immediate steal-back';
  return null;
}

export function openGift(g, rawName) {
  requirePlaying(g);
  if (g.round !== 1) fail('All gifts are open. Swap or keep.');
  const name = String(rawName || '').trim().slice(0, 60);
  if (!name) fail('Enter what the gift is');
  const a = g.activePlayerId;
  if (g.players[a].giftId) fail(`${pname(g, a)} already has a gift`);
  move(g, () => {
    const id = uid();
    g.gifts[id] = { id, name, openedBy: a, holderId: a, steals: 0, locked: false };
    g.players[a].giftId = id;
    g.blockedGiftId = null;
    log(g, `${pname(g, a)} opened ${name}`);
    advanceRound1(g);
  });
}

export function steal(g, giftId) {
  requirePlaying(g);
  const why = stealBlock(g, giftId);
  if (why) fail(why);
  move(g, () => {
    const x = g.gifts[giftId];
    const a = g.activePlayerId, victim = x.holderId;
    x.steals++;
    if (x.steals >= g.maxSteals) x.locked = true;
    const tag = `(${x.steals}/${g.maxSteals}${x.locked ? ', now locked' : ''})`;

    if (g.round === 1) {
      x.holderId = a;
      g.players[a].giftId = giftId;
      g.players[victim].giftId = null;
      g.activePlayerId = victim;
      g.blockedGiftId = giftId;
      log(g, `${pname(g, a)} stole ${x.name} from ${pname(g, victim)} ${tag}. ${pname(g, victim)} picks next.`);
    } else {
      const mine = g.players[a].giftId;
      x.holderId = a;
      g.players[a].giftId = giftId;
      g.players[victim].giftId = mine;
      g.players[victim].satisfied = false;
      if (mine) g.gifts[mine].holderId = victim;
      log(g, `${pname(g, a)} swapped ${g.gifts[mine]?.name ?? 'nothing'} for ${pname(g, victim)}'s ${x.name} ${tag}`);
      advanceLater(g);
    }
  });
}

// Rounds 2+: keep current gift. `happy` = skip this player's future turns.
export function pass(g, happy) {
  requirePlaying(g);
  if (g.round === 1) fail('In round 1 the player must open or steal');
  move(g, () => {
    const a = g.activePlayerId;
    if (happy) g.players[a].satisfied = true;
    log(g, happy ? `${pname(g, a)} is happy and keeps their gift` : `${pname(g, a)} passed`);
    advanceLater(g);
  });
}

export function endNow(g) {
  if (g.status !== 'playing') fail('Game is not in progress');
  move(g, () => end(g, 'ended by the gift master'));
}
