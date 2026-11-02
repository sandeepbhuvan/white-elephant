import * as G from './game.js';
import { store, masterPin, onStatus } from './store.js';

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
onStatus(s => {
  document.getElementById('modeTag').textContent =
    s === 'online' ? '' : s === 'connecting' ? 'Connecting…' : 'Reconnecting…';
});

let unsub = null;
let game = null;
let route = [];

// ---------- helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};
const playerKey = code => `we-player-${code}`;
const code = () => (route[1] || '').toUpperCase();
const go = hash => { location.hash = hash; };
const playerLink = c => `${location.origin}${location.pathname}#/play/${c}`;
const time = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

let toastTimer;
function toast(msg, bad = false) {
  $toast.textContent = msg;
  $toast.className = `toast${bad ? ' bad' : ''}`;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, 2800);
}

// Sends a master action to the server. The new state arrives as a broadcast.
async function act(op, ...args) {
  try {
    return await store.op(code(), op, ...args);
  } catch (e) {
    toast(e.message, true);
    if (e.message === 'Wrong PIN') { store.forgetMaster(code()); draw(); }
  }
}

// Redraws keep whatever the user was typing and where the cursor was.
function paint(html) {
  const saved = {};
  $app.querySelectorAll('input[id]').forEach(i => { saved[i.id] = i.value; });
  const focused = document.activeElement?.id;
  const sel = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  $app.innerHTML = html;
  for (const [id, v] of Object.entries(saved)) {
    const el = document.getElementById(id);
    if (el && el.type !== 'number') el.value = v;
  }
  if (focused) {
    const el = document.getElementById(focused);
    if (el) { el.focus(); try { el.setSelectionRange(...sel); } catch { /* not a text input */ } }
  }
}

// ---------- routing ----------

window.addEventListener('hashchange', onRoute);
onRoute();

function onRoute() {
  unsub?.(); unsub = null; game = null;
  route = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [view, c] = route;
  if (view === 'master' && !c) return paint(masterStartView());
  if (view === 'play' && !c) return paint(joinView(''));
  if ((view === 'master' || view === 'play') && c) {
    paint('<p class="muted">Loading game…</p>');
    unsub = store.subscribe(c.toUpperCase(), g => { game = g; draw(); });
    return;
  }
  paint(homeView());
}

function draw() {
  const [view, , sub] = route;
  if (!game) return paint(`<div class="card stack"><h2>No game with code ${esc(code())}</h2><a href="#/">Back home</a></div>`);
  if (view === 'master') {
    if (!masterPin(game.code)) return paint(pinView());
    return paint(game.status === 'lobby' ? masterLobbyView() : masterGameView());
  }
  const pid = ls.get(playerKey(game.code));
  if (game.players[pid] || sub === 'watch') return paint(playerView(game.players[pid] ? pid : null));
  paint(joinView(game.code));
}

// ---------- shared pieces ----------

function pips(g, x) {
  return `<span class="pips" title="${x.steals}/${g.maxSteals} steals">${
    Array.from({ length: g.maxSteals }, (_, i) => `<i class="pip${i < x.steals ? ' on' : ''}"></i>`).join('')
  }${x.locked ? ' <span class="lock">🔒 LOCKED</span>' : ` <span class="small muted">${g.maxSteals - x.steals} left</span>`}</span>`;
}

function giftCard(g, x, { master = false, me = null } = {}) {
  const holder = g.players[x.holderId]?.name ?? '—';
  let btn = '';
  if (master && g.status === 'playing') {
    const why = G.stealBlock(g, x.id);
    const label = g.round === 1 ? 'Steal' : 'Swap';
    btn = `<button class="sm${why ? '' : ' primary'}" data-act="steal" data-id="${x.id}" ${why ? `disabled title="${esc(why)}"` : ''}>${label}${why && why !== 'Already theirs' ? ` · ${esc(why)}` : ''}</button>`;
  }
  return `<div class="gift${x.locked ? ' locked' : ''}${x.holderId && x.holderId === me ? ' mine' : ''}">
    <div class="name">🎁 ${esc(x.name)}</div>
    <div class="small">Held by <b>${esc(holder)}</b></div>
    ${pips(g, x)}
    ${btn}
  </div>`;
}

