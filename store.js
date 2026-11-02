// WebSocket client for server.js. Reconnects on its own and resubscribes.
// The master's device keeps the latest state in localStorage so it can
// re-seed the server after a restart (the server keeps games in memory only).
import { normalize } from './game.js';

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};
const pinKey = code => `we-master-${code}`;
const backupKey = code => `we-backup-${code}`;
export const masterPin = code => ls.get(pinKey(code));
const setMasterPin = (code, pin) => ls.set(pinKey(code), pin);

const listeners = new Map();  // code -> Set<cb>
const pending = new Map();    // request id -> { resolve, reject, timer }
const queue = [];             // requests made while disconnected
const statusCbs = new Set();
let ws = null, seq = 0, retry = 0, retryTimer = null;
export let status = 'connecting';

function setStatus(s) { status = s; statusCbs.forEach(cb => cb(s)); }
export const onStatus = cb => { statusCbs.add(cb); cb(status); };

function connect() {
  clearTimeout(retryTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  setStatus(retry ? 'reconnecting' : 'connecting');
  ws.onopen = () => {
    retry = 0;
    setStatus('online');
    for (const code of listeners.keys()) ws.send(JSON.stringify({ t: 'sub', code }));
    queue.splice(0).forEach(m => ws.send(JSON.stringify(m)));
  };
  ws.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => {
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('Connection lost. Try again.')); pending.delete(id); }
    queue.length = 0;
    setStatus('reconnecting');
    retryTimer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
  };
}

// Phones drop sockets while asleep; reconnect right away when the tab is back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ws && ws.readyState > WebSocket.OPEN) { retry = 0; connect(); }
});

function request(msg) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Server did not answer. Try again.')); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    const m = { ...msg, id };
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); else queue.push(m);
  });
}

const emit = (code, game) => listeners.get(code)?.forEach(cb => cb(game));

function onMessage(m) {
  if (m.t === 'ok' || m.t === 'err') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    return m.t === 'ok' ? p.resolve(m.result) : p.reject(new Error(m.msg));
  }
  if (m.t === 'state') {
    const game = normalize(m.game);
    if (masterPin(game.code)) ls.set(backupKey(game.code), JSON.stringify(m.game));
    return emit(game.code, game);
  }
  if (m.t === 'notFound') {
    const pin = masterPin(m.code), backup = ls.get(backupKey(m.code));
    if (pin && backup) {
      // Server lost the game (restart). Put it back; the resulting state broadcast reaches everyone.
      return request({ t: 'restore', code: m.code, pin, game: JSON.parse(backup) })
        .catch(() => emit(m.code, null));
    }
    return emit(m.code, null);
  }
}

export const store = {
  subscribe(code, cb) {
    if (!listeners.has(code)) {
      listeners.set(code, new Set());
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'sub', code }));
    }
    listeners.get(code).add(cb);
    return () => {
      const set = listeners.get(code);
      set?.delete(cb);
      if (set && !set.size) {
        listeners.delete(code);
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'unsub', code }));
      }
    };
  },
  async create(pin) {
    const code = await request({ t: 'create', pin });
    setMasterPin(code, pin.trim());
    return code;
  },
  async auth(code, pin) {
    await request({ t: 'auth', code, pin });
    setMasterPin(code, pin.trim());
  },
  forgetMaster: code => { ls.del(pinKey(code)); },
  join: (code, name) => request({ t: 'join', code, name }),
  op: (code, op, ...args) => request({ t: 'op', code, pin: masterPin(code), op, args }),
};

connect();
