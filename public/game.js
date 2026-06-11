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
let serverSelf = null; // latest authoritative tile for the local player { tx, ty, mv }

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
let lastSentInput = '';

function currentInput() {
  return {
    up:    keyState.up    || touchState.up,
    down:  keyState.down  || touchState.down,
    left:  keyState.left  || touchState.left,
    right: keyState.right || touchState.right,
    bomb:  keyState.bomb  || touchState.bomb,
  };
}

function sendInput() {
  if (screen !== 'game') return;
  const inp = currentInput();
  const str = JSON.stringify(inp);
  if (str !== lastSentInput) {
    lastSentInput = str;
    Net.sendInput(inp);
  }
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
  }
}

/* ─── Lobby helpers ──────────────────────────────────────────────────────────── */
function applyLobbyState(data) {
  roomId  = data.roomId;
  isHost  = data.hostId === myId;

  document.getElementById('room-code').textContent  = data.roomId;
  document.getElementById('room-code-area').style.display = '';

  const list = document.getElementById('player-list');
  list.innerHTML = data.players.map(p => {
    const isMe  = p.id === myId   ? ' (you)' : '';
    const crown = p.id === data.hostId ? '<span class="player-host-badge">HOST</span>' : '';
    return `<li style="color:${p.color}">${p.name}${isMe}${crown}</li>`;
  }).join('');

  const startBtn = document.getElementById('btn-start');
  const waitMsg  = document.getElementById('waiting-msg');
  if (isHost) {
    startBtn.style.display = '';
    startBtn.disabled      = false;
    startBtn.textContent   = data.players.length < 2 ? 'Start (Solo Practice)' : 'Start Game';
    startBtn.title         = '';
    waitMsg.style.display  = 'none';
  } else {
    startBtn.style.display = 'none';
    waitMsg.style.display  = data.players.length > 0 ? '' : 'none';
  }

  if (screen !== 'lobby') showScreen('lobby');
}

