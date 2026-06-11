/* ─── Transport ─────────────────────────────────────────────────────────────
   All networking goes through Net (net.js): a signaling server brokers the
   WebRTC handshake, then gameplay is peer-to-peer. The room host's browser runs
   the authoritative simulation; this client just sends input and renders the
   snapshots Net delivers — same shape the old server used to emit. */

/* ─── State ─────────────────────────────────────────────────────────────────── */
let myId     = null;
let roomId   = null;
let isHost   = false;
let screen   = 'lobby';   // 'lobby' | 'game' | 'end'
let pendingJoinCode = null;   // last code we tried to join (for the "host it instead" offer)
let inRoom   = false;         // true once we've created/joined (arms the quit guard)
let countingDown = false;     // true during the 3-2-1 intro (input + prediction frozen)

const NAME_KEY = 'bomberblast_name';   // localStorage key for the remembered name

/* Test mode — disables the accidental-quit guards (beforeunload warning + back/
   swipe interception) so automated previews and dev testing can navigate/reload
   freely. Enable with ?test=1 (sticky — persisted to localStorage so it survives
   reloads and the in-app URL rewrites); disable with ?test=0. */
const TEST_MODE = (() => {
  const p = new URLSearchParams(location.search);
  if (p.has('test')) {
    const v = p.get('test');
    if (v === '0' || v === 'false') localStorage.removeItem('bomberblast_test');
    else localStorage.setItem('bomberblast_test', '1');
  }
  return localStorage.getItem('bomberblast_test') === '1';
})();

let MAP_W = 15, MAP_H = 13;
let gameSnap = null;   // latest snapshot from server
let grid     = null;   // current tile grid (sent on start + when it changes)
let predict  = null;   // client-side predicted state for the local player
let lastFrame = 0;
let rafHandle = null;

let playerMeta = {};   // id → { name, color } (static, from gameStart)
let anim       = {};   // id → { x, y } animated render position for remote players
let bombSeen   = {};   // bombId → first-seen timestamp (for local fuse pulse)
let expSeen    = {};   // explosionId → first-seen timestamp (for local fade)
let localBombs = [];   // predicted bombs shown instantly until the host confirms

const BOMB_FUSE_MS = 3000;       // must match server BOMB_TIMER_MS
const EXPLOSION_TTL_MS = 500;    // must match server

const STEP_DIRS = [    // must match server
  { dx: 0, dy: -1, key: 'up' },
  { dx: 0, dy: 1,  key: 'down' },
  { dx: -1, dy: 0, key: 'left' },
  { dx: 1, dy: 0,  key: 'right' },
];

/* ─── Input ─────────────────────────────────────────────────────────────────── */
const keyState   = { up: false, down: false, left: false, right: false, bomb: false };
const touchState = { up: false, down: false, left: false, right: false, bomb: false };
let lastReport = '';   // last {tx,ty,mv} we told the host, to skip duplicate sends

// Direction-only input (bombs are placed via doPlaceBomb, not held state).
function currentInput() {
  return {
    up:    keyState.up    || touchState.up,
    down:  keyState.down  || touchState.down,
    left:  keyState.left  || touchState.left,
    right: keyState.right || touchState.right,
  };
}

// Movement is client-authoritative: we report our own tile to the host whenever
// it changes. While moving we report the TARGET tile (so remote viewers animate
// toward it), matching the snapshot semantics other clients expect.
function reportPosition() {
  if (screen !== 'game' || !predict) return;
  const tx = predict.moving ? Math.floor(predict.targetX) : Math.floor(predict.x);
  const ty = predict.moving ? Math.floor(predict.targetY) : Math.floor(predict.y);
  const mv = predict.moving ? 1 : 0;
  const key = tx + ',' + ty + ',' + mv;
  if (key !== lastReport) {
    lastReport = key;
    Net.reportPos(tx, ty, mv);
  }
}

// Place a bomb at our current tile: tell the host, and show it instantly with a
// local prediction so it doesn't wait a round-trip to appear.
function doPlaceBomb() {
  if (screen !== 'game' || countingDown || !predict) return;
  const me = gameSnap && gameSnap.players.find(p => p.id === myId);
  if (!me || !me.alive) return;
  const tx = Math.floor(predict.x), ty = Math.floor(predict.y);
  // Skip if a bomb (real or predicted) is already on this tile.
  if (localBombs.some(b => b.tx === tx && b.ty === ty)) return;
  if (gameSnap.bombs.some(b => b.tx === tx && b.ty === ty)) return;
  // Enforce the bomb limit locally so prediction matches what the host allows —
  // count my own live bombs (the host tags each with its owner) plus any I've
  // predicted but it hasn't confirmed yet.
  const mine = gameSnap.bombs.filter(b => b.by === myId).length + localBombs.length;
  if (mine >= me.maxBombs) return;
  localBombs.push({ id: 'local-' + tx + '-' + ty + '-' + performance.now(), tx, ty, range: me.range, t: performance.now() });
  Net.placeBomb();
}

/* ─── Canvas ─────────────────────────────────────────────────────────────────── */
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');
let TILE = 40;

function resize() {
  const controls = document.getElementById('touch-controls');
  const showTouch = ('ontouchstart' in window) || window.innerWidth < 900;
  controls.style.display = showTouch ? 'flex' : 'none';

  const ctrlH = showTouch ? controls.offsetHeight || 165 : 0;
  const hudH  = document.getElementById('hud').offsetHeight || 40;
  const availW = window.innerWidth;
  const availH = window.innerHeight - hudH - ctrlH;

  TILE = Math.max(18, Math.min(
    Math.floor(availW / MAP_W),
    Math.floor(availH / MAP_H)
  ));

  canvas.width  = TILE * MAP_W;
  canvas.height = TILE * MAP_H;
}

