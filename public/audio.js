/* ─── GameAudio ──────────────────────────────────────────────────────────────
 * Self-contained 8-bit audio via the Web Audio API — no asset files. Provides a
 * looping chiptune background track plus short SFX, all synthesised from
 * oscillators/noise.
 *
 * Bonus: while a match is running this keeps an (inaudible) oscillator playing,
 * which marks the tab as "playing audio" so the browser doesn't throttle the
 * host's background game loop — the original reason we wanted audio at all.
 * ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const MUTE_KEY = 'bomberblast_muted';
  let ctx, master, musicGain, sfxGain;
  let keepOsc = null, musicTimer = null, musicOn = false;
  let muted = localStorage.getItem(MUTE_KEY) === '1';
  let disabled = false;   // hard off-switch (used by test mode) — no context, no sound

  const MUSIC_VOL = 0.16, SFX_VOL = 0.5;

  function ensure() {
    if (disabled || ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();    master.gain.value = 1;                 master.connect(ctx.destination);
    musicGain = ctx.createGain(); musicGain.gain.value = muted ? 0 : MUSIC_VOL; musicGain.connect(master);
    sfxGain = ctx.createGain();   sfxGain.gain.value = muted ? 0 : SFX_VOL;     sfxGain.connect(master);
  }

  function unlock() {
    if (disabled) return;
    ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  // Hard off-switch — stops any sound and makes every call a no-op. Used by the
  // app's test mode so automated previews stay silent.
  function disable() {
    disabled = true;
    stopMusic();
    if (ctx) { try { ctx.close(); } catch (e) {} ctx = null; }
  }

  // ─── Tone helpers ─────────────────────────────────────────────────────────
  function tone(dest, freq, t0, dur, type, vol) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(dest);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function slide(dest, f0, f1, t0, dur, type, vol) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(dest);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function noise(dest, t0, dur, vol, cutoff) {
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = ctx.createBufferSource(); s.buffer = buf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cutoff || 900;
    const g = ctx.createGain(); g.gain.value = vol;
    s.connect(lp); lp.connect(g); g.connect(dest);
    s.start(t0); s.stop(t0 + dur);
  }

  // ─── SFX ──────────────────────────────────────────────────────────────────
  function sfx(name) {
    ensure(); if (!ctx) return; unlock();
    const t = ctx.currentTime, d = sfxGain;
    switch (name) {
      case 'place':  slide(d, 720, 300, t, 0.12, 'square', 0.5); break;
      case 'boom':   noise(d, t, 0.45, 0.9, 1400); slide(d, 190, 45, t, 0.4, 'triangle', 0.7); break;
      case 'power':  [523, 659, 784, 1047].forEach((f, i) => tone(d, f, t + i * 0.05, 0.12, 'square', 0.4)); break;
      case 'death':  [440, 330, 233, 165].forEach((f, i) => tone(d, f, t + i * 0.09, 0.15, 'square', 0.45)); break;
      case 'win':    [523, 659, 784, 1047, 880, 1047, 1319].forEach((f, i) => tone(d, f, t + i * 0.13, 0.2, 'square', 0.45)); break;
      case 'count':  tone(d, 700, t, 0.16, 'square', 0.5); break;
      case 'go':     tone(d, 1175, t, 0.32, 'square', 0.55); break;
    }
  }

  // ─── Background music (looping chiptune) ──────────────────────────────────
  const STEP = 0.18;   // seconds per step
  // 0 = rest. A cheerful 16-step loop: lead (square) over a simple bass (triangle).
  const LEAD = [659, 784, 523, 659, 587, 523, 392, 440, 523, 659, 784, 659, 587, 523, 587, 0];
  const BASS = [131, 0, 131, 0, 196, 0, 196, 0, 220, 0, 220, 0, 175, 0, 196, 0];

  function scheduleLoop() {
    if (!ctx || !musicOn) return;
    const start = ctx.currentTime + 0.06;
    for (let i = 0; i < LEAD.length; i++) {
      const t = start + i * STEP;
      if (LEAD[i]) tone(musicGain, LEAD[i], t, STEP * 0.9, 'square', 0.5);
      if (BASS[i]) tone(musicGain, BASS[i], t, STEP * 0.95, 'triangle', 0.6);
    }
    // Reschedule the whole bar slightly before it ends. Scheduling an entire bar
    // at once means we only need a timer roughly every few seconds, which keeps
    // the music seamless even if background timer throttling kicks in.
    const barMs = LEAD.length * STEP * 1000;
    musicTimer = setTimeout(scheduleLoop, barMs - 120);
  }

  function startMusic() {
    ensure(); if (!ctx) return; unlock();
    if (musicOn) return;
    musicOn = true;
    // Inaudible keep-alive tone (independent of mute) so the tab counts as
    // "playing audio" and the host's loop isn't throttled in the background.
    keepOsc = ctx.createOscillator();
    const kg = ctx.createGain(); kg.gain.value = 0.0015;
    keepOsc.frequency.value = 19000;
    keepOsc.connect(kg); kg.connect(master);
    keepOsc.start();
    scheduleLoop();
  }

  function stopMusic() {
    musicOn = false;
    if (musicTimer) { clearTimeout(musicTimer); musicTimer = null; }
    if (keepOsc) { try { keepOsc.stop(); } catch (e) {} keepOsc = null; }
  }

  function setMuted(m) {
    muted = !!m;
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    if (ctx) {
      musicGain.gain.value = muted ? 0 : MUSIC_VOL;
      sfxGain.gain.value   = muted ? 0 : SFX_VOL;
    }
  }
  function isMuted() { return muted; }

  window.GameAudio = { unlock, sfx, startMusic, stopMusic, setMuted, isMuted, disable };
})();
