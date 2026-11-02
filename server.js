// White Elephant server: serves the static app and runs the live game over WebSockets.
// Games live in memory only. The master's browser keeps a backup and re-seeds after a restart.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as G from './game.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const IDLE_MS = 24 * 60 * 60 * 1000;

// Only these files are served, which also rules out path traversal.
const STATIC = new Set(['index.html', 'app.js', 'game.js', 'store.js', 'styles.css']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') return res.end('ok');
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!STATIC.has(name)) { res.writeHead(404); return res.end('Not found'); }
  try {
    const body = await readFile(path.join(ROOT, name));
    res.writeHead(200, { 'content-type': TYPES[path.extname(name)], 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(500); res.end();
  }
});

// ---------- state ----------

const games = new Map();   // code -> { game, touched }
const subs = new Map();    // code -> Set<ws>; kept even while a game is missing so a restore reaches waiting players

const MASTER_OPS = {
  start: G.start, openGift: G.openGift, steal: G.steal, pass: G.pass, undo: G.undo, endNow: G.endNow,
  removePlayer: G.removePlayer, movePlayer: G.movePlayer, shufflePlayers: G.shufflePlayers,
  setSetting: G.setSetting, addPlayer: G.addPlayer,
};

// Clients never see the PIN; undo history stays on the server.
function publicState(g) {
  const { pin, history, ...rest } = g;
  return { ...rest, canUndo: history.length > 0 };
}

const send = (ws, msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

function broadcast(code) {
  const entry = games.get(code);
  const msg = entry ? { t: 'state', game: publicState(entry.game) } : { t: 'notFound', code };
  subs.get(code)?.forEach(ws => send(ws, msg));
}

const fail = msg => { throw new Error(msg); };
const cleanCode = c => String(c || '').trim().toUpperCase();
const cleanPin = p => String(p ?? '').trim().slice(0, 8);

function getGame(code) {
  return games.get(code) ?? fail(`No game with code ${code}`);
}

// Run a rules function on a copy so a thrown error leaves the game untouched.
function apply(code, fn, args) {
  const entry = getGame(code);
  const g = structuredClone(entry.game);
  const result = fn(g, ...args);
  entry.game = g;
  entry.touched = Date.now();
  broadcast(code);
  return result;
}

function checkPin(code, pin) {
  if (getGame(code).game.pin !== cleanPin(pin)) fail('Wrong PIN');
}

const handlers = {
  sub(ws, m) {
    const code = cleanCode(m.code);
    if (!subs.has(code)) subs.set(code, new Set());
    subs.get(code).add(ws);
    ws.subs.add(code);
    const entry = games.get(code);
    send(ws, entry ? { t: 'state', game: publicState(entry.game) } : { t: 'notFound', code });
  },
  unsub(ws, m) {
    const code = cleanCode(m.code);
    subs.get(code)?.delete(ws);
    ws.subs.delete(code);
  },
  create(ws, m) {
    const pin = cleanPin(m.pin);
    if (!pin) fail('Enter a PIN');
    let code;
    do { code = G.newCode(); } while (games.has(code));
    games.set(code, { game: G.newGame(code, pin), touched: Date.now() });
    return code;
  },
  auth(ws, m) {
    checkPin(cleanCode(m.code), m.pin);
    return true;
  },
  join(ws, m) {
    return apply(cleanCode(m.code), G.addPlayer, [String(m.name ?? '')]);
  },
  op(ws, m) {
    const code = cleanCode(m.code);
    checkPin(code, m.pin);
    const fn = Object.hasOwn(MASTER_OPS, m.op) ? MASTER_OPS[m.op] : fail('Unknown action');
    const args = Array.isArray(m.args) ? m.args.slice(0, 3).map(a => (typeof a === 'object' ? null : a)) : [];
    return apply(code, fn, args);
  },
  // After a server restart the master's device sends its backup back.
  restore(ws, m) {
    const code = cleanCode(m.code);
    if (games.has(code)) return 'exists';
    const g = G.normalize(m.game && typeof m.game === 'object' ? structuredClone(m.game) : null);
    if (!g || g.code !== code || !/^[A-Z]{4}$/.test(code)) fail('Bad backup');
    g.pin = cleanPin(m.pin) || fail('Missing PIN');
    games.set(code, { game: g, touched: Date.now() });
    broadcast(code);
    return 'restored';
  },
};

// ---------- sockets ----------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });

wss.on('connection', ws => {
  ws.alive = true;
  ws.subs = new Set();
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const handler = Object.hasOwn(handlers, m?.t) ? handlers[m.t] : null;
    if (!handler) return;
    try {
      const result = handler(ws, m);
      if (m.id != null) send(ws, { t: 'ok', id: m.id, result });
    } catch (e) {
      if (m.id != null) send(ws, { t: 'err', id: m.id, msg: e.message });
    }
  });
  ws.on('close', () => ws.subs.forEach(code => subs.get(code)?.delete(ws)));
});

// Heartbeat drops dead sockets (phones that went to sleep).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30_000);

// Forget games nobody has touched for a day.
setInterval(() => {
  const cutoff = Date.now() - IDLE_MS;
  for (const [code, entry] of games) if (entry.touched < cutoff) games.delete(code);
  for (const [code, set] of subs) if (!set.size) subs.delete(code);
}, 60 * 60 * 1000);

server.listen(PORT, () => console.log(`White Elephant running on http://localhost:${PORT}`));