window.addEventListener('resize', () => { if (screen === 'game') resize(); });

/* ─── Screen transitions ─────────────────────────────────────────────────────── */
function showScreen(name) {
  document.getElementById('screen-lobby').style.display = name === 'lobby' ? ''     : 'none';
  document.getElementById('screen-game') .style.display = name === 'game'  ? 'flex' : 'none';
  document.getElementById('screen-end')  .style.display = name === 'end'   ? 'flex' : 'none';
  screen = name;

  if (name === 'game') {
    resize();
    if (!rafHandle) rafHandle = requestAnimationFrame(renderLoop);
  } else {
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
    if (window.GameAudio) GameAudio.stopMusic();   // leaving the board → cut the music
  }
}

/* ─── Lobby helpers ──────────────────────────────────────────────────────────── */
function applyLobbyState(data) {
  roomId  = data.roomId;
  isHost  = data.hostId === myId;

  // Once we're in a room, the create/join controls are redundant — the room
  // code + "copy invite link" below handles sharing.
  ['btn-create', 'lobby-divider', 'join-row', 'join-error', 'btn-host-room']
    .forEach(id => { document.getElementById(id).style.display = 'none'; });

  document.getElementById('room-code').textContent  = data.roomId;
  document.getElementById('room-code-area').style.display = '';
  renderQR(`${location.origin}${location.pathname}?room=${data.roomId}`);

  const list = document.getElementById('player-list');
  list.innerHTML = data.players.map(p => {
    const isMe  = p.id === myId   ? ' (you)' : '';
    const crown = p.id === data.hostId ? '<span class="player-host-badge">HOST</span>' : '';
    return `<li style="color:${p.color}">${p.name}${isMe}${crown}</li>`;
  }).join('');

  const startBtn = document.getElementById('btn-start');
  const waitMsg  = document.getElementById('waiting-msg');
  const reloadBtn = document.getElementById('btn-reload');
  if (isHost) {
    startBtn.style.display = '';
    startBtn.disabled      = false;
    startBtn.textContent   = data.players.length < 2 ? 'Start (Solo Practice)' : 'Start Game';
    startBtn.title         = '';
    waitMsg.style.display  = 'none';
    reloadBtn.style.display = 'none';
  } else {
    startBtn.style.display = 'none';
    waitMsg.style.display  = data.players.length > 0 ? '' : 'none';
    // Escape hatch for guests left hanging if the host vanishes without a clean
    // "host left" signal — reload reconnects to the same room (code kept in URL).
    reloadBtn.style.display = '';
  }

  if (screen !== 'lobby') showScreen('lobby');
}

/* Render a small QR of the invite link into the lobby. The library is loaded
   from a CDN; if it's unavailable the QR (and its hint) are simply hidden — the
   "Copy Invite Link" button still covers sharing. */
function renderQR(url) {
  const box  = document.getElementById('qr-box');
  const hint = document.querySelector('.qr-hint');
  const hide = () => { box.style.display = 'none'; if (hint) hint.style.display = 'none'; };
  if (typeof qrcode === 'undefined') return hide();
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    box.innerHTML = qr.createImgTag(4, 0);
    box.style.display = '';
    if (hint) hint.style.display = '';
  } catch (e) { hide(); }
}

/* ─── Rendering ──────────────────────────────────────────────────────────────── */
function renderLoop() {
  if (screen !== 'game') { rafHandle = null; return; }
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  stepPrediction(dt);
  reportPosition();      // tell the host our tile whenever it changes
  animateRemotes(dt);
  draw();
  rafHandle = requestAnimationFrame(renderLoop);
}

/* Remote players are sent only as a target tile; slide their rendered position
   toward that tile centre at their own speed so motion looks smooth between the
   sparse (event-driven) snapshots. */
function animateRemotes(dt) {
  if (!gameSnap) return;
  for (const p of gameSnap.players) {
    if (p.id === myId) continue;
    const cx = p.tx + 0.5, cy = p.ty + 0.5;
    let a = anim[p.id];
    if (!a) { anim[p.id] = { x: cx, y: cy }; continue; }
    const sp = (p.speed || 6) * dt;
    const dx = cx - a.x, dy = cy - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= sp || dist < 1e-4) { a.x = cx; a.y = cy; }
    else { a.x += (dx / dist) * sp; a.y += (dy / dist) * sp; }
  }
}

/* Local movement for your own player. Movement is now client-authoritative — we
   simulate it here and report the result to the host (no snap-back from the
   host), so it stays perfectly smooth regardless of latency. Walls and bombs are
   still respected locally, including bombs we've only predicted, so you can never
   move through one. */
function predSolid(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return true;
  const v = grid[ty * MAP_W + tx];
  if (v === 1 || v === 2) return true;
  const onTile = Math.floor(predict.x) === tx && Math.floor(predict.y) === ty;
  for (const b of gameSnap.bombs) if (b.tx === tx && b.ty === ty) return !onTile;
  for (const b of localBombs)    if (b.tx === tx && b.ty === ty) return !onTile;
  return false;
}