function giftsSection(g, opts) {
  const gifts = Object.values(g.gifts);
  const unopened = g.order.length - gifts.length;
  return `<section class="card stack">
    <div class="row spread"><h2>Gifts</h2>
      <div class="stats"><span><b>${gifts.length}</b> opened</span><span><b>${Math.max(0, unopened)}</b> wrapped</span><span><b>${gifts.filter(x => x.locked).length}</b> locked</span></div>
    </div>
    ${gifts.length ? `<div class="gifts">${gifts.map(x => giftCard(g, x, opts)).join('')}</div>` : '<p class="muted">No gifts opened yet.</p>'}
  </section>`;
}

function playersSection(g, me = null) {
  return `<section class="card stack"><h2>Players</h2><ul class="list">${g.order.map((id, i) => {
    const p = g.players[id];
    const gift = g.gifts[p.giftId];
    return `<li class="${id === g.activePlayerId ? 'active' : ''}">
      <span class="num">${i + 1}</span>
      <span class="grow">${esc(p.name)}${id === me ? ' <span class="muted">(you)</span>' : ''}<br>
        <span class="small muted">${gift ? `🎁 ${esc(gift.name)}` : 'no gift yet'}</span></span>
      ${p.satisfied ? '<span class="badge">happy</span>' : ''}
      ${id === g.activePlayerId ? '<span>▶</span>' : ''}
    </li>`;
  }).join('')}</ul></section>`;
}

function logSection(g) {
  const items = g.log.slice(-40).reverse();
  return `<section class="card stack"><h2>Activity</h2><ul class="log">${
    items.map(l => `<li><time>${time(l.t)}</time>${esc(l.text)}</li>`).join('') || '<li class="muted">Nothing yet.</li>'
  }</ul></section>`;
}

function roundLabel(g) {
  if (g.status === 'lobby') return 'Lobby';
  if (g.status === 'ended') return 'Finished';
  return `Round ${g.round} of ${g.maxRounds}${g.round === 1 ? ' · open or steal' : ' · swap or keep'}`;
}

function resultsSection(g, me = null) {
  return `<section class="banner done stack">
    <div class="who">🎉 Game over</div>
    <div>Ended because ${esc(g.endReason || 'the game finished')}.</div>
    <table><thead><tr><th>Player</th><th>Gift</th><th>Steals</th></tr></thead><tbody>
    ${g.order.map(id => {
      const p = g.players[id], x = g.gifts[p.giftId];
      return `<tr><td>${esc(p.name)}${id === me ? ' (you)' : ''}</td><td>${x ? esc(x.name) : '—'}</td><td>${x ? `${x.steals}/${g.maxSteals}` : ''}</td></tr>`;
    }).join('')}
    </tbody></table>
  </section>`;
}

// ---------- views ----------

function homeView() {
  return `<section class="hero">
    <h1>🎁 White Elephant</h1>
    <p class="muted">Track gifts, steals and turns. Everyone sees the board live.</p>
  </section>
  <div class="choices">
    <button class="card choice" data-act="nav" data-to="#/master"><div class="big">🎅</div><h2>I'm the Gift Master</h2><p class="muted small">Create a game, add players, record opens and steals.</p></button>
    <button class="card choice" data-act="nav" data-to="#/play"><div class="big">🙋</div><h2>I'm a Player</h2><p class="muted small">Join with the game code and your name. Watch the board.</p></button>
  </div>`;
}

function masterStartView() {
  return `<div class="cols">
    <form class="card stack" data-form="master-new">
      <h2>New game</h2>
      <label>Master PIN (to resume on another device)<input id="newPin" name="pin" inputmode="numeric" maxlength="8" required placeholder="e.g. 1234"></label>
      <button class="primary">Create game</button>
    </form>
    <form class="card stack" data-form="master-resume">
      <h2>Resume game</h2>
      <label>Game code<input id="resCode" name="code" class="code" maxlength="4" required></label>
      <label>Master PIN<input id="resPin" name="pin" inputmode="numeric" maxlength="8" required></label>
      <button>Resume</button>
    </form>
  </div>`;
}

function pinView() {
  return `<form class="card stack" data-form="pin">
    <h2>Gift master PIN for ${esc(game.code)}</h2>
    <label>PIN<input id="pinOnly" name="pin" inputmode="numeric" maxlength="8" required autofocus></label>
    <div class="row"><button class="primary">Continue</button><a href="#/play/${esc(game.code)}">Open player view instead</a></div>
  </form>`;
}

