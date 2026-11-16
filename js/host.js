/* Host console controller. */
(function (F) {
  'use strict';
  const K = F.KEYS, esc = F.esc, A = F.actions;
  const $ = (s, el) => (el || document).querySelector(s);
  const UNDO_LIMIT = 200, UNDO_PERSIST = 80, LOG_LIMIT = 400;

  /* ================================================================ state */
  let settings = Object.assign({}, F.DEFAULT_SETTINGS, F.Store.get(K.settings, {}));
  let pack = loadPack();
  let game = loadGame();
  let undo = (() => { const u = F.Store.get(K.undo, null); return u && Array.isArray(u.u) && Array.isArray(u.r) ? u : { u: [], r: [] }; })();
  let view = Object.assign({ scene: 'game', showQuestion: true, preview: false }, F.Store.get(K.view, {}));
  view.timer = Object.assign({ duration: 20, endsAt: null, remaining: 20000, running: false, visible: false }, view.timer || {});
  let rev = Date.now();
  let displayWin = null, displayLastSeen = 0;
  let storageFailed = false;
  let modal = null;
  let editor = { tab: 'questions', sel: null, search: '' };
  let importMode = 'replace';

  function loadPack() {
    const stored = F.Store.get(K.pack, null);
    if (stored) { try { return F.normalizePack(stored); } catch (e) { /* fall through */ } }
    const p = F.normalizePack(F.clone(F.SAMPLE_PACK));
    F.Store.set(K.pack, p);
    return p;
  }

  function validGame(g) {
    return g && Array.isArray(g.teams) && g.teams.length === 2 && g.round && Array.isArray(g.round.answers) && Array.isArray(g.order);
  }

  function loadGame() {
    const g = F.Store.get(K.game, null);
    if (validGame(g)) {
      if (!g.fm) g.fm = F.makeFastMoney(pack, settings);
      if (!Array.isArray(g.log)) g.log = [];
      F.syncOrder(g, pack);
      return g;
    }
    return F.newGame(pack, settings, { shuffle: settings.shuffleQuestions });
  }

  /* ================================================================ persistence + sync */
  function persist() {
    let ok = F.Store.set(K.game, game);
    const trimmed = { u: undo.u.slice(-UNDO_PERSIST), r: undo.r.slice(-20) };
    if (!F.Store.set(K.undo, trimmed)) F.Store.set(K.undo, { u: undo.u.slice(-10), r: [] });
    ok = F.Store.set(K.view, view) && ok;
    if (!ok && !storageFailed) { storageFailed = true; $('#storageWarning').hidden = false; }
  }
  function saveSettings() { F.Store.set(K.settings, settings); F.Sound.setVolume(settings.volume); }
  let packTimer = null;
  function savePack(now) {
    clearTimeout(packTimer);
    if (now) F.Store.set(K.pack, pack); else packTimer = setTimeout(() => F.Store.set(K.pack, pack), 300);
  }

  const channel = F.createChannel(onMessage);
  function targets() {
    const t = [];
    if (displayWin && !displayWin.closed) t.push(displayWin);
    const pf = $('#previewFrame');
    if (pf && pf.contentWindow) t.push(pf.contentWindow);
    return t;
  }
  function publicView() {
    return { scene: view.scene, showQuestion: view.showQuestion, timer: view.timer, volume: settings.volume };
  }
  function publish() {
    rev = Math.max(rev + 1, Date.now()); // monotonic across host reloads
    const pub = F.publicState(game, settings, publicView(), rev);
    F.Store.set(K.pub, pub);
    channel.send({ type: 'state', state: pub }, targets());
  }
  function displayConnected() { return Date.now() - displayLastSeen < 6000; }
  function soundTarget() {
    if (!settings.sound) return 'none';
    if (settings.soundOutput === 'auto') return displayConnected() ? 'display' : 'host';
    return settings.soundOutput;
  }
  function emitFx(name, data) {
    const fx = { id: F.uid(), t: Date.now(), name, data: data || {}, sound: soundTarget() };
    if (fx.sound === 'host' || fx.sound === 'both') F.Sound.play(name, data);
    F.Store.set(K.fx, fx);
    channel.send({ type: 'fx', fx }, targets());
  }

  function onMessage(msg, source) {
    if (msg.type === 'hello') {
      if (source && !msg.preview) displayWin = source;
      if (!msg.preview) displayLastSeen = Date.now();
      rev = Math.max(rev + 1, Date.now());
      const pub = F.publicState(game, settings, publicView(), rev);
      channel.send({ type: 'state', state: pub }, source ? [source] : targets());
      renderStatus();
    } else if (msg.type === 'ping') {
      if (!msg.preview) { displayLastSeen = Date.now(); if (source && (!displayWin || displayWin.closed)) displayWin = source; }
      renderStatus();
    } else if (msg.type === 'key') {
      handleKey(Object.assign({ preventDefault() {}, target: document.body, fromDisplay: true }, msg.ev));
    } else if (msg.type === 'hostHello' && msg.id !== hostId) {
      toast('Another host console is open in a different tab. Use only one to avoid conflicts.', 'warn');
    }
  }
  const hostId = F.uid();
  channel.send({ type: 'hostHello', id: hostId });

  /* ================================================================ actions + undo */
  const LABELS = {
    reveal: (i) => `reveal answer ${i + 1}`, hide: (i) => `hide answer ${i + 1}`, revealAll: () => 'reveal all',
    strike: () => 'strike', faceoffWinner: () => 'face-off winner', decide: (c) => (c === 'pass' ? 'pass' : 'play'),
    setControl: () => 'set control', setPhase: (p) => `phase → ${p}`, setStrikes: () => 'set strikes', award: () => 'award bank',
    endNoAward: () => 'end round', setBank: () => 'set bank', setMultiplier: () => 'multiplier', setSuddenDeath: () => 'sudden death',
    restartRound: () => 'restart round', nextRound: () => 'next round', prevRound: () => 'previous round', gotoQuestion: () => 'change question',
    randomQuestion: () => 'random question', refreshRound: () => 'update live board', setRoundNo: () => 'round number',
    adjustScore: () => 'score change', setScore: () => 'set score', renameTeam: () => 'rename team', clearWinner: () => 'clear winner',
    setWinner: () => 'declare winner', setMode: (m) => (m === 'fastmoney' ? 'switch to Fast Money' : 'switch to main game'),
    fmSet: () => 'Fast Money entry', fmReveal: () => 'Fast Money reveal', fmHide: () => 'Fast Money hide', fmRevealAll: () => 'Fast Money reveal all',
    fmHideP1: () => 'hide player 1', fmPlayer: () => 'Fast Money player', fmReset: () => 'reset Fast Money', fmTarget: () => 'Fast Money target',
  };

  function act(name, ...args) {
    const before = JSON.stringify(game);
    const fxq = [], logs = [], toasts = []; let timerReq = null;
    const ctx = { pack, settings, fx: (n, d) => fxq.push([n, d]), log: (m) => logs.push(m), toast: (m) => toasts.push(m), timer: (s) => { timerReq = s; } };
    let res;
    try { res = A[name](game, ctx, ...args); } catch (e) {
      console.error(e); game = JSON.parse(before); toast(`That didn't work: ${e.message}`, 'error'); render(); return false;
    }
    const changed = res !== false && JSON.stringify(game) !== before;
    if (changed) {
      const now = Date.now();
      logs.forEach((m) => game.log.push({ t: now, m }));
      if (game.log.length > LOG_LIMIT) game.log.splice(0, game.log.length - LOG_LIMIT);
      undo.u.push({ label: (LABELS[name] || (() => name))(...args), s: before });
      if (undo.u.length > UNDO_LIMIT) undo.u.shift();
      undo.r = [];
      persist();
      render();
      publish();
    } else if (res === false) {
      game = JSON.parse(before);
    }
    fxq.forEach(([n, d]) => emitFx(n, d));
    toasts.forEach((m) => toast(m));
    if (timerReq) timerStart(timerReq);
    return changed;
  }

  function doUndo() {
    const e = undo.u.pop();
    if (!e) { toast('Nothing to undo'); return; }
    undo.r.push({ label: e.label, s: JSON.stringify(game) });
    game = JSON.parse(e.s);
    persist(); render(); publish();
    toast(`Undid: ${e.label}`);
  }
  function doRedo() {
    const e = undo.r.pop();
    if (!e) { toast('Nothing to redo'); return; }
    undo.u.push({ label: e.label, s: JSON.stringify(game) });
    game = JSON.parse(e.s);
    persist(); render(); publish();
    toast(`Redid: ${e.label}`);
  }

  function startNewGame(opts) {
    archiveGame(game);
    undo.u.push({ label: 'new game', s: JSON.stringify(game) });
    undo.r = [];
    game = F.newGame(pack, settings, opts);
    game.log.push({ t: Date.now(), m: `New game: ${game.teams[0].name} vs ${game.teams[1].name}` });
    view.scene = 'title';
    view.showQuestion = !!settings.showQuestionOnLoad;
    persist(); render(); publish();
    toast('New game started. (Undo restores the previous game.)');
  }

  function archiveGame(g) {
    const played = g.played.length + (g.round && g.round.result ? 0 : 0);
    if (!played && g.teams.every((t) => !t.score)) return;
    const hist = F.Store.get(K.history, []);
    if (hist.some((h) => h.id === g.id)) { hist.splice(hist.findIndex((h) => h.id === g.id), 1); }
    hist.unshift({ id: g.id, started: g.started, ended: Date.now(), teams: g.teams.map((t) => ({ name: t.name, score: t.score })), rounds: g.played.length, fm: F.fmTotal(g.fm || { entries: [] }), packTitle: pack.title });
    F.Store.set(K.history, hist.slice(0, 100));
  }

  /* ================================================================ view (not undoable) */
  function setView(patch) { Object.assign(view, patch); persist(); render(); publish(); }

  function timerStart(sec) {
    sec = Math.max(1, F.toInt(sec));
    view.timer = { duration: sec, remaining: sec * 1000, endsAt: Date.now() + sec * 1000, running: true, visible: true };
    lastTick = null;
    persist(); renderTimer(); publish();
  }
  function timerToggle() {
    const t = view.timer;
    if (t.running) { t.remaining = Math.max(0, t.endsAt - Date.now()); t.endsAt = null; t.running = false; }
    else if (t.remaining <= 0) { timerStart(t.duration); return; }
    else { t.endsAt = Date.now() + t.remaining; t.running = true; t.visible = true; }
    persist(); renderTimer(); publish();
  }
  function timerReset() { Object.assign(view.timer, { running: false, endsAt: null, remaining: view.timer.duration * 1000 }); persist(); renderTimer(); publish(); }
  function timerAdd(s) {
    const t = view.timer;
    if (t.running) t.endsAt += s * 1000; else t.remaining += s * 1000;
    t.duration = Math.max(t.duration, Math.ceil((t.running ? t.endsAt - Date.now() : t.remaining) / 1000));
    persist(); renderTimer(); publish();
  }
  function timerHide() { Object.assign(view.timer, { visible: false }); if (view.timer.running) timerToggle(); else { persist(); renderTimer(); publish(); } }
  let lastTick = null;
  setInterval(() => {
    const t = view.timer;
    if (t.running) {
      const rem = t.endsAt - Date.now();
      const sec = Math.ceil(rem / 1000);
      if (rem <= 0) {
        Object.assign(t, { running: false, endsAt: null, remaining: 0 });
        persist(); publish(); emitFx('timeup');
      } else if (sec <= 5 && sec !== lastTick) { lastTick = sec; emitFx('tick'); }
    }
    renderTimer();
  }, 200);
  setInterval(renderStatus, 2000);

  /* ================================================================ rendering */
  const PHASE_LABEL = { faceoff: 'Face-off', decide: 'Play or Pass', play: 'Playing the board', steal: 'Steal', ended: 'Round over' };
  const tName = (t) => (t === 0 || t === 1 ? esc(game.teams[t].name) : '—');

  function setHTML(el, html) {
    if (!el) return;
    const active = document.activeElement;
    const keep = active && el.contains(active) && active.id ? { id: active.id, value: active.value, s: active.selectionStart, e: active.selectionEnd } : null;
    el.innerHTML = html;
    if (keep) {
      const n = document.getElementById(keep.id);
      if (n) { n.value = keep.value; n.focus(); try { n.setSelectionRange(keep.s, keep.e); } catch (e) { /* not a text field */ } }
    }
  }

  function render() {
    document.querySelectorAll('#modeTabs button').forEach((b) => b.classList.toggle('active', b.dataset.v === game.mode));
    $('#btnUndo').disabled = !undo.u.length;
    $('#btnUndo').title = undo.u.length ? `Undo: ${undo.u[undo.u.length - 1].label} (Ctrl/Cmd+Z)` : 'Nothing to undo';
    $('#btnRedo').disabled = !undo.r.length;
    $('#mainView').hidden = game.mode !== 'main';
    $('#fmView').hidden = game.mode !== 'fastmoney';
    renderStatus();
    renderTeams();
    renderScenes();
    if (game.mode === 'main') {
      renderRoundBar(); renderQuestion(); renderAnswers(); renderBoardActions(); renderFlow(); renderOverrides();
    } else {
      renderFM();
    }
    renderTimer();
    renderLog();
  }

  function renderStatus() {
    const on = displayConnected();
    const el = $('#displayStatus');
    el.className = 'status ' + (on ? 'on' : 'off');
    el.textContent = on ? 'Display connected' : 'Display not connected';
  }

  function renderTeams() {
    const r = game.round;
    const html = game.teams.map((t, i) => {
      const badges = [];
      if (game.mode === 'main') {
        if (r.phase === 'decide' && r.faceoffWinner === i) badges.push('<span class="badge gold">Won face-off</span>');
        if ((r.phase === 'play' || r.phase === 'steal') && r.control === i) badges.push('<span class="badge blue">Playing</span>');
        if (r.phase === 'steal' && r.stealTeam === i) badges.push('<span class="badge red">Stealing</span>');
      }
      if (game.winner === i) badges.push('<span class="badge gold">Winner</span>');
      const active = game.mode === 'main' && ((r.phase === 'play' && r.control === i) || (r.phase === 'steal' && r.stealTeam === i));
      return `<div class="team-card t${i} ${active ? 'active' : ''}">
        <div class="team-head"><input class="team-name" id="teamName${i}" data-change="renameTeam" data-t="${i}" value="${esc(t.name)}" aria-label="Team ${i + 1} name"></div>
        <div class="team-badges">${badges.join('')}</div>
        <div class="team-score">${t.score}</div>
        <div class="team-adjust">
          <button class="btn sm" data-act="adjust" data-t="${i}" data-d="-10">−10</button>
          <button class="btn sm" data-act="adjust" data-t="${i}" data-d="-1">−1</button>
          <button class="btn sm" data-act="adjust" data-t="${i}" data-d="1">+1</button>
          <button class="btn sm" data-act="adjust" data-t="${i}" data-d="10">+10</button>
        </div>
        <div class="team-adjust">
          <input type="number" class="num-in" id="adj${i}" placeholder="points">
          <button class="btn sm" data-act="adjustBy" data-t="${i}" data-sign="1" title="Add these points">Add</button>
          <button class="btn sm" data-act="adjustBy" data-t="${i}" data-sign="-1" title="Subtract these points">Sub</button>
          <button class="btn sm" data-act="setScoreFrom" data-t="${i}" title="Set score to this value">Set</button>
        </div>
      </div>`;
    }).join('');
    setHTML($('#teamsPanel'), `<div class="panel-title">Teams</div>${html}`);
  }

  function renderScenes() {
    const scenes = [['game', game.mode === 'fastmoney' ? 'Fast Money board' : 'Game board'], ['title', 'Title'], ['scores', 'Scores'], ['winner', 'Winner']];
    const html = `<div class="panel-title">Audience display</div>
      <div class="seg">${scenes.map(([k, l]) => `<button class="${view.scene === k ? 'active' : ''}" data-act="scene" data-v="${k}">${l}</button>`).join('')}</div>
      <label class="check"><input type="checkbox" data-change="showQuestion" ${view.showQuestion ? 'checked' : ''}> Show question on display <kbd>Q</kbd></label>
      <label class="check"><input type="checkbox" data-change="preview" ${view.preview ? 'checked' : ''}> Show live preview here</label>`;
    setHTML($('#sceneControls'), html);
    // The preview iframe lives outside the re-rendered markup so it never reloads.
    const frame = $('#previewFrame');
    if (view.preview && !frame) {
      const f = document.createElement('iframe');
      f.id = 'previewFrame'; f.src = 'display.html?preview=1'; f.title = 'Display preview'; f.tabIndex = -1;
      $('#previewHolder').appendChild(f);
    } else if (!view.preview && frame) frame.remove();
  }

  function renderRoundBar() {
    const r = game.round;
    const opts = pack.questions.map((q, i) => {
      const played = game.played.includes(q.id) ? '✓ ' : '';
      return `<option value="${q.id}" ${q.id === r.qid ? 'selected' : ''}>${played}${i + 1}. ${esc(q.question.slice(0, 70))}</option>`;
    }).join('');
    const mults = [1, 2, 3, 4];
    if (!mults.includes(r.multiplier)) mults.push(r.multiplier);
    setHTML($('#roundBar'), `<div class="round-bar">
      <button class="btn icon" data-act="prevRound" title="Previous question">◀</button>
      <div class="round-label">ROUND <b>${game.roundNo}</b></div>
      <select id="qSelect" class="q-select" data-change="gotoQuestion" title="Jump to any question">${r.qid && !F.findQuestion(pack, r.qid) ? '<option selected>(question removed from pack)</option>' : ''}${opts}</select>
      <button class="btn icon" data-act="randomQuestion" title="Random unplayed question">⚄</button>
      <label class="mult">Points <select data-change="setMultiplier">${mults.map((m) => `<option value="${m}" ${m === r.multiplier ? 'selected' : ''}>×${m}</option>`).join('')}</select></label>
      <span class="phase-pill p-${r.phase}">${PHASE_LABEL[r.phase]}${r.suddenDeath ? ' · Sudden death' : ''}</span>
      <button class="btn primary" data-act="nextRound" title="Next round (N)">Next round ▶</button>
    </div>`);
  }

  function renderQuestion() {
    const r = game.round;
    setHTML($('#questionBox'), `<div class="question-box">
      <div class="q-text">${esc(r.question) || '<span class="muted">No question — add some in Questions.</span>'}</div>
      <button class="btn sm ${view.showQuestion ? 'on' : ''}" data-act="toggleQuestion" title="Toggle question on the audience display (Q)">${view.showQuestion ? 'Shown on display' : 'Hidden from display'}</button>
    </div>`);
  }

  function renderAnswers() {
    const r = game.round;
    const n = r.answers.length, slots = F.slotsFor(n);
    let cells = '';
    for (let i = 0; i < slots; i++) {
      if (i >= n) { cells += '<div class="ans empty"></div>'; continue; }
      const a = r.answers[i], rv = r.revealed[i];
      const st = rv ? (r.scored[i] ? `in bank +${r.scored[i] * r.multiplier}` : 'shown · no points') : 'click to reveal';
      cells += `<button class="ans ${rv ? 'revealed' : ''}" data-act="reveal" data-i="${i}" title="${rv ? 'Already revealed — points can only be counted once' : 'Reveal (key ' + ((i + 1) % 10) + '). Shift-click reveals without points.'}">
        <span class="num">${i + 1}</span><span class="txt">${esc(a.text)}</span><span class="pts">${a.points}</span>
        <span class="state">${st}</span>${rv ? `<span class="hide-btn" data-act="hide" data-i="${i}" title="Hide this answer again">hide</span>` : ''}
      </button>`;
    }
    setHTML($('#answersGrid'), `<div class="answers" style="--rows:${slots / 2}">${cells}</div>`);
  }

  function strikeLabel(r) {
    return { faceoff: 'Wrong answer', decide: 'Wrong answer', play: `Strike (${r.strikes}/${settings.maxStrikes})`, steal: 'Steal failed', ended: 'Buzzer' }[r.phase];
  }

  function renderBoardActions() {
    const r = game.round, max = Math.max(1, F.toInt(settings.maxStrikes));
    let dots = '';
    for (let k = 0; k < max; k++) dots += `<span class="x ${k < r.strikes ? 'on' : ''}">✕</span>`;
    setHTML($('#boardActions'), `<div class="board-actions">
      <button class="btn strike" data-act="strike" title="X">✕ ${strikeLabel(r)} <kbd>X</kbd></button>
      <div class="strike-dots" title="Strikes">${dots}</div>
      <button class="btn" data-act="revealAll" title="Reveal every remaining answer without awarding points (A)">Reveal all <kbd>A</kbd></button>
      <div class="bank"><span>BANK</span><b>${F.bankShown(r)}</b>${r.multiplier > 1 ? `<small>×${r.multiplier} applied</small>` : ''}</div>
    </div>`);
  }

  function renderFlow() {
    const r = game.round, t0 = tName(0), t1 = tName(1);
    let h = '';
    if (r.phase === 'faceoff') {
      h = `<div class="step">Step 1 · Face-off</div>
        <p>One player from each team buzzes in. Click their answer on the board${settings.faceoffPointsToBank ? ' (points go in the bank)' : ''}, or press <b>Wrong answer</b>. Then choose who won:</p>
        ${r.suddenDeath ? '<p class="note">Sudden death: the face-off winner takes the bank immediately.</p>' : ''}
        <div class="big-btns"><button class="btn big t0" data-act="faceoffWinner" data-t="0">${t0} won <kbd>[</kbd></button><button class="btn big t1" data-act="faceoffWinner" data-t="1">${t1} won <kbd>]</kbd></button></div>`;
    } else if (r.phase === 'decide') {
      const w = r.faceoffWinner ?? 0;
      h = `<div class="step">Step 2 · Play or Pass</div>
        <p><b>${tName(w)}</b> won the face-off. Do they play the board or pass it?</p>
        <div class="big-btns"><button class="btn big primary" data-act="decide" data-v="play">${tName(w)} PLAYS <kbd>P</kbd></button><button class="btn big" data-act="decide" data-v="pass">Pass to ${tName(F.other(w))}</button></div>
        <button class="btn link" data-act="phase" data-v="faceoff">← back to face-off</button>`;
    } else if (r.phase === 'play') {
      h = `<div class="step">Step 3 · ${tName(r.control)} is playing</div>
        <p>Click each correct answer. Press <b>Strike</b> for a wrong one. After ${settings.maxStrikes} strikes, ${tName(F.other(r.control))} gets one chance to steal.</p>
        <div class="big-btns"><button class="btn big strike" data-act="strike">✕ Strike ${r.strikes + 1 <= settings.maxStrikes ? r.strikes + 1 : ''} <kbd>X</kbd></button></div>`;
    } else if (r.phase === 'steal') {
      h = `<div class="step steal">Step 4 · ${tName(r.stealTeam)} can steal!</div>
        <p>Ask ${tName(r.stealTeam)} for one answer. If it is on the board, <b>click it</b> and they win the bank. If not, press <b>Steal failed</b> and ${tName(r.control)} keeps it.</p>
        <div class="big-btns"><button class="btn big strike" data-act="strike">✕ Steal failed → ${tName(r.control)}</button>
        <button class="btn big" data-act="timerStart" data-v="${F.toInt(settings.stealTimer) || 10}">Start ${F.toInt(settings.stealTimer) || 10}s timer</button></div>`;
    } else {
      const res = r.result || {};
      const how = { cleared: 'cleared the board', steal: 'stole the bank', 'steal-failed': 'kept the bank (steal failed)', 'sudden-death': 'won sudden death', manual: 'awarded by host' }[res.how] || '';
      h = `<div class="step done">Round over</div>
        <p>${res.team != null ? `<b>${tName(res.team)}</b> ${how}: <b>+${res.amount}</b>` : 'No points were awarded this round.'}</p>
        <div class="big-btns">${r.revealed.every(Boolean) ? '' : '<button class="btn big" data-act="revealAll">Show remaining answers</button>'}
        <button class="btn big primary" data-act="nextRound">Next round ▶ <kbd>N</kbd></button></div>`;
    }
    if (game.winner != null) {
      h += `<div class="winner-note">🏆 <b>${tName(game.winner)}</b> reached ${settings.winningScore}!
        <div class="big-btns"><button class="btn" data-act="scene" data-v="winner">Show winner screen</button><button class="btn" data-act="setMode" data-v="fastmoney">Go to Fast Money</button></div>
        <button class="btn link" data-act="clearWinner">dismiss</button></div>`;
    }
    setHTML($('#flowPanel'), h);
  }

  function renderOverrides() {
    const r = game.round;
    const phases = ['faceoff', 'decide', 'play', 'steal', 'ended'];
    setHTML($('#overridesPanel'), `<div class="ov">
      <div class="ov-row"><span>Control</span>
        <div class="seg sm"><button class="${r.control === 0 ? 'active' : ''}" data-act="setControl" data-t="0">${tName(0)}</button><button class="${r.control === 1 ? 'active' : ''}" data-act="setControl" data-t="1">${tName(1)}</button><button class="${r.control == null ? 'active' : ''}" data-act="setControl" data-t="">none</button></div></div>
      <div class="ov-row"><span>Phase</span>
        <select data-change="setPhase">${phases.map((p) => `<option value="${p}" ${p === r.phase ? 'selected' : ''}>${PHASE_LABEL[p]}</option>`).join('')}</select></div>
      <div class="ov-row"><span>Strikes</span>
        <div class="stepper"><button class="btn sm" data-act="strikes" data-d="-1">−</button><b>${r.strikes}</b><button class="btn sm" data-act="strikes" data-d="1">+</button></div></div>
      <div class="ov-row"><span>Bank</span>
        <div class="inline"><input type="number" class="num-in" id="bankIn" placeholder="${F.bank(r)}"><button class="btn sm" data-act="setBank">Set</button></div></div>
      <div class="ov-row"><span>Award bank (${F.bank(r)})</span>
        <div class="inline"><button class="btn sm" data-act="award" data-t="0">→ ${tName(0)}</button><button class="btn sm" data-act="award" data-t="1">→ ${tName(1)}</button></div></div>
      <p class="muted small">Awarding again moves the points: the previous award is taken back first.</p>
      <div class="ov-row"><span>Round #</span>
        <div class="inline"><input type="number" class="num-in" id="roundNoIn" placeholder="${game.roundNo}" min="1"><button class="btn sm" data-act="setRoundNo">Set</button></div></div>
      <div class="ov-row wrap">
        <button class="btn sm" data-act="endNoAward">End round, no award</button>
        <button class="btn sm" data-act="restartRound">Restart this round</button>
        <button class="btn sm ${r.suddenDeath ? 'on' : ''}" data-act="suddenDeath">Sudden death: ${r.suddenDeath ? 'ON' : 'off'}</button>
        <button class="btn sm" data-act="refreshRound" title="Reload this question's text and answers from the editor">Reload question from editor</button>
      </div>
    </div>`);
  }

  function renderTimer() {
    const t = view.timer;
    const rem = t.running ? Math.max(0, t.endsAt - Date.now()) : t.remaining;
    const el = $('#timerReadout');
    if (el) {
      el.textContent = Math.ceil(rem / 1000);
      el.classList.toggle('running', t.running);
      el.classList.toggle('low', t.running && rem < 5500);
    }
    const b = $('#timerToggleBtn');
    if (b) b.textContent = t.running ? 'Pause' : rem <= 0 ? 'Restart' : 'Start';
    const fmT = $('#fmTimer');
    if (fmT) { fmT.textContent = Math.ceil(rem / 1000); fmT.classList.toggle('running', t.running); }
  }

  function renderLog() {
    const items = game.log.slice(-60).reverse().map((e) => `<li><time>${new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time> ${esc(e.m)}</li>`).join('');
    setHTML($('#logList'), items || '<li class="muted">Actions will appear here.</li>');
  }

  /* ---------------------------------------------------------------- fast money */
  function matchSurvey(q, text) {
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(es|s)$/, '');
    const t = norm(text);
    if (!t) return -1;
    return q.answers.findIndex((a) => { const n = norm(a.text); return n === t || (t.length > 3 && (n.startsWith(t) || t.startsWith(n))); });
  }

  function renderFM() {
    const fm = game.fm;
    const total = F.fmTotal(fm), potential = F.fmPotential(fm);
    const cell = (p, i) => {
      const e = fm.entries[p][i], q = fm.questions[i];
      const shown = e.showText && e.showPts;
      return `<div class="fm-entry ${shown ? 'shown' : ''} ${p === 0 && fm.hideP1 ? 'p1hidden' : ''}">
        <input id="fm${p}_${i}_t" class="fm-text" data-change="fmText" data-p="${p}" data-i="${i}" value="${esc(e.text)}" placeholder="Answer given…">
        <select data-change="fmPick" data-p="${p}" data-i="${i}" title="Match to a survey answer">
          <option value="-1" ${e.pick === -1 ? 'selected' : ''}>match…</option>
          ${q.answers.map((a, k) => `<option value="${k}" ${e.pick === k ? 'selected' : ''}>${esc(a.text)} (${a.points})</option>`).join('')}
          <option value="-2" ${e.pick === -2 ? 'selected' : ''}>Not on board (0)</option>
        </select>
        <input id="fm${p}_${i}_p" type="number" class="num-in fm-pts" data-change="fmPts" data-p="${p}" data-i="${i}" value="${F.toInt(e.points)}" title="Points">
        <button class="btn sm ${shown ? '' : 'primary'}" data-act="${shown ? 'fmHide' : 'fmReveal'}" data-p="${p}" data-i="${i}">${shown ? 'Hide' : 'Reveal'}</button>
        ${p === 1 ? `<button class="btn sm" data-act="fmDup" title="Duplicate answer buzzer — ask for another answer">Dup</button>` : ''}
      </div>`;
    };
    const rows = fm.questions.map((q, i) => `<tr>
      <td class="fm-n">${i + 1}</td>
      <td class="fm-qcell"><div class="fm-q">${esc(q.question)}</div><div class="fm-survey">${q.answers.map((a) => `<span>${esc(a.text)} <b>${a.points}</b></span>`).join('')}</div></td>
      <td class="${fm.player === 0 ? 'cur' : ''}">${cell(0, i)}</td>
      <td class="${fm.player === 1 ? 'cur' : ''}">${cell(1, i)}</td></tr>`).join('');
    setHTML($('#fmView'), `<div class="panel fm-panel">
      <div class="fm-bar">
        <div class="seg"><button class="${fm.player === 0 ? 'active' : ''}" data-act="fmPlayer" data-p="0">Player 1</button><button class="${fm.player === 1 ? 'active' : ''}" data-act="fmPlayer" data-p="1">Player 2</button></div>
        <button class="btn primary" data-act="timerStart" data-v="${fm.player === 0 ? settings.fastMoneyTime1 : settings.fastMoneyTime2}">Start ${fm.player === 0 ? settings.fastMoneyTime1 : settings.fastMoneyTime2}s timer</button>
        <div class="timer-readout sm" id="fmTimer">0</div>
        <button class="btn" data-act="timerToggle">Pause / resume</button>
        <label class="check"><input type="checkbox" data-change="fmHideP1" ${fm.hideP1 ? 'checked' : ''}> Hide player 1 answers on display</label>
        <div class="spacer"></div>
        <div class="fm-total">Total shown <b>${total}</b> <span class="muted">/ ${potential} entered</span></div>
        <label class="mult">Goal <input type="number" class="num-in" id="fmTargetIn" data-change="fmTarget" value="${fm.target}"></label>
      </div>
      <table class="fm-table"><thead><tr><th>#</th><th>Question &amp; survey answers (host only)</th><th>Player 1</th><th>Player 2</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="fm-bar">
        <button class="btn" data-act="fmRevealAll" data-p="0">Reveal all of player 1</button>
        <button class="btn" data-act="fmRevealAll" data-p="1">Reveal all of player 2</button>
        <div class="spacer"></div>
        ${fm.won ? '<span class="badge gold">Goal reached!</span>' : ''}
        <button class="btn" data-act="scene" data-v="winner">Show winner screen</button>
        <button class="btn" data-act="fmReset" data-v="">Reset (Fast Money questions)</button>
        <button class="btn" data-act="fmReset" data-v="main">Reset (use main questions)</button>
        <button class="btn" data-act="setMode" data-v="main">← Back to main game</button>
      </div>
      <p class="muted small">Type what the player said, then pick the matching survey answer (or type points). Typing an exact survey answer matches it automatically. Reveal shows the answer then its points on the display. Dup plays the duplicate-answer buzzer.</p>
    </div>`);
  }

  /* ================================================================ modals */
  function openModal(name) { modal = name; renderModal(); }
  function closeModal() {
    modal = null; $('#modalRoot').innerHTML = '';
    savePack(true);
    F.syncOrder(game, pack);
    render();
  }

  function renderModal() {
    const root = $('#modalRoot');
    if (!modal) { root.innerHTML = ''; return; }
    const body = { settings: settingsHTML, newgame: newGameHTML, history: historyHTML, help: helpHTML, editor: editorHTML }[modal]();
    const wide = modal === 'editor' ? 'wide' : '';
    const titles = { settings: 'Settings', newgame: 'New game', history: 'History', help: 'How to run the game', editor: 'Questions' };
    setHTML(root, `<div class="modal-backdrop" data-act="closeModalBackdrop"><div class="modal ${wide}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${titles[modal]}</h2><button class="btn icon" data-act="closeModal" title="Close (Esc)">✕</button></div>
      <div class="modal-body">${body}</div></div></div>`);
  }

  function field(key, label, type, extra) {
    const v = settings[key];
    if (type === 'checkbox') return `<label class="check"><input type="checkbox" data-setting="${key}" ${v ? 'checked' : ''}> ${label}</label>`;
    if (type === 'select') return `<label class="field"><span>${label}</span><select data-setting="${key}">${extra.map(([k, l]) => `<option value="${k}" ${String(v) === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
    if (type === 'range') return `<label class="field"><span>${label}</span><input type="range" min="0" max="1" step="0.05" data-setting="${key}" value="${v}"></label>`;
    return `<label class="field"><span>${label}</span><input type="${type}" data-setting="${key}" value="${esc(v)}" ${extra || ''}></label>`;
  }

  function settingsHTML() {
    return `<div class="settings-grid">
      <fieldset><legend>Game</legend>
        ${field('gameTitle', 'Game title (shown on the title screen)', 'text')}
        ${field('maxStrikes', 'Strikes before a steal', 'number', 'min="1" max="6"')}
        ${field('multipliers', 'Point multiplier per round (last value repeats)', 'text', 'placeholder="1, 1, 2, 3"')}
        ${field('winningScore', 'Winning score (0 = no target)', 'number', 'min="0"')}
        ${field('suddenDeathMultiplier', 'Sudden death multiplier', 'number', 'min="1"')}
        ${field('shuffleQuestions', 'Shuffle question order for new games', 'checkbox')}
        ${field('showQuestionOnLoad', 'Show the question on the display when a new game starts', 'checkbox')}
      </fieldset>
      <fieldset><legend>Rules</legend>
        ${field('faceoffPointsToBank', 'Face-off answers add to the bank', 'checkbox')}
        ${field('stealAddsAnswerPoints', 'A successful steal answer adds its points to the bank', 'checkbox')}
        ${field('autoAwardOnClear', 'Clearing the board awards the bank automatically', 'checkbox')}
        ${field('faceoffTimer', 'Face-off timer when a round loads (seconds, 0 = off)', 'number', 'min="0"')}
        ${field('stealTimer', 'Steal timer that starts automatically (seconds, 0 = off)', 'number', 'min="0"')}
      </fieldset>
      <fieldset><legend>Fast Money</legend>
        ${field('fastMoneyTarget', 'Goal (points)', 'number', 'min="0"')}
        ${field('fastMoneyTime1', 'Player 1 time (seconds)', 'number', 'min="1"')}
        ${field('fastMoneyTime2', 'Player 2 time (seconds)', 'number', 'min="1"')}
      </fieldset>
      <fieldset><legend>Sound</legend>
        ${field('sound', 'Sound effects on', 'checkbox')}
        ${field('volume', 'Volume', 'range')}
        ${field('soundOutput', 'Play sounds from', 'select', [['auto', 'Display window if open, otherwise this window'], ['display', 'Display window only'], ['host', 'This (host) window only'], ['both', 'Both windows']])}
        <div class="inline"><button class="btn sm" data-act="testSound" data-v="reveal">Test ding</button><button class="btn sm" data-act="testSound" data-v="strike">Test buzzer</button><button class="btn sm" data-act="testSound" data-v="win">Test fanfare</button></div>
        <p class="muted small">The display window needs one click before the browser lets it play sound.</p>
      </fieldset>
      <fieldset class="span2"><legend>Backup &amp; data</legend>
        <p class="muted small">Everything saves automatically in this browser. A backup file lets you move a game, questions and settings to another computer or browser.</p>
        <div class="inline wrap">
          <button class="btn" data-act="exportBackup">Download full backup</button>
          <button class="btn" data-act="importFile" data-v="backup">Restore from backup…</button>
          <button class="btn danger" data-act="resetAll">Erase everything &amp; start fresh</button>
        </div>
      </fieldset>
    </div>`;
  }

  function newGameHTML() {
    return `<div class="form-col">
      <label class="field"><span>Team 1 name</span><input id="ngT1" value="${esc(game.teams[0].name)}"></label>
      <label class="field"><span>Team 2 name</span><input id="ngT2" value="${esc(game.teams[1].name)}"></label>
      <label class="check"><input type="checkbox" id="ngShuffle" ${settings.shuffleQuestions ? 'checked' : ''}> Shuffle question order</label>
      <p class="muted small">Scores reset to 0 and the game starts from the first question in “${esc(pack.title)}” (${pack.questions.length} questions). The current game is saved to History, and Undo brings it back.</p>
      <div class="inline"><button class="btn primary big" data-act="startNewGame">Start new game</button><button class="btn" data-act="closeModal">Cancel</button></div>
    </div>`;
  }

  function historyHTML() {
    const hist = F.Store.get(K.history, []);
    const rows = hist.map((h) => {
      const [a, b] = h.teams;
      const win = a.score === b.score ? 'Tie' : esc(a.score > b.score ? a.name : b.name);
      return `<tr><td>${new Date(h.started).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td><td>${esc(a.name)} <b>${a.score}</b> — ${esc(b.name)} <b>${b.score}</b></td><td>${win}</td><td>${h.rounds}</td><td>${h.fm || '—'}</td></tr>`;
    }).join('');
    const log = game.log.slice().reverse().map((e) => `<li><time>${new Date(e.t).toLocaleTimeString()}</time> ${esc(e.m)}</li>`).join('');
    return `<h3>Past games</h3>
      ${rows ? `<table class="table"><thead><tr><th>Started</th><th>Score</th><th>Winner</th><th>Rounds</th><th>Fast Money</th></tr></thead><tbody>${rows}</tbody></table>
      <button class="btn sm danger" data-act="clearHistory">Clear past games</button>` : '<p class="muted">Finished games appear here when you start a new game.</p>'}
      <h3>This game's log</h3><ol class="log tall">${log || '<li class="muted">Nothing yet.</li>'}</ol>`;
  }

  function helpHTML() {
    const keys = [['1 … 9, 0', 'Reveal answer 1–10 (hold Shift to reveal without points)'], ['X', 'Wrong answer / strike / steal failed'], ['A', 'Reveal all remaining answers (no points)'], ['[ and ]', 'Face-off won by team 1 / team 2'], ['P', 'Face-off winner plays'], ['Shift+P', 'Face-off winner passes'], ['N', 'Next round'], ['Q', 'Show / hide question on the display'], ['T', 'Start / pause timer'], ['D', 'Open the display window'], ['Ctrl/Cmd+Z', 'Undo'], ['Ctrl/Cmd+Shift+Z or Ctrl+Y', 'Redo'], ['F (on display)', 'Toggle fullscreen on the display'], ['?', 'This help'], ['Esc', 'Close a dialog']];
    return `<div class="help">
      <ol class="steps">
        <li><b>Open Display</b> and drag that window to the projector or TV. Click it once (this enables sound), then press <b>F</b> for fullscreen.</li>
        <li>Name the teams on the left. The question and answers are only visible here, on your screen.</li>
        <li><b>Face-off:</b> click answers as players give them, press <b>X</b> for a wrong one, then choose which team won.</li>
        <li><b>Play or Pass:</b> pick what the winning team decides.</li>
        <li><b>Play the board:</b> click correct answers, press <b>X</b> for strikes. At 3 strikes the other team gets to steal.</li>
        <li><b>Steal:</b> click their answer if it's on the board (they win the bank), or press <b>Steal failed</b>.</li>
        <li>The bank is awarded automatically. Press <b>Next round</b>. Later rounds use the multipliers from Settings.</li>
      </ol>
      <p><b>Made a mistake?</b> Press Undo (Ctrl/Cmd+Z) as many times as you need. The <b>Host overrides</b> panel can also change control, strikes, bank and phase, or move an award to the other team.</p>
      <p><b>Only one screen?</b> Use <i>Print answer sheets</i> in Questions, keep the display window fullscreen, and control the game with the keyboard. Keys pressed on the display window work too.</p>
      <table class="table keys"><tbody>${keys.map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join('')}</tbody></table>
    </div>`;
  }

  /* ---------------------------------------------------------------- editor */
  function edList() { return editor.tab === 'fastMoney' ? pack.fastMoney : pack.questions; }
  function edCurrent() {
    const list = edList();
    let q = list.find((x) => x.id === editor.sel);
    if (!q && list.length) { q = list[0]; editor.sel = q.id; }
    return q || null;
  }

  function editorHTML() {
    const list = edList();
    const q = edCurrent();
    const s = editor.search.toLowerCase();
    const items = list.map((x, i) => {
      if (s && !(x.question.toLowerCase().includes(s) || x.answers.some((a) => a.text.toLowerCase().includes(s)))) return '';
      const played = editor.tab === 'questions' && game.played.includes(x.id) ? '<span class="tag">played</span>' : '';
      const live = editor.tab === 'questions' && game.round.qid === x.id ? '<span class="tag live">on board</span>' : '';
      return `<li class="${x.id === editor.sel ? 'sel' : ''}" data-act="edSelect" data-id="${x.id}"><span class="n">${i + 1}</span><span class="t" id="edItem_${x.id}">${esc(x.question) || '<i>Untitled</i>'}</span>${live}${played}</li>`;
    }).join('');
    const sum = q ? q.answers.reduce((a, b) => a + F.toInt(b.points), 0) : 0;
    const form = q ? `<div class="ed-form">
        <label class="field"><span>Question</span><textarea id="edQ" data-ed="question" rows="2">${esc(q.question)}</textarea></label>
        <div class="ed-answers">
          <div class="ed-ans-head"><span>#</span><span>Answer</span><span>Points</span><span></span></div>
          ${q.answers.map((a, k) => `<div class="ed-ans">
            <span class="n">${k + 1}</span>
            <input id="edA${k}" data-ed="text" data-k="${k}" value="${esc(a.text)}" placeholder="Answer">
            <input id="edP${k}" type="number" class="num-in" data-ed="points" data-k="${k}" value="${a.points}">
            <span class="ed-tools"><button class="btn sm icon" data-act="edMove" data-k="${k}" data-d="-1" title="Move up">↑</button><button class="btn sm icon" data-act="edMove" data-k="${k}" data-d="1" title="Move down">↓</button><button class="btn sm icon" data-act="edDelAns" data-k="${k}" title="Remove answer">✕</button></span>
          </div>`).join('')}
        </div>
        <div class="inline wrap">
          <button class="btn sm" data-act="edAddAns" ${q.answers.length >= 10 ? 'disabled' : ''}>+ Add answer</button>
          <button class="btn sm" data-act="edSort">Sort by points</button>
          <span class="muted small" id="edSum">Total ${sum} points · ${q.answers.length}/10 answers</span>
        </div>
        ${editor.tab === 'questions' ? `<label class="field inline-field"><span>Multiplier for this question</span>
          <select data-ed="multiplier"><option value="">Use round default</option>${[1, 2, 3, 4].map((m) => `<option value="${m}" ${q.multiplier === m ? 'selected' : ''}>×${m}</option>`).join('')}</select></label>` : ''}
        <div class="inline wrap ed-actions">
          ${editor.tab === 'questions' ? `<button class="btn primary sm" data-act="edPlay">Put on the board now</button>` : ''}
          ${editor.tab === 'questions' && game.round.qid === q.id ? `<button class="btn sm" data-act="refreshRound">Update the live board with these edits</button>` : ''}
          <button class="btn sm" data-act="edDup">Duplicate</button>
          <button class="btn sm danger" data-act="edDelete">Delete question</button>
        </div>
      </div>` : '<p class="muted">No questions yet. Add one, or import a pack.</p>';
    return `<div class="editor">
      <div class="ed-side">
        <div class="seg"><button class="${editor.tab === 'questions' ? 'active' : ''}" data-act="edTab" data-v="questions">Main (${pack.questions.length})</button><button class="${editor.tab === 'fastMoney' ? 'active' : ''}" data-act="edTab" data-v="fastMoney">Fast Money (${pack.fastMoney.length})</button></div>
        <input id="edSearch" class="search" data-ed-search placeholder="Search questions…" value="${esc(editor.search)}">
        <ol class="ed-list">${items}</ol>
        <button class="btn sm" data-act="edAdd">+ New question</button>
        ${editor.tab === 'fastMoney' ? '<p class="muted small">Fast Money uses the first 5 questions in this list.</p>' : ''}
      </div>
      <div class="ed-main">${form}</div>
      <div class="ed-foot">
        <label class="field inline-field"><span>Pack title</span><input id="edTitle" data-ed="packTitle" value="${esc(pack.title)}"></label>
        <div class="spacer"></div>
        <button class="btn sm" data-act="importFile" data-v="replace">Import pack (replace)…</button>
        <button class="btn sm" data-act="importFile" data-v="append">Import pack (add)…</button>
        <button class="btn sm" data-act="exportPack">Export pack</button>
        <button class="btn sm" data-act="printSheets">Print answer sheets</button>
        <button class="btn sm" data-act="restoreSample">Load sample pack</button>
      </div>
    </div>`;
  }

  function editorInput(el) {
    const q = edCurrent();
    const k = F.toInt(el.dataset.k);
    switch (el.dataset.ed) {
      case 'question': q.question = el.value; { const it = document.getElementById('edItem_' + q.id); if (it) it.textContent = el.value || 'Untitled'; } break;
      case 'text': q.answers[k].text = el.value; break;
      case 'points': q.answers[k].points = F.toInt(el.value); { const s = $('#edSum'); if (s) s.textContent = `Total ${q.answers.reduce((a, b) => a + F.toInt(b.points), 0)} points · ${q.answers.length}/10 answers`; } break;
      case 'multiplier': q.multiplier = Number(el.value) || null; break;
      case 'packTitle': pack.title = el.value; break;
      default: return;
    }
    savePack();
  }

  /* ---------------------------------------------------------------- files */
  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const slug = (s) => String(s || 'pack').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pack';

  $('#fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let raw;
    try { raw = JSON.parse(await file.text()); } catch (err) { toast('That file is not valid JSON.', 'error'); return; }
    if (raw && raw.feudBackup) {
      if (!confirm('Restore this backup? It replaces the current game, questions and settings. (You can undo the game change.)')) return;
      try {
        const p = F.normalizePack(raw.pack);
        undo.u.push({ label: 'restore backup', s: JSON.stringify(game) });
        pack = p; savePack(true);
        settings = Object.assign({}, F.DEFAULT_SETTINGS, raw.settings || {}); saveSettings();
        if (validGame(raw.game)) { game = raw.game; if (!game.fm) game.fm = F.makeFastMoney(pack, settings); if (!game.log) game.log = []; }
        if (Array.isArray(raw.history)) F.Store.set(K.history, raw.history);
        F.syncOrder(game, pack);
        persist(); render(); publish(); renderModal();
        toast('Backup restored.');
      } catch (err) { toast('Could not restore: ' + err.message, 'error'); }
      return;
    }
    let incoming;
    try { incoming = F.normalizePack(raw); } catch (err) { toast(err.message, 'error'); return; }
    if (importMode === 'append') {
      pack.questions.push(...incoming.questions);
      pack.fastMoney.push(...incoming.fastMoney);
      toast(`Added ${incoming.questions.length} questions and ${incoming.fastMoney.length} Fast Money questions.`);
    } else {
      if (!confirm(`Replace the current pack (${pack.questions.length} questions) with “${incoming.title}” (${incoming.questions.length} questions)?`)) return;
      pack = incoming;
      toast(`Loaded “${pack.title}”. Press Next round or pick a question to use it.`);
    }
    savePack(true);
    F.syncOrder(game, pack);
    editor.sel = null;
    renderModal(); render();
  });

  function printSheets() {
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups to print answer sheets.', 'warn'); return; }
    const block = (q, i, label) => `<section><h3>${label} ${i + 1}${q.multiplier ? ` <small>(×${q.multiplier})</small>` : ''}</h3><p class="q">${esc(q.question)}</p>
      <table>${q.answers.map((a, k) => `<tr><td class="k">${k + 1}</td><td>${esc(a.text)}</td><td class="p">${a.points}</td></tr>`).join('')}</table></section>`;
    w.document.write(`<!DOCTYPE html><html><head><title>${esc(pack.title)} — answer sheets</title><style>
      body{font:13px/1.35 system-ui,Arial,sans-serif;margin:24px;color:#111} h1{font-size:20px} h2{margin-top:28px;border-bottom:2px solid #000}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 28px} section{break-inside:avoid;border:1px solid #bbb;border-radius:6px;padding:8px 12px}
      h3{margin:0 0 4px;font-size:13px;text-transform:uppercase;color:#555} .q{font-weight:700;margin:0 0 6px} table{width:100%;border-collapse:collapse}
      td{padding:2px 4px;border-top:1px solid #eee} .k{width:20px;color:#777} .p{text-align:right;font-weight:700;width:40px} @media print{button{display:none}}
      </style></head><body><button onclick="print()">Print</button><h1>${esc(pack.title)}</h1>
      <h2>Main questions</h2><div class="grid">${pack.questions.map((q, i) => block(q, i, 'Question')).join('')}</div>
      ${pack.fastMoney.length ? `<h2>Fast Money</h2><div class="grid">${pack.fastMoney.map((q, i) => block(q, i, 'Fast Money')).join('')}</div>` : ''}
      </body></html>`);
    w.document.close();
  }

  /* ================================================================ toasts */
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 4200);
    setTimeout(() => el.remove(), 4700);
  }

  /* ================================================================ events */
  function openDisplay() {
    if (displayWin && !displayWin.closed) { displayWin.focus(); return; }
    displayWin = window.open('display.html', 'feud-display', 'popup,width=1280,height=720');
    if (!displayWin) toast('The browser blocked the display window. Allow pop-ups for this page, then try again.', 'warn');
  }

  const clickHandlers = {
    setMode: (d) => { if (act('setMode', d.v) && view.timer.visible) { Object.assign(view.timer, { running: false, endsAt: null, visible: false, remaining: view.timer.duration * 1000 }); persist(); renderTimer(); publish(); } },
    undo: doUndo, redo: doRedo,
    openDisplay,
    modal: (d) => openModal(d.v),
    closeModal,
    closeModalBackdrop: (d, ev) => { if (ev.target.classList.contains('modal-backdrop')) closeModal(); },
    hostFullscreen: () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); },
    reveal: (d, ev) => act('reveal', F.toInt(d.i), ev.shiftKey),
    hide: (d) => act('hide', F.toInt(d.i)),
    revealAll: () => act('revealAll'),
    strike: () => act('strike'),
    faceoffWinner: (d) => act('faceoffWinner', F.toInt(d.t)),
    decide: (d) => act('decide', d.v),
    phase: (d) => act('setPhase', d.v),
    setControl: (d) => act('setControl', d.t === '' ? null : F.toInt(d.t)),
    strikes: (d) => act('setStrikes', game.round.strikes + F.toInt(d.d)),
    setBank: () => { const v = $('#bankIn').value; if (v === '') return toast('Type the new bank value first.'); act('setBank', v); },
    award: (d) => act('award', F.toInt(d.t)),
    endNoAward: () => act('endNoAward'),
    restartRound: () => act('restartRound'),
    suddenDeath: () => act('setSuddenDeath', !game.round.suddenDeath),
    refreshRound: () => { act('refreshRound'); if (modal) renderModal(); },
    setRoundNo: () => { const v = $('#roundNoIn').value; if (v !== '') act('setRoundNo', v); },
    nextRound: () => act('nextRound'),
    prevRound: () => act('prevRound'),
    randomQuestion: () => act('randomQuestion'),
    clearWinner: () => act('clearWinner'),
    adjust: (d) => act('adjustScore', F.toInt(d.t), F.toInt(d.d)),
    adjustBy: (d) => { const el = $('#adj' + d.t); const v = F.toInt(el.value); if (!v) return toast('Type a number of points first.'); act('adjustScore', F.toInt(d.t), v * F.toInt(d.sign)); el.value = ''; },
    setScoreFrom: (d) => { const el = $('#adj' + d.t); if (el.value === '') return toast('Type the new score first.'); act('setScore', F.toInt(d.t), el.value); el.value = ''; },
    scene: (d) => { setView({ scene: d.v }); if (d.v === 'winner' && game.winner == null && game.mode === 'main') { const w = game.teams[0].score === game.teams[1].score ? null : game.teams[0].score > game.teams[1].score ? 0 : 1; if (w != null) act('setWinner', w); } },
    toggleQuestion: () => setView({ showQuestion: !view.showQuestion }),
    timerStart: (d) => timerStart(d.v), timerToggle, timerReset, timerAdd: (d) => timerAdd(F.toInt(d.v)), timerHide,
    fmPlayer: (d) => act('fmPlayer', F.toInt(d.p)),
    fmReveal: (d) => act('fmReveal', F.toInt(d.p), F.toInt(d.i)),
    fmHide: (d) => act('fmHide', F.toInt(d.p), F.toInt(d.i)),
    fmRevealAll: (d) => act('fmRevealAll', F.toInt(d.p)),
    fmDup: () => emitFx('duplicate'),
    fmReset: (d) => { if (confirm('Clear all Fast Money answers? (Undo can bring them back.)')) act('fmReset', d.v === 'main'); },
    startNewGame: () => { const o = { team1: $('#ngT1').value.trim(), team2: $('#ngT2').value.trim(), shuffle: $('#ngShuffle').checked }; modal = null; $('#modalRoot').innerHTML = ''; startNewGame(o); },
    testSound: (d) => { F.Sound.unlock(); F.Sound.play(d.v); emitFx(d.v); },
    exportBackup: () => download(`feud-backup-${new Date().toISOString().slice(0, 10)}.json`, { feudBackup: 1, saved: new Date().toISOString(), settings, pack: F.exportPack(pack), game, history: F.Store.get(K.history, []) }),
    importFile: (d) => { importMode = d.v; $('#fileInput').click(); },
    resetAll: () => {
      if (!confirm('Erase ALL saved data (game, questions, settings, history) and start fresh? Download a backup first if unsure.')) return;
      Object.values(K).forEach((k) => F.Store.remove(k));
      location.reload();
    },
    clearHistory: () => { if (confirm('Delete the list of past games?')) { F.Store.set(K.history, []); renderModal(); } },
    exportPack: () => download(`${slug(pack.title)}.json`, F.exportPack(pack)),
    printSheets,
    restoreSample: () => { if (!confirm('Replace the current questions with the built-in sample pack?')) return; pack = F.normalizePack(F.clone(F.SAMPLE_PACK)); savePack(true); F.syncOrder(game, pack); editor.sel = null; renderModal(); render(); },
    edTab: (d) => { editor.tab = d.v; editor.sel = null; renderModal(); },
    edSelect: (d) => { editor.sel = d.id; renderModal(); },
    edAdd: () => { const q = { id: F.uid(), question: '', answers: [{ text: '', points: 0 }], multiplier: null }; edList().push(q); editor.sel = q.id; editor.search = ''; savePack(); renderModal(); setTimeout(() => { const t = $('#edQ'); if (t) t.focus(); }, 0); },
    edDup: () => { const q = edCurrent(); if (!q) return; const c = F.clone(q); c.id = F.uid(); c.question += ' (copy)'; const l = edList(); l.splice(l.indexOf(q) + 1, 0, c); editor.sel = c.id; savePack(); renderModal(); },
    edDelete: () => { const q = edCurrent(); if (!q || !confirm(`Delete “${q.question || 'Untitled'}”?`)) return; const l = edList(); l.splice(l.indexOf(q), 1); editor.sel = null; savePack(true); renderModal(); },
    edAddAns: () => { const q = edCurrent(); if (q.answers.length >= 10) return; q.answers.push({ text: '', points: 0 }); savePack(); renderModal(); setTimeout(() => { const t = $('#edA' + (q.answers.length - 1)); if (t) t.focus(); }, 0); },
    edDelAns: (d) => { const q = edCurrent(); q.answers.splice(F.toInt(d.k), 1); savePack(); renderModal(); },
    edMove: (d) => { const q = edCurrent(), k = F.toInt(d.k), j = k + F.toInt(d.d); if (j < 0 || j >= q.answers.length) return; [q.answers[k], q.answers[j]] = [q.answers[j], q.answers[k]]; savePack(); renderModal(); },
    edSort: () => { const q = edCurrent(); q.answers.sort((a, b) => b.points - a.points); savePack(); renderModal(); },
    edPlay: () => { const q = edCurrent(); savePack(true); F.syncOrder(game, pack); closeModal(); act('gotoQuestion', q.id); },
  };

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = clickHandlers[el.dataset.act];
    if (fn) { ev.preventDefault(); ev.stopPropagation(); F.Sound.unlock(); fn(el.dataset, ev); }
  });

  const changeHandlers = {
    renameTeam: (el) => act('renameTeam', F.toInt(el.dataset.t), el.value),
    gotoQuestion: (el) => act('gotoQuestion', el.value),
    setMultiplier: (el) => act('setMultiplier', Number(el.value)),
    setPhase: (el) => act('setPhase', el.value),
    showQuestion: (el) => setView({ showQuestion: el.checked }),
    preview: (el) => setView({ preview: el.checked }),
    fmHideP1: (el) => act('fmHideP1', el.checked),
    fmTarget: (el) => act('fmTarget', el.value),
    fmText: (el) => {
      const p = F.toInt(el.dataset.p), i = F.toInt(el.dataset.i);
      const e = game.fm.entries[p][i];
      const patch = { text: el.value.trim() };
      if (e.pick === -1 || e.pick === undefined) { const k = matchSurvey(game.fm.questions[i], patch.text); if (k >= 0) { patch.pick = k; patch.points = game.fm.questions[i].answers[k].points; } }
      act('fmSet', p, i, patch);
    },
    fmPick: (el) => {
      const p = F.toInt(el.dataset.p), i = F.toInt(el.dataset.i), k = F.toInt(el.value);
      const q = game.fm.questions[i], e = game.fm.entries[p][i];
      const patch = { pick: k, points: k >= 0 ? q.answers[k].points : 0 };
      if (k >= 0 && !e.text) patch.text = q.answers[k].text;
      act('fmSet', p, i, patch);
    },
    fmPts: (el) => act('fmSet', F.toInt(el.dataset.p), F.toInt(el.dataset.i), { points: F.toInt(el.value) }),
  };

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.dataset.change && changeHandlers[el.dataset.change]) { changeHandlers[el.dataset.change](el); return; }
    if (el.dataset.setting) {
      const key = el.dataset.setting, def = F.DEFAULT_SETTINGS[key];
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (typeof def === 'number') v = Number(v) || 0;
      if (key === 'maxStrikes') v = Math.max(1, Math.min(6, F.toInt(v)));
      settings[key] = v;
      saveSettings(); render(); publish();
      return;
    }
    if (el.dataset.ed) editorInput(el);
  });
  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.dataset.ed && el.tagName !== 'SELECT') editorInput(el);
    if (el.hasAttribute('data-ed-search')) { editor.search = el.value; renderModal(); }
    if (el.dataset.setting === 'volume') { settings.volume = Number(el.value); saveSettings(); }
  });

  // Enter in small number boxes triggers their button
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const id = ev.target.id || '';
    const map = { adj0: '[data-act=adjustBy][data-t="0"]', adj1: '[data-act=adjustBy][data-t="1"]', bankIn: '[data-act=setBank]', roundNoIn: '[data-act=setRoundNo]' };
    if (map[id]) { ev.preventDefault(); const b = $(map[id]); if (b) b.click(); }
    if (/^fm\d_\d_t$/.test(id) || id === 'teamName0' || id === 'teamName1') ev.target.blur();
  }, true);

  function handleKey(ev) {
    const tag = (ev.target && ev.target.tagName) || '';
    const typing = !ev.fromDisplay && (/INPUT|TEXTAREA|SELECT/.test(tag) || (ev.target && ev.target.isContentEditable));
    const key = ev.key || '';
    const mod = ev.ctrlKey || ev.metaKey;
    if (key === 'Escape') { if (modal) closeModal(); return; }
    if (mod && (key === 'z' || key === 'Z')) { if (typing) return; ev.preventDefault(); if (ev.shiftKey) doRedo(); else doUndo(); return; }
    if (mod && (key === 'y' || key === 'Y')) { if (typing) return; ev.preventDefault(); doRedo(); return; }
    if (typing || modal || mod || ev.altKey) return;
    const k = key.toLowerCase();
    if (k === '?') { openModal('help'); return; }
    if (k === 't') { timerToggle(); return; }
    if (k === 'd') { openDisplay(); return; }
    if (k === 'q') { setView({ showQuestion: !view.showQuestion }); return; }
    if (game.mode !== 'main') return;
    const code = ev.code || '';
    const digit = /^Digit(\d)$/.exec(code) ? +/^Digit(\d)$/.exec(code)[1] : (/^\d$/.test(key) ? +key : null);
    if (digit != null) { ev.preventDefault(); act('reveal', digit === 0 ? 9 : digit - 1, ev.shiftKey); return; }
    const r = game.round;
    if (k === 'x') act('strike');
    else if (k === 'a') act('revealAll');
    else if (k === 'n') act('nextRound');
    else if (key === '[' && r.phase === 'faceoff') act('faceoffWinner', 0);
    else if (key === ']' && r.phase === 'faceoff') act('faceoffWinner', 1);
    else if (k === 'p' && r.phase === 'decide') act('decide', ev.shiftKey ? 'pass' : 'play');
  }
  document.addEventListener('keydown', handleKey);

  window.addEventListener('storage', (e) => {
    if (e.key === K.settings) { settings = Object.assign({}, F.DEFAULT_SETTINGS, F.Store.get(K.settings, {})); render(); }
  });

  /* ================================================================ boot */
  F.Sound.setVolume(settings.volume);
  render();
  publish();
  window.FeudHost = { get game() { return game; }, get view() { return view; }, act, doUndo, doRedo, get pack() { return pack; }, get settings() { return settings; } };
})(window.Feud);
