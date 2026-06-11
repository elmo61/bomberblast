/* ─── GameCore ──────────────────────────────────────────────────────────────
 * Framework-agnostic Bomberman simulation, extracted from the old server.js.
 * Runs in the room HOST's browser (the authority). No sockets, no transport —
 * the host feeds inputs in and reads snapshots out; net.js handles the wire.
 *
 * Loadable in the browser (window.GameCore) and Node (module.exports) so the
 * exact same logic can be unit-tested headless if desired.
 * ──────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  const GameCore = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = GameCore;
  else root.GameCore = GameCore;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ─── Constants (must stay in sync with the client's BOMB_FUSE_MS etc.) ──────
  const MAP_W = 15;
  const MAP_H = 13;
  const PLAYER_SPEED = 6;         // tiles per second
  const BOMB_TIMER_MS = 3000;
  const EXPLOSION_TTL_MS = 500;

  const TILE_EMPTY = 0;
  const TILE_WALL  = 1;
  const TILE_BLOCK = 2;

  const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f'];
  const SPAWN_POS = [
    { x: 1.5, y: 1.5 },
    { x: 13.5, y: 1.5 },
    { x: 1.5, y: 11.5 },
    { x: 13.5, y: 11.5 },
  ];

  const STEP_DIRS = [
    { dx: 0, dy: -1, key: 'up' },
    { dx: 0, dy: 1,  key: 'down' },
    { dx: -1, dy: 0, key: 'left' },
    { dx: 1, dy: 0,  key: 'right' },
  ];

  // ─── Helpers ────────────────────────────────────────────────────────────────
  function enc(tx, ty) { return ty * MAP_W + tx; }
  function now() { return Date.now(); }

  function generateGrid() {
    const grid = new Array(MAP_W * MAP_H).fill(TILE_EMPTY);
    const safe = new Set([
      enc(1,1), enc(2,1), enc(1,2),
      enc(13,1), enc(12,1), enc(13,2),
      enc(1,11), enc(2,11), enc(1,10),
      enc(13,11), enc(12,11), enc(13,10),
    ]);
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        const idx = enc(tx, ty);
        if (tx === 0 || tx === MAP_W - 1 || ty === 0 || ty === MAP_H - 1) {
          grid[idx] = TILE_WALL;
        } else if (tx % 2 === 0 && ty % 2 === 0) {
          grid[idx] = TILE_WALL;
        } else if (!safe.has(idx) && Math.random() < 0.65) {
          grid[idx] = TILE_BLOCK;
        }
      }
    }
    return grid;
  }

  function calcExplosionTiles(tx, ty, range, grid) {
    const tiles = [[tx, ty]];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
      for (let i = 1; i <= range; i++) {
        const cx = tx + dx * i;
        const cy = ty + dy * i;
        if (cx < 0 || cy < 0 || cx >= MAP_W || cy >= MAP_H) break;
        const tile = grid[enc(cx, cy)];
        if (tile === TILE_WALL) break;
        tiles.push([cx, cy]);
        if (tile === TILE_BLOCK) break;
      }
    }
    return tiles;
  }

  // ─── GameCore class ───────────────────────────────────────────────────────
  class GameCore {
    constructor() {
      this.state = 'lobby';            // 'lobby' | 'playing' | 'ended'
      this.players = new Map();        // id → player
      this.grid = null;
      this.bombs = new Map();          // bombId → bomb
      this.explosions = [];            // { id, tiles, ttl }
      this.powerups = [];              // { id, tx, ty, type }
      this.winner = null;
      this.lastTick = null;
      this.lastSnapStr = null;         // idle-skip signature
      this._idc = 0;                   // monotonic id counter (replaces randomUUID)
    }

    _id(prefix) { return prefix + (++this._idc); }

    // ─── Lobby management ─────────────────────────────────────────────────────
    addPlayer(id, name) {
      if (this.players.has(id)) return this.players.get(id);
      const idx = this.players.size;
      const spawn = SPAWN_POS[idx] || SPAWN_POS[0];
      const player = {
        id,
        name: String(name).substring(0, 14),
        color: PLAYER_COLORS[idx],
        spawnIdx: idx,
        x: spawn.x,
        y: spawn.y,
        alive: true,
        maxBombs: 1,
        activeBombs: 0,
        range: 2,
        speed: PLAYER_SPEED,
        input: { up: false, down: false, left: false, right: false, bomb: false },
        bombPressed: false,
        moving: false,
        facing: null,
        targetX: spawn.x,
        targetY: spawn.y,
      };
      this.players.set(id, player);
      return player;
    }

    removePlayer(id) { this.players.delete(id); }

    renamePlayer(id, name) {
      const p = this.players.get(id);
      if (p && name) p.name = String(name).substring(0, 14);
    }

    setInput(id, input) {
      const player = this.players.get(id);
      if (!player || !player.alive) return;
      player.input = {
        up:    !!input.up,
        down:  !!input.down,
        left:  !!input.left,
        right: !!input.right,
        bomb:  !!input.bomb,
      };
    }

    lobbyMeta() {
      return [...this.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color }));
    }

    // ─── Game start (was initGame) ───────────────────────────────────────────
    start() {
      this.state = 'playing';
      this.grid = generateGrid();
      this.bombs.clear();
      this.explosions = [];
      this.powerups = [];
      this.winner = null;
      this.lastSnapStr = null;

      let idx = 0;
      for (const player of this.players.values()) {
        const spawn = SPAWN_POS[idx] || SPAWN_POS[0];
        player.spawnIdx = idx;
        player.color = PLAYER_COLORS[idx];
        player.x = spawn.x;
        player.y = spawn.y;
        player.alive = true;
        player.maxBombs = 1;
        player.activeBombs = 0;
        player.range = 2;
        player.speed = PLAYER_SPEED;
        player.input = { up: false, down: false, left: false, right: false, bomb: false };
        player.bombPressed = false;
        player.moving = false;
        player.facing = null;
        player.targetX = spawn.x;
        player.targetY = spawn.y;
        idx++;
      }
      this.lastTick = now();
    }

    returnToLobby() {
      this.state = 'lobby';
      this.lastSnapStr = null;
    }

    // ─── Movement helpers ─────────────────────────────────────────────────────
    isSolidTile(player, tx, ty) {
      if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return true;
      const v = this.grid[enc(tx, ty)];
      if (v === TILE_WALL || v === TILE_BLOCK) return true;
      for (const b of this.bombs.values()) {
        if (b.tx === tx && b.ty === ty) {
          return !(Math.floor(player.x) === tx && Math.floor(player.y) === ty);
        }
      }
      return false;
    }

    chooseStepDir(player, input) {
      const tx = Math.floor(player.x), ty = Math.floor(player.y);
      let ordered = STEP_DIRS;
      if (player.facing) {
        const f = STEP_DIRS.find(d => d.key === player.facing.key);
        ordered = [f, ...STEP_DIRS.filter(d => d.key !== f.key)];
      }
      for (const d of ordered) {
        if (!input[d.key]) continue;
        if (!this.isSolidTile(player, tx + d.dx, ty + d.dy)) return d;
      }
      return null;
    }

    // ─── Explosion resolution (queue-based chaining) ──────────────────────────
    detonateQueue(startBombIds) {
      const queue = [...startBombIds];
      const processed = new Set();
      const destroyed = [];

      while (queue.length > 0) {
        const bombId = queue.shift();
        if (processed.has(bombId)) continue;
        processed.add(bombId);

        const bomb = this.bombs.get(bombId);
        if (!bomb) continue;
        this.bombs.delete(bombId);

        const owner = this.players.get(bomb.playerId);
        if (owner) owner.activeBombs = Math.max(0, owner.activeBombs - 1);

        const tiles = calcExplosionTiles(bomb.tx, bomb.ty, bomb.range, this.grid);
        this.explosions.push({ id: this._id('e'), tiles, ttl: EXPLOSION_TTL_MS });

        for (const [cx, cy] of tiles) {
          const idx = enc(cx, cy);
          if (this.grid[idx] === TILE_BLOCK) {
            this.grid[idx] = TILE_EMPTY;
            destroyed.push([cx, cy]);
            if (Math.random() < 0.35) {
              const types = ['bomb', 'range', 'speed'];
              this.powerups.push({
                id: this._id('p'),
                tx: cx, ty: cy,
                type: types[Math.floor(Math.random() * 3)],
              });
            }
          }
          for (const p of this.players.values()) {
            if (!p.alive) continue;
            if (Math.floor(p.x) === cx && Math.floor(p.y) === cy) p.alive = false;
          }
          for (const [bid, b] of this.bombs) {
            if (b.tx === cx && b.ty === cy && !processed.has(bid)) queue.push(bid);
          }
        }
      }
      return destroyed;
    }

    // ─── Tick (was tickRoom). Returns { gridChanged }. ────────────────────────
    tick() {
      const t = now();
      const dt = Math.min((t - this.lastTick) / 1000, 0.1);
      this.lastTick = t;

      for (const player of this.players.values()) {
        if (!player.alive) continue;
        const input = player.input;

        let remaining = player.speed * dt;
        let guard = 0;
        while (remaining > 0 && guard++ < 8) {
          if (!player.moving) {
            const dir = this.chooseStepDir(player, input);
            if (!dir) break;
            player.facing = dir;
            player.moving = true;
            player.targetX = Math.floor(player.x) + dir.dx + 0.5;
            player.targetY = Math.floor(player.y) + dir.dy + 0.5;
          }
          const dxT = player.targetX - player.x;
          const dyT = player.targetY - player.y;
          const dist = Math.abs(dxT) + Math.abs(dyT);
          if (dist <= remaining + 1e-6) {
            player.x = player.targetX;
            player.y = player.targetY;
            remaining -= dist;
            player.moving = false;
          } else {
            player.x += Math.sign(dxT) * Math.min(remaining, Math.abs(dxT));
            player.y += Math.sign(dyT) * Math.min(remaining, Math.abs(dyT));
            remaining = 0;
          }
        }

        if (input.bomb && !player.bombPressed) {
          if (player.activeBombs < player.maxBombs) {
            const btx = Math.floor(player.x);
            const bty = Math.floor(player.y);
            const occupied = [...this.bombs.values()].some(b => b.tx === btx && b.ty === bty);
            if (!occupied) {
              const bombId = this._id('b');
              this.bombs.set(bombId, {
                id: bombId, tx: btx, ty: bty,
                timer: BOMB_TIMER_MS, range: player.range, playerId: player.id,
              });
              player.activeBombs++;
            }
          }
          player.bombPressed = true;
        }
        if (!input.bomb) player.bombPressed = false;
      }

      let gridChanged = false;
      const toDetonate = [];
      for (const [id, bomb] of this.bombs) {
        bomb.timer -= dt * 1000;
        if (bomb.timer <= 0) toDetonate.push(id);
      }
      if (toDetonate.length > 0) {
        const destroyed = this.detonateQueue(toDetonate);
        if (destroyed.length > 0) gridChanged = true;
      }

      this.explosions = this.explosions.filter(e => {
        e.ttl -= dt * 1000;
        return e.ttl > 0;
      });

      for (let i = this.powerups.length - 1; i >= 0; i--) {
        const pu = this.powerups[i];
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          if (Math.floor(p.x) === pu.tx && Math.floor(p.y) === pu.ty) {
            if (pu.type === 'bomb')  p.maxBombs = Math.min(p.maxBombs + 1, 5);
            if (pu.type === 'range') p.range    = Math.min(p.range + 1, 7);
            if (pu.type === 'speed') p.speed    = Math.min(p.speed + 0.5, 8);
            this.powerups.splice(i, 1);
            break;
          }
        }
      }

      const alive = [...this.players.values()].filter(p => p.alive);
      if (alive.length <= 1 && this.players.size > 1) {
        this.state = 'ended';
        this.winner = alive[0]
          ? { id: alive[0].id, name: alive[0].name, color: alive[0].color }
          : null;
      }

      return { gridChanged };
    }

    // ─── Snapshot (was broadcastSnapshot, minus the emit) ─────────────────────
    // Returns the snapshot object, or null when nothing changed and the grid
    // isn't being force-included (idle-skip — caller should not send).
    snapshot(includeGrid = false) {
      const snap = {
        state: this.state,
        players: [...this.players.values()].map(p => ({
          id: p.id,
          tx: Math.floor(p.moving ? p.targetX : p.x),
          ty: Math.floor(p.moving ? p.targetY : p.y),
          mv: p.moving ? 1 : 0,
          alive: p.alive,
          maxBombs: p.maxBombs, range: p.range, speed: p.speed,
        })),
        bombs: [...this.bombs.values()].map(b => ({
          id: b.id, tx: b.tx, ty: b.ty, range: b.range,
        })),
        explosions: this.explosions.map(e => ({ id: e.id, tiles: e.tiles })),
        powerups: this.powerups.map(p => ({ id: p.id, tx: p.tx, ty: p.ty, type: p.type })),
        winner: this.winner,
      };

      const str = JSON.stringify(snap);
      if (!includeGrid && str === this.lastSnapStr) return null;   // idle skip
      this.lastSnapStr = str;

      if (includeGrid) snap.grid = this.grid;
      return snap;
    }
  }

  GameCore.MAP_W = MAP_W;
  GameCore.MAP_H = MAP_H;
  return GameCore;
});