/* ─── Rendering ──────────────────────────────────────────────────────────────── */
function renderLoop() {
  if (screen !== 'game') { rafHandle = null; return; }
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  stepPrediction(dt);
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

/* Client-side prediction for the local player — mirrors the server's grid-step
   movement so your own character responds instantly instead of waiting for a
   network round-trip. The server stays authoritative; gameState reconciles. */
function predSolid(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return true;
  const v = grid[ty * MAP_W + tx];
  if (v === 1 || v === 2) return true;
  for (const b of gameSnap.bombs) {
    if (b.tx === tx && b.ty === ty) {
      return !(Math.floor(predict.x) === tx && Math.floor(predict.y) === ty);
    }
  }
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
  if (!gameSnap || !grid || !predict) return;
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

  // Once WE have come to rest and the server is also at rest, snap to the
  // server's authoritative tile. This corrects any drift that built up during
  // a fast scramble. It runs every frame (not just on packet arrival), so it
  // works even though idle-skip means no snapshot is sent while standing still.
  if (!predict.moving && serverSelf && serverSelf.mv === 0) {
    if (Math.floor(predict.x) !== serverSelf.tx || Math.floor(predict.y) !== serverSelf.ty) {
      predict.x = serverSelf.tx + 0.5;
      predict.y = serverSelf.ty + 0.5;
      predict.targetX = predict.x;
      predict.targetY = predict.y;
      predict.facing = null;
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

  // Bombs
  for (const bomb of bombs) drawBombArt(bomb, nowT);

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

  // Name tags drawn on top at display resolution so text stays sharp
  for (const p of players) {
    if (!p.alive) continue;
    const meta = playerMeta[p.id] || { name: '', color: '#888' };
    const pos = renderPos(p);
    drawNameTag(meta.name, pos.x * TILE, pos.y * TILE - TILE * 0.6, p.id === myId);
  }

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
  const cx = pu.tx * ART + 8, cy = pu.ty * ART + 8 + bob;
  fillCircleArt(cx, pu.ty * ART + 13, 4, 'rgba(0,0,0,0.18)');
  if (pu.type === 'bomb') {
    fillCircleArt(cx, cy, 4, '#2e2e3a');
    R(cx - 1, cy - 2, 2, 2, '#9a9ab5');
    R(cx - 5, cy, 1, 1, '#e67e22'); R(cx + 5, cy, 1, 1, '#e67e22');
    R(cx, cy - 5, 1, 1, '#e67e22'); R(cx, cy + 5, 1, 1, '#e67e22');
  } else if (pu.type === 'range') {
    fillCircleArt(cx, cy, 4, '#e0432b');
    fillCircleArt(cx, cy + 1, 3, '#f0851f');
    R(cx - 1, cy - 1, 2, 2, '#ffe34d');
  } else if (pu.type === 'speed') {
    R(cx + 1, cy - 5, 2, 3, '#39c6dd');
    R(cx - 1, cy - 2, 3, 3, '#39c6dd');
    R(cx - 2, cy + 1, 3, 4, '#39c6dd');
    R(cx, cy - 1, 1, 1, '#dffaff');
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

function drawNameTag(name, cx, topY, isMe) {
  if (!name) return;
  const fSize = Math.max(8, Math.floor(TILE * 0.2));
  ctx.font = `${fSize}px "Silkscreen", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = Math.ceil(ctx.measureText(name).width) + 8;
  const th = fSize + 6;
  const y = topY - th;
  ctx.fillStyle = isMe ? 'rgba(74,48,22,0.9)' : 'rgba(20,16,12,0.7)';
  roundRect(ctx, Math.round(cx - tw / 2), Math.round(y), tw, th, 4);
  ctx.fillStyle = '#fdf6e3';
  ctx.fillText(name, cx, y + th / 2 + 1);
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

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
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
    case 'Space': case 'KeyX': case 'KeyZ': keyState.bomb = true; break;
    default: changed = false;
  }
  if (changed) { e.preventDefault(); sendInput(); }
});

window.addEventListener('keyup', e => {
  if (screen !== 'game') return;
  let changed = true;
  switch (e.code) {
    case 'ArrowUp':    case 'KeyW': keyState.up    = false; break;
    case 'ArrowDown':  case 'KeyS': keyState.down  = false; break;
    case 'ArrowLeft':  case 'KeyA': keyState.left  = false; break;
    case 'ArrowRight': case 'KeyD': keyState.right = false; break;
    case 'Space': case 'KeyX': case 'KeyZ': keyState.bomb = false; break;
    default: changed = false;
  }
  if (changed) sendInput();
});

/* ─── Touch / D-pad controls ─────────────────────────────────────────────────── */
function setupTouchControls() {
  const dpadBtns = document.querySelectorAll('.dpad-btn');

  function setDir(el, active) {
    const dir = el.dataset.dir;
    touchState[dir] = active;
    el.classList.toggle('pressed', active);
    sendInput();
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

  const bombBtn = document.getElementById('bomb-btn');
  function setBomb(active) {
    touchState.bomb = active;
    bombBtn.classList.toggle('pressed', active);
    sendInput();
  }
  bombBtn.addEventListener('touchstart',  e => { e.preventDefault(); setBomb(true);  }, { passive: false });
  bombBtn.addEventListener('touchend',    e => { e.preventDefault(); setBomb(false); }, { passive: false });
  bombBtn.addEventListener('touchcancel', e => { e.preventDefault(); setBomb(false); }, { passive: false });
  bombBtn.addEventListener('mousedown',  () => setBomb(true));
  bombBtn.addEventListener('mouseup',    () => setBomb(false));
  bombBtn.addEventListener('mouseleave', () => setBomb(false));
}

/* ─── Net events ─────────────────────────────────────────────────────────────── */
Net.onRoomCreated = ({ roomId: id, playerId }) => {
  myId   = playerId;
  roomId = id;
  lockJoinUI();
};

Net.onRoomJoined = ({ roomId: id, playerId }) => {
  myId   = playerId;
  roomId = id;
  lockJoinUI();
};

Net.onLobbyState = data => {
  applyLobbyState(data);
};

Net.onJoinError = msg => {
  document.getElementById('join-error').textContent = msg;
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
  serverSelf = null;
  predict = null;
  gameSnap = null;
  lastSentInput = '';
  lastFrame = performance.now();
  showScreen('game');
};

Net.onGameState = snap => {
  if (snap.grid) grid = snap.grid;   // only sent when it changed

  // Reconcile local prediction against the server's authoritative TILE. We
  // tolerate a 1-tile difference (that's just the prediction running ahead of
  // the server by a network hop); only a larger gap forces a re-sync.
  const me = snap.players.find(p => p.id === myId);
  if (me) {
    const cx = me.tx + 0.5, cy = me.ty + 0.5;
    serverSelf = { tx: me.tx, ty: me.ty, mv: me.mv };  // authoritative tile
    if (!me.alive || !predict) {
      predict = { x: cx, y: cy, moving: false, facing: null, targetX: cx, targetY: cy };
    } else if (me.mv === 1) {
      // Server is mid-step. A 1-tile lead is just prediction running ahead;
      // only a larger gap is a real desync worth a hard correction here.
      // (Exact alignment when both sides come to rest is done in stepPrediction.)
      const pTx = predict.moving ? Math.floor(predict.targetX) : Math.floor(predict.x);
      const pTy = predict.moving ? Math.floor(predict.targetY) : Math.floor(predict.y);
      if (Math.abs(pTx - me.tx) + Math.abs(pTy - me.ty) > 1) {
        predict.x = cx; predict.y = cy;
        predict.moving = false; predict.facing = null;
        predict.targetX = cx; predict.targetY = cy;
      }
    }
  }

  // Prune local timers for bombs/explosions that no longer exist
  const bombIds = new Set(snap.bombs.map(b => b.id));
  for (const id in bombSeen) if (!bombIds.has(id)) delete bombSeen[id];
  const expIds = new Set(snap.explosions.map(e => e.id));
  for (const id in expSeen) if (!expIds.has(id)) delete expSeen[id];

  gameSnap = snap;
  if (snap.state === 'ended') {
    setTimeout(() => showEndScreen(snap.winner), 700);
  }
};

/* ─── End screen ─────────────────────────────────────────────────────────────── */
function showEndScreen(winner) {
  const el = document.getElementById('winner-text');
  if (winner) {
    el.innerHTML = `<span style="color:${winner.color}">${winner.name}</span><br>wins!`;
  } else {
    el.textContent = "It's a draw!";
  }
  document.getElementById('btn-play-again').style.display = isHost ? '' : 'none';
  showScreen('end');
}

/* ─── UI helpers ─────────────────────────────────────────────────────────────── */
function lockJoinUI() {
  // Disable create/join once in a room
  document.getElementById('btn-create').disabled = true;
  document.getElementById('btn-join').disabled   = true;
  document.getElementById('join-input').disabled  = true;
  document.getElementById('name-input').disabled  = true;
}

/* ─── Init ───────────────────────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  setupTouchControls();

  // Auto-fill room code from URL param
  const urlRoom = new URLSearchParams(window.location.search).get('room');
  if (urlRoom) {
    document.getElementById('join-input').value = urlRoom.toUpperCase();
  }

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
    Net.joinRoom(code, name);
  }

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

  // Play again (host)
  document.getElementById('btn-play-again').addEventListener('click', () => {
    Net.playAgain();
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
});