function predChooseDir(input) {
  const tx = Math.floor(predict.x), ty = Math.floor(predict.y);
  let ordered = STEP_DIRS;
  if (predict.facing) {
    const f = STEP_DIRS.find(d => d.key === predict.facing.key);
    ordered = [f, ...STEP_DIRS.filter(d => d.key !== f.key)];
  }
  for (const d of ordered) {
    if (!input[d.key]) continue;
    if (!predSolid(tx + d.dx, ty + d.dy)) return d;
  }
  return null;
}

function stepPrediction(dt) {
  if (!gameSnap || !grid || !predict || countingDown) return;
  const me = gameSnap.players.find(p => p.id === myId);
  if (!me || !me.alive) return;

  const input = currentInput();
  let remaining = (me.speed || 6) * dt;
  let guard = 0;
  while (remaining > 0 && guard++ < 8) {
    if (!predict.moving) {
      const dir = predChooseDir(input);
      if (!dir) break;
      predict.facing = dir;
      predict.moving = true;
      predict.targetX = Math.floor(predict.x) + dir.dx + 0.5;
      predict.targetY = Math.floor(predict.y) + dir.dy + 0.5;
    }
    const dxT = predict.targetX - predict.x;
    const dyT = predict.targetY - predict.y;
    const dist = Math.abs(dxT) + Math.abs(dyT);
    if (dist <= remaining + 1e-6) {
      predict.x = predict.targetX;
      predict.y = predict.targetY;
      remaining -= dist;
      predict.moving = false;
    } else {
      predict.x += Math.sign(dxT) * Math.min(remaining, Math.abs(dxT));
      predict.y += Math.sign(dyT) * Math.min(remaining, Math.abs(dyT));
      remaining = 0;
    }
  }
}

function draw() {
  if (!gameSnap || !grid) return;
  ensureBuffer();
  const { players, bombs, explosions, powerups } = gameSnap;
  const nowT = performance.now();

  bctx.clearRect(0, 0, buf.width, buf.height);

  // Tiles
  for (let ty = 0; ty < MAP_H; ty++)
    for (let tx = 0; tx < MAP_W; tx++)
      drawTileArt(tx, ty, grid[ty * MAP_W + tx]);

  // Power-ups sit on the ground, beneath everything
  for (const pu of powerups) drawPowerupArt(pu, nowT);

  // Bombs (real, from the host) plus any we've predicted locally for instant feedback
  for (const bomb of bombs) drawBombArt(bomb, nowT);
  for (const bomb of localBombs) drawBombArt(bomb, nowT);

  // Players — local drawn last so it sits on top
  const order = [...players].sort((a, b) => (a.id === myId ? 1 : 0) - (b.id === myId ? 1 : 0));
  for (const p of order) if (p.alive) drawPlayerArt(p);

  // Explosions — bright flames over everything
  for (const exp of explosions) {
    if (!expSeen[exp.id]) expSeen[exp.id] = nowT;
    drawExplosionArt(exp, nowT);
  }

  // Blit the low-res buffer to the display canvas, crisp (nearest-neighbour)
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(buf, 0, 0, buf.width, buf.height, 0, 0, canvas.width, canvas.height);

  updateHUD(players);
}

// ─── Pixel-art rendering ──────────────────────────────────────────────────────
const ART = 16;                 // art-pixels per tile in the low-res buffer
let buf = null, bctx = null;

function ensureBuffer() {
  const w = MAP_W * ART, h = MAP_H * ART;
  if (!buf || buf.width !== w || buf.height !== h) {
    buf = document.createElement('canvas');
    buf.width = w; buf.height = h;
    bctx = buf.getContext('2d');
    bctx.imageSmoothingEnabled = false;
  }
}

function hash2(x, y) { return (((x * 73856093) ^ (y * 19349663)) >>> 0); }
function R(x, y, w, h, c) { bctx.fillStyle = c; bctx.fillRect(x | 0, y | 0, w, h); }
function fillCircleArt(cx, cy, r, c) {
  bctx.fillStyle = c;
  for (let yy = -r; yy <= r; yy++) {
    const span = Math.floor(Math.sqrt(Math.max(0, r * r - yy * yy)));
    bctx.fillRect(Math.round(cx - span), Math.round(cy + yy), span * 2 + 1, 1);
  }
}
function renderPos(p) {
  if (p.id === myId && predict) return { x: predict.x, y: predict.y };
  if (anim[p.id]) return anim[p.id];
  return { x: p.tx + 0.5, y: p.ty + 0.5 };
}