function joinView(c) {
  const g = game;
  const started = g && g.status !== 'lobby';
  return `<form class="card stack" data-form="join">
    <h2>Join a game</h2>
    ${started ? `<p class="muted small">This game has started. Enter the exact name you joined with to get back in.</p>` : ''}
    <label>Game code<input id="joinCode" name="code" class="code" maxlength="4" required value="${esc(c)}"></label>
    <label>Your name<input id="joinName" name="name" maxlength="30" required autocomplete="given-name" ${c ? 'autofocus' : ''}></label>
    <div class="row"><button class="primary">Join</button>
    ${c ? `<button type="button" class="link" data-act="nav" data-to="#/play/${esc(c)}/watch">Just watch</button>` : ''}</div>
  </form>`;
}

function masterLobbyView() {
  const g = game;
  return `<section class="card stack">
    <div class="row spread">
      <div><h3>Game code</h3><div class="gamecode">${esc(g.code)}</div></div>
      <button data-act="copy">Copy player link</button>
    </div>
    <div class="sharelink muted">${esc(playerLink(g.code))}</div>
  </section>
  <div class="cols">
    <section class="card stack">
      <div class="row spread"><h2>Players (${g.order.length})</h2><button class="sm" data-act="shuffle" ${g.order.length < 2 ? 'disabled' : ''}>🔀 Shuffle order</button></div>
      <p class="muted small">Players join from their phones. The list order is the turn order.</p>
      <ul class="list">${g.order.map((id, i) => `<li>
        <span class="num">${i + 1}</span><span class="grow">${esc(g.players[id].name)}</span>
        <button class="icon sm" data-act="up" data-id="${id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button class="icon sm" data-act="down" data-id="${id}" ${i === g.order.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button class="icon sm" data-act="remove" data-id="${id}" aria-label="Remove">✕</button>
      </li>`).join('') || '<li class="muted">Waiting for players…</li>'}</ul>
      <form class="row" data-form="add-player">
        <input id="addName" name="name" class="grow" maxlength="30" placeholder="Add a player by name" style="flex:1">
        <button>Add</button>
      </form>
    </section>
    <section class="card stack">
      <h2>Settings</h2>
      <label>Max steals per gift<input type="number" min="1" max="10" value="${g.maxSteals}" data-setting="maxSteals"></label>
      <label>Rounds<input type="number" min="1" max="10" value="${g.maxRounds}" data-setting="maxRounds"></label>
      <p class="muted small">Round 1: open a gift or steal one. Later rounds: swap for an unlocked gift or keep. A gift locks after ${g.maxSteals} steals.</p>
      <button class="good" data-act="start" ${g.order.length < 2 ? 'disabled' : ''}>Start game ▶</button>
    </section>
  </div>`;
}

