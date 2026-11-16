/* Audience display: renders only public state sent by the host console. */
(function (F) {
  'use strict';
  const K = F.KEYS;
  const $ = (id) => document.getElementById(id);
  const isPreview = /[?&]preview=1/.test(location.search);
  document.body.classList.toggle('preview', isPreview);

  let state = null, lastRev = -Infinity, boardKey = null, fmRows = 0;
  const seenFx = new Set();

  /* ---------------------------------------------------------- scaling: fixed 1920×1080 stage */
  const stage = $('stage');
  function fit() {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  }
  window.addEventListener('resize', fit);
  fit();

  /* ---------------------------------------------------------- messaging */
  const channel = F.createChannel(onMsg);
  function hostTargets() {
    const t = [];
    try { if (window.opener && !window.opener.closed) t.push(window.opener); } catch (e) { /* ignore */ }
    if (window.parent && window.parent !== window) t.push(window.parent);
    return t;
  }
  function send(msg) { msg.preview = isPreview; channel.send(msg, hostTargets()); }
  function onMsg(msg) {
    if (msg.type === 'state') apply(msg.state);
    else if (msg.type === 'fx') fx(msg.fx);
  }
  window.addEventListener('storage', (e) => {
    try {
      if (e.key === K.pub && e.newValue) apply(JSON.parse(e.newValue));
      else if (e.key === K.fx && e.newValue) fx(JSON.parse(e.newValue));
    } catch (err) { /* ignore */ }
  });

  function apply(s) {
    if (!s || typeof s.rev !== 'number' || s.rev <= lastRev) return;
    lastRev = s.rev;
    const prev = state;
    state = s;
    $('waiting').hidden = true;
    try { render(prev); } catch (e) { console.error(e); }
  }

  /* ---------------------------------------------------------- helpers */
  const teamName = (t) => (state && (t === 0 || t === 1) ? state.teams[t].name : '');
  function tween(el, to, delay) {
    to = Number(to) || 0;
    const from = Number(el.dataset.v ?? to);
    el.dataset.v = to;
    clearTimeout(el._d); cancelAnimationFrame(el._raf);
    if (from === to || isPreview) { el.textContent = to; return; }
    const run = () => {
      const t0 = performance.now(), dur = 700;
      const step = (now) => {
        const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(from + (to - from) * e);
        if (p < 1) el._raf = requestAnimationFrame(step);
      };
      el._raf = requestAnimationFrame(step);
      el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    };
    if (delay) el._d = setTimeout(run, delay); else run();
  }
  function fitText(el, text, sizes) {
    const len = String(text || '').length;
    let size = sizes[sizes.length - 1][1];
    for (const [max, px] of sizes) if (len <= max) { size = px; break; }
    el.style.fontSize = size + 'px';
  }

  /* ---------------------------------------------------------- render */
  function render(prev) {
    const s = state, v = s.view || {};
    F.Sound.setVolume(v.volume ?? 0.8);
    let scene = v.scene || 'game';
    if (scene === 'game') scene = s.mode === 'fastmoney' ? 'fm' : 'game';
    document.querySelectorAll('.scene').forEach((el) => el.classList.toggle('active', el.id === 'scene-' + scene));
    stage.dataset.scene = scene;

    renderTeams();
    if (s.round) renderRound(prev);
    if (s.fm) renderFM(prev);
    $('titleText').textContent = s.title || 'Family Feud';
    fitText($('titleText'), s.title, [[10, 150], [14, 120], [20, 92], [28, 70], [999, 54]]);
    $('versus').innerHTML = `<span>${F.esc(s.teams[0].name)}</span><i>vs</i><span>${F.esc(s.teams[1].name)}</span>`;
    renderWinner(prev, scene);
  }

  function renderTeams() {
    const s = state, r = s.round;
    [0, 1].forEach((t) => {
      const box = $('team' + t);
      box.querySelector('.tname').textContent = s.teams[t].name;
      fitText(box.querySelector('.tname'), s.teams[t].name, [[12, 40], [18, 32], [999, 26]]);
      tween(box.querySelector('.tscore'), s.teams[t].score);
      const playing = r && r.phase === 'play' && r.control === t;
      const stealing = r && r.phase === 'steal' && r.stealTeam === t;
      box.classList.toggle('playing', !!playing);
      box.classList.toggle('stealing', !!stealing);
      box.querySelector('.ttag').textContent = stealing ? 'STEAL!' : playing ? 'PLAYING' : '';
      const bs = $('bs' + t);
      bs.querySelector('.tname').textContent = s.teams[t].name;
      tween(bs.querySelector('.tscore'), s.teams[t].score);
      bs.classList.toggle('leader', s.teams[t].score > s.teams[1 - t].score);
    });
  }

  function renderRound() {
    const s = state, r = s.round;
    $('roundLabel').textContent = r.suddenDeath ? 'SUDDEN DEATH' : `ROUND ${s.roundNo}`;
    const ml = F.multLabel(r.multiplier);
    $('multLabel').textContent = ml ? `${ml} POINTS` : '';
    $('multLabel').hidden = !ml;
    tween($('bankNum'), r.bank);

    const showQ = s.view.showQuestion && r.question;
    $('questionBar').classList.toggle('hidden', !showQ);
    $('qText').textContent = r.question || '';
    fitText($('qText'), r.question, [[40, 54], [70, 46], [100, 40], [140, 34], [999, 28]]);

    // board
    const slots = F.slotsFor(r.n);
    const key = `${r.key}:${r.n}`;
    const board = $('board');
    const fresh = key !== boardKey;
    if (fresh) {
      boardKey = key;
      board.style.setProperty('--rows', slots / 2);
      let html = '';
      for (let i = 0; i < slots; i++) {
        html += i < r.n
          ? `<div class="slot" data-i="${i}"><div class="panel"><div class="face front"><span class="oval">${i + 1}</span></div><div class="face back"><span class="atext"></span><span class="apts"></span></div></div></div>`
          : '<div class="slot empty"></div>';
      }
      board.innerHTML = html;
      board.classList.add('no-anim');
    }
    board.querySelectorAll('.slot[data-i]').forEach((slot) => {
      const i = +slot.dataset.i, a = r.answers[i];
      const isOn = slot.classList.contains('revealed');
      if (a) {
        slot.querySelector('.atext').textContent = a.text;
        fitText(slot.querySelector('.atext'), a.text, [[12, 52], [16, 46], [21, 40], [27, 34], [999, 28]]);
        slot.querySelector('.apts').textContent = a.points;
        if (!isOn) slot.classList.add('revealed');
      } else if (isOn) slot.classList.remove('revealed');
    });
    if (fresh) requestAnimationFrame(() => requestAnimationFrame(() => board.classList.remove('no-anim')));

    // strikes
    const max = s.maxStrikes || 3;
    const show = r.phase === 'play' || r.phase === 'steal' || r.strikes > 0;
    let sh = '';
    if (show) for (let k = 0; k < max; k++) sh += `<div class="sx ${k < r.strikes ? 'on' : ''}">${xSvg()}</div>`;
    $('strikes').innerHTML = sh;
  }

  function renderFM(prev) {
    const fm = state.fm;
    const board = $('fmBoard');
    if (fmRows !== fm.rows) {
      fmRows = fm.rows;
      let html = '';
      for (let i = 0; i < fm.rows; i++) {
        html += `<div class="fm-row">
          <div class="fm-cell txt" id="fmt0_${i}"></div><div class="fm-cell pts" id="fmp0_${i}"></div>
          <div class="fm-gap"></div>
          <div class="fm-cell txt" id="fmt1_${i}"></div><div class="fm-cell pts" id="fmp1_${i}"></div></div>`;
      }
      board.innerHTML = html;
    }
    let delayTotal = 0;
    fm.entries.forEach((col, p) => col.forEach((e, i) => {
      const tEl = $(`fmt${p}_${i}`), pEl = $(`fmp${p}_${i}`);
      if (!tEl) return;
      const hadText = tEl.dataset.v != null;
      if (e.text != null) {
        if (tEl.dataset.v !== e.text) { tEl.dataset.v = e.text; tEl.innerHTML = `<span>${F.esc(e.text)}</span>`; tEl.classList.remove('show'); void tEl.offsetWidth; tEl.classList.add('show'); }
        fitText(tEl.firstChild, e.text, [[12, 44], [18, 36], [999, 28]]);
      } else if (hadText) { delete tEl.dataset.v; tEl.innerHTML = ''; tEl.classList.remove('show'); }
      if (e.points != null) {
        if (pEl.dataset.v !== String(e.points)) {
          pEl.dataset.v = String(e.points);
          const wait = !hadText && e.text != null && !isPreview ? 900 : 0;
          delayTotal = Math.max(delayTotal, wait);
          clearTimeout(pEl._t);
          pEl._t = setTimeout(() => { pEl.textContent = e.points; pEl.classList.remove('show'); void pEl.offsetWidth; pEl.classList.add('show'); pEl.classList.toggle('zero', e.points === 0); }, wait);
        }
      } else if (pEl.dataset.v != null) { delete pEl.dataset.v; clearTimeout(pEl._t); pEl.textContent = ''; pEl.classList.remove('show', 'zero'); }
    }));
    $('fmGoal').textContent = fm.target;
    tween($('fmTotal'), fm.total, delayTotal);
    $('scene-fm').classList.toggle('won', !!fm.won);
  }

  function renderWinner(prev, scene) {
    const s = state;
    let name, score;
    if (s.mode === 'fastmoney' && s.fm) {
      name = s.fm.won ? 'FAST MONEY WINNER!' : 'FAST MONEY';
      score = `${s.fm.total} POINTS`;
    } else {
      const w = s.winner != null ? s.winner : (s.teams[0].score === s.teams[1].score ? null : s.teams[0].score > s.teams[1].score ? 0 : 1);
      name = w == null ? "IT'S A TIE!" : s.teams[w].name;
      score = w == null ? `${s.teams[0].score} – ${s.teams[1].score}` : `${s.teams[w].score} POINTS`;
    }
    $('winName').textContent = name;
    fitText($('winName'), name, [[10, 170], [16, 130], [24, 96], [999, 72]]);
    $('winScore').textContent = score;
    const prevScene = prev && prev.view ? prev.view.scene : null;
    if (scene === 'winner' && prevScene !== 'winner') confetti();
  }

  /* ---------------------------------------------------------- timer */
  function timerLoop() {
    const t = state && state.view && state.view.timer;
    const el = $('timer');
    if (t && t.visible) {
      const rem = t.running ? Math.max(0, t.endsAt - Date.now()) : t.remaining;
      const sec = Math.ceil(rem / 1000);
      $('timerNum').textContent = sec;
      const frac = t.duration ? Math.max(0, Math.min(1, rem / (t.duration * 1000))) : 0;
      $('timerRing').style.strokeDashoffset = String(283 * (1 - frac));
      el.classList.add('show');
      el.classList.toggle('low', rem <= 5000);
      el.classList.toggle('done', rem <= 0);
    } else el.classList.remove('show');
    requestAnimationFrame(timerLoop);
  }
  requestAnimationFrame(timerLoop);

  /* ---------------------------------------------------------- effects */
  function xSvg() {
    return '<svg viewBox="0 0 100 100"><path d="M22 22 L78 78 M78 22 L22 78" stroke="#fff" stroke-width="26" stroke-linecap="round"/><path d="M22 22 L78 78 M78 22 L22 78" stroke="#e3141b" stroke-width="16" stroke-linecap="round"/></svg>';
  }
  let xTimer = null;
  function showX(n) {
    const o = $('xOverlay');
    o.innerHTML = Array.from({ length: Math.max(1, Math.min(6, n)) }, () => `<div class="bigx">${xSvg()}</div>`).join('');
    o.classList.remove('show'); void o.offsetWidth; o.classList.add('show');
    clearTimeout(xTimer);
    xTimer = setTimeout(() => o.classList.remove('show'), 1400);
  }
  let bTimer = null;
  function banner(text, kind, ms) {
    const b = $('banner');
    $('bannerInner').textContent = text;
    b.className = 'show ' + (kind || '');
    clearTimeout(bTimer);
    bTimer = setTimeout(() => { b.className = ''; }, ms || 2300);
  }
  function confetti() {
    if (isPreview) return;
    const c = $('confetti');
    const colors = ['#ffd34d', '#ff4d6d', '#3ec5ff', '#7cff6b', '#ffffff', '#b77dff'];
    let html = '';
    for (let i = 0; i < 160; i++) {
      const left = Math.random() * 100, delay = Math.random() * 1.2, dur = 2.6 + Math.random() * 2.2, size = 10 + Math.random() * 14, rot = Math.random() * 360;
      html += `<i style="left:${left}%;width:${size}px;height:${size * 0.45}px;background:${colors[i % colors.length]};animation-delay:${delay}s;animation-duration:${dur}s;transform:rotate(${rot}deg)"></i>`;
    }
    c.innerHTML = html;
    clearTimeout(c._t);
    c._t = setTimeout(() => { c.innerHTML = ''; }, 6500);
  }

  function fx(f) {
    if (!f || !f.id || seenFx.has(f.id)) return;
    seenFx.add(f.id);
    if (Date.now() - (f.t || 0) > 5000) return;
    if (!isPreview && (f.sound === 'display' || f.sound === 'both')) F.Sound.play(f.name, f.data);
    const d = f.data || {};
    switch (f.name) {
      case 'strike': showX(d.count || 1); break;
      case 'steal': setTimeout(() => banner(`${teamName(d.team)} — STEAL!`, 'red', 2600), 1300); break;
      case 'control': banner(`${teamName(d.team)} PLAYS!`, '', 1800); break;
      case 'award': if (d.amount > 0) setTimeout(() => banner(`${teamName(d.team)}  +${d.amount}`, 'gold', 2600), d.how === 'steal' || d.how === 'cleared' ? 900 : 300); break;
      case 'win': confetti(); if (d.fm) banner('GOAL REACHED!', 'gold', 3000); break;
      case 'newRound': if (state && state.round) { const ml = F.multLabel(state.round.multiplier); banner(state.round.suddenDeath ? 'SUDDEN DEATH' : `ROUND ${state.roundNo}${ml ? ' · ' + ml : ''}`, '', 1800); } break;
      case 'timeup': banner("TIME'S UP!", 'red', 1800); break;
      case 'duplicate': banner('DUPLICATE — TRY AGAIN', 'red', 1600); break;
      default: break;
    }
  }

  /* ---------------------------------------------------------- input */
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  if (!isPreview) {
    const overlay = $('startOverlay');
    overlay.hidden = false;
    const unlock = () => { F.Sound.unlock(); overlay.hidden = true; };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('dblclick', toggleFullscreen);
    document.addEventListener('keydown', (e) => {
      unlock();
      if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey) { toggleFullscreen(); return; }
      if (e.key === 'F11' || e.key === 'Escape') return;
      if (['Tab', 'Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      send({ type: 'key', ev: { key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey } });
    });
    setInterval(() => send({ type: 'ping' }), 2000);
  }

  /* ---------------------------------------------------------- boot */
  apply(F.Store.get(K.pub, null));
  send({ type: 'hello' });
  setTimeout(() => { if (!state) $('waiting').hidden = false; }, 1500);
  setInterval(() => { if (!state) send({ type: 'hello' }); }, 3000);
})(window.Feud);