function drawTileArt(tx, ty, tile) {
  const ox = tx * ART, oy = ty * ART;
  const hsh = hash2(tx + 1, ty + 1);
  if (tile === 0) {
    // Grass with subtle texture, the odd flower or pebble
    R(ox, oy, ART, ART, (tx + ty) % 2 ? '#6fa44c' : '#69a047');
    if (hsh & 1)  R(ox + 3,  oy + 4,  2, 1, '#5d9040');
    if (hsh & 2)  R(ox + 11, oy + 9,  2, 1, '#5d9040');
    if (hsh & 4)  R(ox + 7,  oy + 12, 1, 1, '#83bd5f');
    if (hsh & 8)  R(ox + 13, oy + 3,  1, 1, '#83bd5f');
    if (hsh & 16) R(ox + 5,  oy + 8,  1, 1, '#5d9040');
    const f = hsh % 13;
    if (f === 0)      { R(ox + 6, oy + 6, 2, 2, '#e7d24a'); R(ox + 6, oy + 6, 1, 1, '#fff4b0'); }
    else if (f === 1) { R(ox + 9, oy + 10, 2, 2, '#e06b8b'); R(ox + 9, oy + 10, 1, 1, '#ffd0de'); }
    else if (f === 2) { R(ox + 4, oy + 11, 2, 2, '#9aa3b3'); }
  } else if (tile === 1) {
    // Indestructible carved stone block
    R(ox, oy, 16, 16, '#4f5766');            // recessed mortar
    R(ox + 1, oy + 1, 14, 13, '#7c8595');    // stone face
    R(ox + 1, oy + 1, 14, 2, '#9fa9b8');     // top highlight
    R(ox + 1, oy + 1, 2, 13, '#8e98a8');     // left highlight
    R(ox + 1, oy + 12, 14, 2, '#5c6473');    // bottom shadow
    R(ox + 13, oy + 1, 2, 13, '#646d7c');    // right shadow
    R(ox + 3, oy + 3, 1, 1, '#b6bdca');      // corner studs
    R(ox + 12, oy + 3, 1, 1, '#525a69');
    R(ox + 3, oy + 11, 1, 1, '#525a69');
    R(ox + 12, oy + 11, 1, 1, '#525a69');
    R(ox + 7, oy + 5, 1, 4, '#69727f');      // crack
    R(ox + 8, oy + 8, 1, 3, '#69727f');
    R(ox + 5, oy + 10, 1, 1, '#8d96a6');     // speckles
    R(ox + 10, oy + 6, 1, 1, '#6c7585');
  } else if (tile === 2) {
    // Destructible wooden crate — framed planks with iron studs
    R(ox, oy, 16, 16, '#5a3a20');            // dark outline
    R(ox + 1, oy + 1, 14, 14, '#9c6536');    // wood base
    R(ox + 5, oy + 1, 1, 14, '#6e4524');     // plank seams
    R(ox + 10, oy + 1, 1, 14, '#6e4524');
    R(ox + 2, oy + 1, 1, 13, '#c08a52');     // plank highlights
    R(ox + 7, oy + 1, 1, 13, '#b6793f');
    R(ox + 12, oy + 1, 1, 13, '#b6793f');
    R(ox + 1, oy + 1, 14, 2, '#bd8146');     // top rail
    R(ox + 1, oy + 12, 14, 3, '#704a29');    // bottom rail shadow
    R(ox + 2, oy + 2, 2, 2, '#d9b074');      // iron corner studs
    R(ox + 12, oy + 2, 2, 2, '#d9b074');
    R(ox + 2, oy + 12, 2, 2, '#d9b074');
    R(ox + 12, oy + 12, 2, 2, '#d9b074');
  }
}

function drawBombArt(bomb, nowT) {
  if (!bombSeen[bomb.id]) bombSeen[bomb.id] = nowT;
  const age = nowT - bombSeen[bomb.id];
  const urgency = Math.max(0, Math.min(1, age / BOMB_FUSE_MS));
  const blink = urgency > 0.55 && (Math.floor(age / 120) % 2 === 0);
  const cx = bomb.tx * ART + 8, cy = bomb.ty * ART + 9;
  const r = 5 + (urgency > 0.5 && (Math.floor(age / 90) % 2) ? 1 : 0);
  fillCircleArt(cx, cy + 5, r - 1, 'rgba(0,0,0,0.28)');
  fillCircleArt(cx, cy, r, blink ? '#7a3535' : '#2e2e3a');
  R(cx - 1, cy + r - 2, 3, 1, '#1a1a24');
  R(cx - 2, cy - 3, 2, 2, '#9a9ab5');
  R(cx - 2, cy - 3, 1, 1, '#d7d7ec');
  R(cx + 2, cy - r - 1, 2, 2, '#8a929e');
  R(cx + 4, cy - r - 2, 1, 1, '#b58b4c');
  R(cx + 5, cy - r - 3, 1, 1, '#b58b4c');
  const sc = (Math.floor(age / 80) % 2) ? '#ffd34d' : '#ff7a1a';
  R(cx + 5, cy - r - 4, 1, 1, sc);
  if (urgency > 0.5) R(cx + 6, cy - r - 4, 1, 1, '#fff2b0');
}

function drawPlayerArt(p) {
  const meta = playerMeta[p.id] || { name: '', color: '#888' };
  const pos = renderPos(p);
  const cx = Math.round(pos.x * ART), cy = Math.round(pos.y * ART);
  const body = meta.color;
  const outline = p.id === myId ? '#fdf6d0' : darken(body, 60);
  fillCircleArt(cx, cy + 6, 5, 'rgba(0,0,0,0.25)');   // shadow
  fillCircleArt(cx, cy, 7, outline);                  // rim
  fillCircleArt(cx, cy, 6, body);                     // body
  fillCircleArt(cx - 2, cy - 3, 3, lighten(body, 45));// top highlight
  R(cx - 3, cy + 2, 6, 2, lighten(body, 18));         // belly
  R(cx - 3, cy - 2, 2, 3, '#ffffff');                 // eyes
  R(cx + 1, cy - 2, 2, 3, '#ffffff');
  R(cx - 3, cy - 1, 1, 2, '#27313f');                 // pupils
  R(cx + 2, cy - 1, 1, 2, '#27313f');
}

function drawPowerupArt(pu, nowT) {
  const bob = Math.round(Math.sin(nowT / 350 + pu.tx));
  fillCircleArt(pu.tx * ART + 8, pu.ty * ART + 14, 5, 'rgba(0,0,0,0.18)');   // ground shadow
  paintPowerup(bctx, pu.type, pu.tx * ART, pu.ty * ART + bob, 1);
}