function turnPanel(g) {
  if (g.status === 'ended') return resultsSection(g);
  const a = g.players[g.activePlayerId];
  if (g.round === 1) {
    const blocked = g.gifts[g.blockedGiftId];
    return `<section class="banner stack">
      <div><h3>${esc(roundLabel(g))}</h3><div class="who">${esc(a.name)}'s turn</div>
        ${blocked ? `<div class="small">Just had <b>${esc(blocked.name)}</b> stolen. Can't steal it straight back.</div>` : ''}</div>
      <form class="row" data-form="open">
        <input id="giftName" name="name" class="grow" maxlength="60" placeholder="What's in the gift they opened?" style="flex:1">
        <button class="good">Open gift</button>
      </form>
      <div class="small muted">…or tap <b>Steal</b> on an opened gift below.</div>
    </section>`;
  }
  const mine = g.gifts[a.giftId];
  return `<section class="banner stack">
    <div><h3>${esc(roundLabel(g))}</h3><div class="who">${esc(a.name)}'s turn</div>
      <div class="small">Holding <b>${esc(mine?.name ?? '—')}</b>. Tap <b>Swap</b> on a gift below, or:</div></div>
    <div class="row"><button class="good" data-act="happy">Keep it, I'm happy</button><button data-act="pass">Pass this round</button></div>
  </section>`;
}

function masterGameView() {
  const g = game;
  return `<div class="row spread">
    <div><span class="muted small">Game</span> <b class="gamecode" style="font-size:1.2rem">${esc(g.code)}</b></div>
    <div class="row">
      <button class="sm" data-act="copy">Copy player link</button>
      <button class="sm" data-act="undo" ${g.canUndo ? '' : 'disabled'}>↶ Undo</button>
      ${g.status === 'playing' ? '<button class="sm" data-act="end">End game</button>' : ''}
    </div>
  </div>
  ${turnPanel(g)}
  ${giftsSection(g, { master: true })}
  <div class="cols">${playersSection(g)}${logSection(g)}</div>
  ${g.status === 'ended' ? '<button data-act="nav" data-to="#/master">Start another game</button>' : ''}`;
}

function playerView(pid) {
  const g = game;
  const me = g.players[pid];
  const myGift = me && g.gifts[me.giftId];
  let banner;
  if (g.status === 'lobby') {
    banner = `<section class="banner stack"><div class="who">Waiting for the gift master to start…</div>
      <div class="small">${g.order.length} player${g.order.length === 1 ? '' : 's'} in: ${g.order.map(id => esc(g.players[id].name)).join(', ')}</div></section>`;
  } else if (g.status === 'ended') {
    banner = resultsSection(g, pid);
  } else {
    const yours = g.activePlayerId === pid;
    const a = g.players[g.activePlayerId];
    banner = `<section class="banner${yours ? ' me' : ''} stack">
      <h3>${esc(roundLabel(g))}</h3>
      <div class="who">${yours ? "🎯 It's your turn!" : `${esc(a.name)}'s turn`}</div>
      ${yours ? `<div class="small">${g.round === 1 ? 'Open a wrapped gift or steal one. Tell the gift master.' : 'Swap for an unlocked gift or keep yours. Tell the gift master.'}</div>` : ''}
    </section>`;
  }
  const mineCard = me ? `<section class="card stack">
      <div class="row spread"><h2>Hi ${esc(me.name)}</h2><button class="link small" data-act="forget">Not you?</button></div>
      ${myGift ? `<div class="gift mine"><div class="small muted">Your gift</div><div class="name">🎁 ${esc(myGift.name)}</div>${pips(g, myGift)}</div>`
        : '<p class="muted">You have no gift yet.</p>'}
    </section>` : `<section class="card row spread"><span class="muted">Watching game <b>${esc(g.code)}</b></span><button class="sm" data-act="forget">Join as player</button></section>`;
  return `${banner}${mineCard}${g.status !== 'lobby' ? giftsSection(g, { me: pid }) : ''}
    <div class="cols">${playersSection(g, pid)}${logSection(g)}</div>`;
}

// ---------- events ----------

const clicks = {
  nav: d => go(d.to),
  copy: async () => {
    const link = playerLink(game.code);
    try { await navigator.clipboard.writeText(link); toast('Player link copied'); } catch { prompt('Copy this link', link); }
  },
  up: d => act('movePlayer', d.id, -1),
  down: d => act('movePlayer', d.id, 1),
  remove: d => act('removePlayer', d.id),
  shuffle: () => act('shufflePlayers'),
  start: () => act('start'),
  steal: d => act('steal', d.id),
  happy: () => act('pass', true),
  pass: () => act('pass', false),
  undo: () => act('undo'),
  end: () => { if (confirm('End the game now?')) act('endNow'); },
  forget: () => { ls.del(playerKey(game.code)); go(`#/play/${game.code}`); draw(); },
};

$app.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled && clicks[b.dataset.act]) { e.preventDefault(); clicks[b.dataset.act](b.dataset); }
});

$app.addEventListener('change', e => {
  const key = e.target.dataset.setting;
  if (key) act('setSetting', key, e.target.value);
});

// The form may have been re-rendered while saving, so look the input up again.
const clearInput = id => { const el = document.getElementById(id); if (el) el.value = ''; };

const forms = {
  async 'master-new'(f) {
    const c = await store.create(f.pin);
    go(`#/master/${c}`);
  },
  async 'master-resume'(f) {
    const c = f.code.trim().toUpperCase();
    await store.auth(c, f.pin);
    go(`#/master/${c}`);
  },
  async pin(f) {
    await store.auth(game.code, f.pin);
    draw();
  },
  async join(f) {
    const c = f.code.trim().toUpperCase();
    const id = await store.join(c, f.name);
    ls.set(playerKey(c), id);
    if (route[1]?.toUpperCase() === c && route.length === 2) draw(); else go(`#/play/${c}`);
  },
  async 'add-player'(f) {
    await store.op(code(), 'addPlayer', f.name);
    clearInput('addName');
  },
  async open(f) {
    await store.op(code(), 'openGift', f.name);
    clearInput('giftName');
  },
};

$app.addEventListener('submit', async e => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  try { await forms[form.dataset.form](data); } catch (err) { toast(err.message, true); }
});
