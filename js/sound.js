/* Synthesised sound effects (Web Audio) — no audio files, works fully offline. */
(function (F) {
  'use strict';
  let ctx = null, master = null, volume = 0.8;

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function tone(freq, start, dur, opts) {
    opts = opts || {};
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + start;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.slide) osc.frequency.exponentialRampToValueAtTime(opts.slide, t0 + dur);
    const peak = opts.gain ?? 0.3;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (opts.attack ?? 0.01));
    if (opts.sustain) g.gain.setValueAtTime(peak, t0 + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = osc;
    if (opts.lowpass) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = opts.lowpass; osc.connect(f); node = f; }
    node.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  }

  function bell(freq, start, gain) {
    tone(freq, start, 1.1, { gain: gain ?? 0.28 });
    tone(freq * 2.01, start, 0.7, { gain: (gain ?? 0.28) * 0.35 });
    tone(freq * 3.02, start, 0.35, { gain: (gain ?? 0.28) * 0.15 });
  }

  function buzz(dur, base) {
    base = base || 110;
    tone(base, 0, dur, { type: 'sawtooth', gain: 0.32, sustain: true, lowpass: 1400 });
    tone(base * 1.06, 0, dur, { type: 'square', gain: 0.18, sustain: true, lowpass: 1100 });
  }

  const N = { C5: 523.25, E5: 659.25, G5: 783.99, C6: 1046.5, E6: 1318.5, G4: 392, A4: 440, D5: 587.33, F5: 698.46 };

  const sounds = {
    reveal() { bell(N.E6, 0, 0.22); bell(N.C6, 0.09, 0.22); },
    revealAll() { [N.C5, N.E5, N.G5, N.C6].forEach((f, i) => bell(f, i * 0.07, 0.15)); },
    strike() { buzz(0.9, 105); },
    steal() { tone(N.G4, 0, 0.25, { type: 'square', gain: 0.12 }); tone(N.D5, 0.25, 0.25, { type: 'square', gain: 0.12 }); tone(N.G5, 0.5, 0.5, { type: 'square', gain: 0.14 }); },
    control() { bell(N.G5, 0, 0.16); bell(N.C6, 0.12, 0.16); },
    award() { [N.C5, N.E5, N.G5, N.C6].forEach((f, i) => tone(f, i * 0.11, 0.35, { type: 'triangle', gain: 0.25 })); tone(N.E6, 0.44, 0.6, { type: 'triangle', gain: 0.2 }); },
    win() {
      const seq = [N.G4, N.C5, N.E5, N.G5, N.E5, N.G5, N.C6];
      seq.forEach((f, i) => tone(f, i * 0.14, i === seq.length - 1 ? 1.2 : 0.18, { type: 'square', gain: 0.11, lowpass: 3000 }));
      seq.forEach((f, i) => tone(f / 2, i * 0.14, 0.18, { type: 'triangle', gain: 0.15 }));
    },
    tick() { tone(1500, 0, 0.05, { type: 'square', gain: 0.08 }); },
    timeup() { buzz(0.7, 140); },
    duplicate() { tone(380, 0, 0.16, { type: 'square', gain: 0.15 }); tone(380, 0.22, 0.16, { type: 'square', gain: 0.15 }); },
    fmReveal(d) { if (d && d.points > 0) { bell(N.C6, 0.6, 0.22); } else { setTimeout(() => buzz(0.45, 120), 600); } },
    fmRevealAll() { [0, 1, 2, 3, 4].forEach((i) => bell(N.C6, i * 0.35, 0.16)); },
    newRound() { tone(N.C5, 0, 0.15, { type: 'triangle', gain: 0.18 }); tone(N.G5, 0.12, 0.25, { type: 'triangle', gain: 0.18 }); },
    score() {},
  };

  F.Sound = {
    unlock() { ac(); },
    setVolume(v) { volume = Math.max(0, Math.min(1, Number(v))); if (master) master.gain.value = volume; },
    play(name, data) { try { const fn = sounds[name]; if (fn) fn(data); } catch (e) { /* never let audio break the game */ } },
    names: Object.keys(sounds),
  };
})(window.Feud = window.Feud || {});