/* Power-up icon, drawn on a 16×16 art grid into any 2D context. Used both for
   the in-game pickups (u=1 into the low-res buffer) and the How-to-Play menu
   (larger u into small canvases) so the two always match exactly. */
function paintPowerup(g, type, ox, oy, u) {
  const rr = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(ox + x * u, oy + y * u, w * u, h * u); };
  const disc = (cx, cy, r, c) => {
    g.fillStyle = c;
    for (let yy = -r; yy <= r; yy++) {
      const span = Math.floor(Math.sqrt(Math.max(0, r * r - yy * yy)));
      g.fillRect(ox + (cx - span) * u, oy + (cy + yy) * u, (span * 2 + 1) * u, u);
    }
  };

  const theme = {
    bomb:  { base: '#4a90e2', rim: '#2c5f9e', hi: '#9fc6f2' },
    range: { base: '#ef6d3a', rim: '#b8431d', hi: '#ffb083' },
    speed: { base: '#1bb6c9', rim: '#127f8e', hi: '#86e6f1' },
  }[type] || { base: '#888', rim: '#555', hi: '#bbb' };

  // Floating orb
  disc(8, 8, 6, theme.rim);
  disc(8, 8, 5, theme.base);
  disc(6, 6, 2, theme.hi);             // glossy highlight

  if (type === 'bomb') {
    // Dark bomb with a fuse spark + a white "+" badge (= one more bomb).
    disc(8, 9, 3, '#23232c');
    rr(6, 8, 1, 1, '#aab4c8');         // shine
    rr(10, 5, 1, 1, '#caa477');        // fuse
    rr(11, 4, 1, 1, '#caa477');
    rr(11, 3, 1, 1, '#ffd34d');        // spark
    rr(3, 4, 3, 1, '#ffffff');         // + badge
    rr(4, 3, 1, 3, '#ffffff');
  } else if (type === 'range') {
    // Explosion starburst (= bigger blast).
    rr(7, 4, 2, 3, '#ffe34d');         // up spike
    rr(7, 9, 2, 3, '#ffe34d');         // down spike
    rr(4, 7, 3, 2, '#ffe34d');         // left spike
    rr(9, 7, 3, 2, '#ffe34d');         // right spike
    rr(7, 7, 2, 2, '#ffffff');         // hot core
    rr(5, 5, 1, 1, '#fff3b0');         // diagonal sparks
    rr(10, 5, 1, 1, '#fff3b0');
    rr(5, 10, 1, 1, '#fff3b0');
    rr(10, 10, 1, 1, '#fff3b0');
  } else if (type === 'speed') {
    // White lightning bolt (= move faster).
    rr(10, 3, 2, 1, '#ffffff');
    rr(9, 4, 2, 1, '#ffffff');
    rr(8, 5, 2, 1, '#ffffff');
    rr(6, 6, 5, 1, '#ffffff');         // kink
    rr(8, 7, 2, 1, '#ffffff');
    rr(7, 8, 2, 1, '#ffffff');
    rr(6, 9, 2, 1, '#ffffff');
    rr(8, 6, 1, 1, '#bfeef6');         // subtle inner shade
  }
}

function drawExplosionArt(exp, nowT) {
  const remain = EXPLOSION_TTL_MS - (nowT - expSeen[exp.id]);
  const a = Math.max(0, Math.min(1, remain / 220));
  if (a <= 0) return;
  for (const [tx, ty] of exp.tiles) {
    const ox = tx * ART, oy = ty * ART;
    const flick = hash2(tx * 7 + Math.floor(nowT / 60), ty * 3) & 3;
    bctx.fillStyle = `rgba(214,64,18,${a})`;
    bctx.fillRect(ox + 1, oy + 1, ART - 2, ART - 2);
    bctx.fillStyle = `rgba(247,148,30,${a})`;
    bctx.fillRect(ox + 3, oy + 3, ART - 6, ART - 6);
    bctx.fillStyle = `rgba(255,233,120,${a})`;
    bctx.fillRect(ox + 5, oy + 5, ART - 10, ART - 10);
    bctx.fillStyle = `rgba(255,210,90,${a})`;
    if (flick & 1) bctx.fillRect(ox + 2, oy + 7, 1, 1);
    if (flick & 2) bctx.fillRect(ox + ART - 3, oy + 6, 1, 1);
  }
}

function darken(hex, amt) {
  const c = parseInt(hex.slice(1), 16);
  const r = Math.max(0, (c >> 16) - amt);
  const g = Math.max(0, ((c >> 8) & 0xff) - amt);
  const b = Math.max(0, (c & 0xff) - amt);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function updateHUD(players) {
  const hud = document.getElementById('hud');
  hud.innerHTML = players.map(p => {
    const meta   = playerMeta[p.id] || { name: '', color: '#888' };
    const bombs  = '💣'.repeat(p.maxBombs);
    const ranges = '✦'.repeat(Math.max(0, p.range - 1));
    const dead   = !p.alive;
    return `<div class="hud-player${p.id === myId ? ' hud-me' : ''}${dead ? ' hud-dead' : ''}"
                 style="border-color:${meta.color}">
      <span class="hud-name" style="color:${meta.color}">${meta.name}${dead ? ' 💀' : ''}</span>
      <span class="hud-stats">${bombs}${ranges ? ' ' + ranges : ''}</span>
    </div>`;
  }).join('');
}

/* ─── Utility: lighten a hex color ──────────────────────────────────────────── */
function lighten(hex, amt) {
  let c = parseInt(hex.slice(1), 16);
  const r = Math.min(255, (c >> 16) + amt);
  const g = Math.min(255, ((c >> 8) & 0xff) + amt);
  const b = Math.min(255, (c & 0xff) + amt);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

/* ─── Keyboard input ─────────────────────────────────────────────────────────── */
window.addEventListener('keydown', e => {
  if (screen !== 'game') return;   // don't hijack typing in the lobby
  let changed = true;
  switch (e.code) {
    case 'ArrowUp':    case 'KeyW': keyState.up    = true; break;
    case 'ArrowDown':  case 'KeyS': keyState.down  = true; break;
    case 'ArrowLeft':  case 'KeyA': keyState.left  = true; break;
    case 'ArrowRight': case 'KeyD': keyState.right = true; break;
    case 'Space': case 'KeyX': case 'KeyZ':
      if (!e.repeat) doPlaceBomb();   // rising edge → one bomb per press
      break;
    default: changed = false;
  }
  if (changed) e.preventDefault();
});

window.addEventListener('keyup', e => {
  if (screen !== 'game') return;
  switch (e.code) {
    case 'ArrowUp':    case 'KeyW': keyState.up    = false; break;
    case 'ArrowDown':  case 'KeyS': keyState.down  = false; break;
    case 'ArrowLeft':  case 'KeyA': keyState.left  = false; break;
    case 'ArrowRight': case 'KeyD': keyState.right = false; break;
  }
});

/* ─── Touch / D-pad controls ─────────────────────────────────────────────────── */
function setupTouchControls() {
  const dpadBtns = document.querySelectorAll('.dpad-btn');

  function setDir(el, active) {
    const dir = el.dataset.dir;
    touchState[dir] = active;
    el.classList.toggle('pressed', active);
  }

  dpadBtns.forEach(btn => {
    btn.addEventListener('touchstart',  e => { e.preventDefault(); setDir(btn, true);  }, { passive: false });
    btn.addEventListener('touchend',    e => { e.preventDefault(); setDir(btn, false); }, { passive: false });
    btn.addEventListener('touchcancel', e => { e.preventDefault(); setDir(btn, false); }, { passive: false });
    // Mouse fallback for desktop testing
    btn.addEventListener('mousedown',  () => setDir(btn, true));
    btn.addEventListener('mouseup',    () => setDir(btn, false));
    btn.addEventListener('mouseleave', () => setDir(btn, false));
  });

  // Bomb button drops a bomb on press (one per tap), with a quick pressed style.
  const bombBtn = document.getElementById('bomb-btn');
  const flash = () => { bombBtn.classList.add('pressed'); setTimeout(() => bombBtn.classList.remove('pressed'), 120); };
  bombBtn.addEventListener('touchstart', e => { e.preventDefault(); doPlaceBomb(); flash(); }, { passive: false });
  bombBtn.addEventListener('mousedown',  () => { doPlaceBomb(); flash(); });
}

/* ─── Net events ─────────────────────────────────────────────────────────────── */
Net.onRoomCreated = ({ roomId: id, playerId }) => {
  myId   = playerId;
  roomId = id;
  lockJoinUI();
  armQuitGuard();
};

Net.onRoomJoined = ({ roomId: id, playerId }) => {
  myId   = playerId;
  roomId = id;
  lockJoinUI();
  armQuitGuard();
};

Net.onLobbyState = data => {
  applyLobbyState(data);
};

Net.onJoinError = msg => {
  document.getElementById('join-error').textContent = msg;
  // If the room is simply gone (host left, or never existed), offer to host it
  // under the same code so any shared invite link keeps working.
  const hostBtn = document.getElementById('btn-host-room');
  hostBtn.style.display = (msg === 'Room not found' && pendingJoinCode) ? '' : 'none';
};

Net.onHostLeft = () => {
  alert('The host left — the game has ended.');
  location.reload();
};

Net.onGameStart = ({ mapW, mapH, grid: g, players }) => {
  MAP_W = mapW;
  MAP_H = mapH;
  grid = g;
  playerMeta = {};
  (players || []).forEach(p => { playerMeta[p.id] = { name: p.name, color: p.color }; });
  anim = {};
  bombSeen = {};
  expSeen = {};
  localBombs = [];
  predict = null;
  gameSnap = null;
  lastReport = '';
  lastFrame = performance.now();
  showScreen('game');
  runCountdown();
};

/* 3-2-1-GO intro. Freezes input/prediction until "GO!" (the host holds the
   simulation for the same duration), with a beep on each beat. */
function runCountdown() {
  const el = document.getElementById('countdown');
  if (!el) return;
  countingDown = true;
  const show = txt => {
    el.textContent = txt;
    el.style.display = 'flex';
    el.classList.remove('pop');
    void el.offsetWidth;          // restart the CSS pop animation
    el.classList.add('pop');
  };
  show('3'); if (window.GameAudio) GameAudio.sfx('count');
  setTimeout(() => { show('2'); GameAudio.sfx('count'); }, 700);
  setTimeout(() => { show('1'); GameAudio.sfx('count'); }, 1400);
  setTimeout(() => {                          // GO! — play begins
    show('GO!'); GameAudio.sfx('go');
    countingDown = false;
    GameAudio.startMusic();
  }, 2100);
  setTimeout(() => { el.style.display = 'none'; }, 2750);
}

Net.onGameState = snap => {
  if (snap.grid) grid = snap.grid;   // only sent when it changed

  // Movement is client-authoritative, so we never snap our own position to the
  // host's. We only seed prediction once (our spawn, from the first snapshot we
  // see ourselves in). Death is host-authoritative — stepPrediction stops us when
  // the host marks us dead.
  const me = snap.players.find(p => p.id === myId);
  if (me && !predict) {
    const cx = me.tx + 0.5, cy = me.ty + 0.5;
    predict = { x: cx, y: cy, moving: false, facing: null, targetX: cx, targetY: cy };
  }

  // Drop predicted bombs once the host has confirmed a real bomb on that tile,
  // or after a short timeout (e.g. the host rejected it — bomb limit reached).
  if (localBombs.length) {
    const nowT = performance.now();
    localBombs = localBombs.filter(b =>
      !snap.bombs.some(rb => rb.tx === b.tx && rb.ty === b.ty) && (nowT - b.t) < 1500);
  }

  // Prune local timers for bombs/explosions that no longer exist
  const bombIds = new Set(snap.bombs.map(b => b.id));
  for (const id in bombSeen) if (!bombIds.has(id)) delete bombSeen[id];
  const expIds = new Set(snap.explosions.map(e => e.id));
  for (const id in expSeen) if (!expIds.has(id)) delete expSeen[id];

  detectGameAudio(gameSnap, snap);   // gameSnap is still the previous snapshot here
  gameSnap = snap;
  if (snap.state === 'ended') {
    setTimeout(() => showEndScreen(snap.winner), 700);
  }
};

/* Compare consecutive snapshots and fire the matching SFX. At most one of each
   kind per snapshot so a multi-bomb chain doesn't turn into a wall of noise. */
function detectGameAudio(prev, snap) {
  if (!prev || !window.GameAudio) return;   // skip the very first snapshot

  if (snap.bombs.some(b => !prev.bombs.find(o => o.id === b.id))) GameAudio.sfx('place');
  if (snap.explosions.some(e => !prev.explosions.find(o => o.id === e.id))) GameAudio.sfx('boom');
  if (prev.powerups.some(p => !snap.powerups.find(o => o.id === p.id))) GameAudio.sfx('power');

  const wasAlive = {};
  prev.players.forEach(p => { wasAlive[p.id] = p.alive; });
  if (snap.players.some(p => wasAlive[p.id] && !p.alive)) GameAudio.sfx('death');

  if (snap.state === 'ended' && prev.state !== 'ended') GameAudio.sfx('win');
}

/* ─── End screen ─────────────────────────────────────────────────────────────── */
function showEndScreen(winner) {
  const el = document.getElementById('winner-text');
  if (winner) {
    el.innerHTML = `<span style="color:${winner.color}">${winner.name}</span><br>wins!`;
  } else {
    el.textContent = "It's a draw!";
  }

  // Running room scoreboard (match wins per player, highest first).
  const scoresEl = document.getElementById('end-scores');
  const players = (gameSnap && gameSnap.players) ? [...gameSnap.players] : [];
  if (players.length) {
    const rows = players
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .map(p => {
        const meta = playerMeta[p.id] || { name: '?', color: '#888' };
        return `<div class="score-row"><span style="color:${meta.color}">${meta.name}</span>` +
               `<span class="score-num">${p.score || 0}</span></div>`;
      }).join('');
    scoresEl.innerHTML = `<div class="score-title">Wins</div>${rows}`;
  } else {
    scoresEl.innerHTML = '';
  }

  // Only the host controls what happens next; guests just wait to be taken back.
  document.getElementById('btn-play-again').style.display = isHost ? '' : 'none';
  document.getElementById('btn-back-lobby').style.display = isHost ? '' : 'none';
  document.getElementById('end-waiting').style.display    = isHost ? 'none' : '';
  showScreen('end');
}

/* ─── UI helpers ─────────────────────────────────────────────────────────────── */
function lockJoinUI() {
  // Disable create/join once in a room. The name field stays editable so you
  // can change your display name from the lobby (Net.setName propagates it).
  document.getElementById('btn-create').disabled = true;
  document.getElementById('btn-join').disabled   = true;
  document.getElementById('join-input').disabled  = true;
}

/* ─── Quit guard ─────────────────────────────────────────────────────────────
   Players were accidentally leaving mid-game via the browser back button, a
   swipe-back gesture, or a tab close. Warn before any of those unload the page,
   and intercept history back-navigation with a confirm so it can be cancelled. */
function armQuitGuard() {
  if (inRoom) return;
  inRoom = true;
  // Keep the room code in the URL so a reload (manual or via the reload button)
  // lands back on this room and can reconnect.
  if (roomId) history.replaceState(null, '', `${location.pathname}?room=${roomId}`);
  // Seed a history entry so a back press has something to pop — letting us catch
  // it in the popstate handler instead of silently leaving. Skipped in test mode.
  if (!TEST_MODE) history.pushState(null, '', location.href);
}

window.addEventListener('beforeunload', e => {
  if (inRoom && !TEST_MODE) { e.preventDefault(); e.returnValue = ''; }
});

window.addEventListener('popstate', () => {
  if (!inRoom || TEST_MODE) return;
  if (window.confirm('Leave the game and exit the room?')) {
    inRoom = false;
    location.href = location.origin + location.pathname;   // reset (drops ?room)
  } else {
    history.pushState(null, '', location.href);            // cancel — stay put
  }
});

/* ─── Init ───────────────────────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  setupTouchControls();

  // Audio needs a user gesture to start; unlock on the first interaction.
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    window.addEventListener(ev, () => GameAudio.unlock(), { once: true }));

  // Mute toggle (persisted in GameAudio via localStorage).
  const muteBtn = document.getElementById('btn-mute');
  const syncMute = () => { muteBtn.textContent = GameAudio.isMuted() ? '🔇' : '🔊'; };
  syncMute();
  muteBtn.addEventListener('click', () => {
    GameAudio.unlock();
    GameAudio.setMuted(!GameAudio.isMuted());
    syncMute();
  });

  if (TEST_MODE) {
    GameAudio.disable();   // keep automated previews silent
    console.log('[BomberBlast] TEST MODE — quit guards + audio disabled (use ?test=0 to turn off)');
    const badge = document.createElement('div');
    badge.id = 'test-badge';
    badge.textContent = 'TEST MODE';
    document.body.appendChild(badge);
  }

  // Arriving via an invite link → prefill the code and present a join-only
  // screen (hide the create option + divider; the host already made the room).
  const urlRoom = new URLSearchParams(window.location.search).get('room');
  if (urlRoom) {
    document.getElementById('join-input').value = urlRoom.toUpperCase();
    document.getElementById('btn-create').style.display = 'none';
    document.getElementById('lobby-divider').style.display = 'none';
  }

  // Remember the player's name across visits, and let them change it live in the
  // lobby (Net.setName tells the host, who rebroadcasts the updated player list).
  const nameInput = document.getElementById('name-input');
  const savedName = localStorage.getItem(NAME_KEY);
  if (savedName && !nameInput.value) nameInput.value = savedName;
  nameInput.addEventListener('input', () => {
    const n = nameInput.value.trim();
    if (!n) return;
    localStorage.setItem(NAME_KEY, n);
    if (inRoom) Net.setName(n);
  });

  // ─── How to Play ─────────────────────────────────────────────────────────
  // Render the power-up icons with the exact same routine the game uses, so the
  // key matches what players actually see on the board.
  document.querySelectorAll('.pu-icon').forEach(cv => {
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    paintPowerup(g, cv.dataset.pu, 0, 0, cv.width / 16);
  });

  const helpModal = document.getElementById('help-modal');
  document.getElementById('btn-help').addEventListener('click', () => { helpModal.style.display = 'flex'; });
  document.getElementById('btn-help-close').addEventListener('click', () => { helpModal.style.display = 'none'; });
  helpModal.addEventListener('click', e => { if (e.target === helpModal) helpModal.style.display = 'none'; });

  // Create room
  document.getElementById('btn-create').addEventListener('click', () => {
    const name = document.getElementById('name-input').value.trim();
    if (!name) { alert('Enter your name first!'); return; }
    Net.createRoom(name);
  });

  // Join room
  document.getElementById('btn-join').addEventListener('click', doJoin);
  document.getElementById('join-input').addEventListener('keypress', e => {
    if (e.key === 'Enter') doJoin();
  });
  document.getElementById('name-input').addEventListener('keypress', e => {
    if (e.key === 'Enter') document.getElementById('btn-create').click();
  });

  function doJoin() {
    const name = document.getElementById('name-input').value.trim();
    const code = document.getElementById('join-input').value.trim().toUpperCase();
    if (!name) { alert('Enter your name first!'); return; }
    if (!code) { alert('Enter a room code!'); return; }
    document.getElementById('join-error').textContent = '';
    document.getElementById('btn-host-room').style.display = 'none';
    pendingJoinCode = code;
    Net.joinRoom(code, name);
  }

  // "Room not found" fallback → host the room under the same code.
  document.getElementById('btn-host-room').addEventListener('click', () => {
    const name = document.getElementById('name-input').value.trim();
    if (!name) { alert('Enter your name first!'); return; }
    if (!pendingJoinCode) return;
    document.getElementById('join-error').textContent = '';
    document.getElementById('btn-host-room').style.display = 'none';
    Net.createRoom(name, pendingJoinCode);
  });

  // Copy invite link
  document.getElementById('btn-copy').addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}?room=${roomId}`;
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('btn-copy');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy Invite Link'; }, 2000);
    }).catch(() => {
      prompt('Copy this link:', `${location.origin}${location.pathname}?room=${roomId}`);
    });
  });

  // Start game (host)
  document.getElementById('btn-start').addEventListener('click', () => {
    Net.startGame();
  });

  // Play again (host) → straight into a fresh match (scores carry over). The
  // separate "Back to Lobby" button is there if they'd rather regroup first.
  document.getElementById('btn-play-again').addEventListener('click', () => {
    Net.startGame();
  });

  // Exit game → back to menu
  document.getElementById('btn-exit').addEventListener('click', () => {
    Net.exitToLobby();
  });

  // Back to lobby
  document.getElementById('btn-back-lobby').addEventListener('click', () => {
    if (roomId) Net.playAgain();
    else showScreen('lobby');
  });

  // Reload & reconnect (for guests stuck if the host vanished). Clear the quit
  // guard first so the reload doesn't trigger the "leave site?" warning.
  document.getElementById('btn-reload').addEventListener('click', () => {
    inRoom = false;
    location.reload();
  });

  // After a reload, if we have both a room code (kept in the URL) and a
  // remembered name, rejoin automatically so reconnecting is hands-free. If the
  // room is gone, onJoinError surfaces the "host this room instead" option.
  if (urlRoom && nameInput.value.trim()) doJoin();
});
