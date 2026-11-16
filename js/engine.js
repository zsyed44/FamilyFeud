/* Feud engine: data model, rules, and pack handling.
 * Pure-ish functions that mutate a game object. The host wraps every action
 * with an undo snapshot, so nothing here needs to worry about reversibility. */
(function (F) {
  'use strict';

  const clone = (o) => JSON.parse(JSON.stringify(o));
  F.clone = clone;
  F.uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  const toInt = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };
  F.toInt = toInt;

  /* ------------------------------------------------------------ settings */
  F.DEFAULT_SETTINGS = {
    gameTitle: 'Family Feud',
    maxStrikes: 3,
    multipliers: '1, 1, 2, 3',       // multiplier for round 1, 2, 3...; last value repeats
    faceoffPointsToBank: true,       // face-off answers go into the bank
    stealAddsAnswerPoints: true,     // a successful steal answer adds its points to the bank
    autoAwardOnClear: true,          // clearing the board awards the bank automatically
    winningScore: 300,               // 0 = no target
    shuffleQuestions: false,
    suddenDeathMultiplier: 3,
    stealTimer: 0,                   // seconds; 0 = off. Starts automatically when steal begins
    faceoffTimer: 0,                 // seconds; 0 = off. Starts when a round loads
    sound: true,
    volume: 0.8,
    soundOutput: 'auto',             // auto | display | host | both
    fastMoneyTarget: 200,
    fastMoneyTime1: 20,
    fastMoneyTime2: 25,
    showQuestionOnLoad: true,
  };

  F.parseMultipliers = function (str) {
    const list = String(str == null ? '' : str).split(/[\s,;]+/).map(Number).filter((n) => n > 0);
    return list.length ? list : [1];
  };

  F.multiplierFor = function (settings, roundNo, q) {
    if (q && q.multiplier > 0) return q.multiplier;
    const list = F.parseMultipliers(settings.multipliers);
    return list[Math.min(roundNo - 1, list.length - 1)] || 1;
  };

  F.multLabel = (m) => ({ 1: '', 2: 'DOUBLE', 3: 'TRIPLE', 4: 'QUADRUPLE' }[m] ?? `×${m}`);

  /* ------------------------------------------------------------ packs */
  function normAnswer(a) {
    if (a == null) return null;
    if (Array.isArray(a)) return { text: String(a[0] ?? '').trim(), points: toInt(a[1]) };
    if (typeof a === 'string') {
      const m = a.match(/^(.*?)[\s|,:=-]+(\d+)\s*$/);
      return m ? { text: m[1].trim(), points: +m[2] } : { text: a.trim(), points: 0 };
    }
    if (typeof a === 'object') {
      return {
        text: String(a.text ?? a.answer ?? a.a ?? a.name ?? '').trim(),
        points: toInt(a.points ?? a.score ?? a.p ?? a.value ?? 0),
      };
    }
    return null;
  }

  function normQuestion(q) {
    if (!q || typeof q !== 'object') return null;
    const text = String(q.question ?? q.text ?? q.q ?? q.prompt ?? '').trim();
    const answers = (Array.isArray(q.answers) ? q.answers : []).map(normAnswer).filter((a) => a && a.text).slice(0, 10);
    if (!text && !answers.length) return null;
    const m = Number(q.multiplier);
    return { id: typeof q.id === 'string' && q.id ? q.id : F.uid(), question: text, answers, multiplier: m > 0 ? m : null };
  }

  F.normalizePack = function (raw) {
    if (typeof raw === 'string') raw = JSON.parse(raw);
    if (Array.isArray(raw)) raw = { questions: raw };
    if (!raw || typeof raw !== 'object') throw new Error('This file is not a question pack.');
    const qs = raw.questions ?? raw.rounds ?? raw.surveys ?? [];
    const fm = raw.fastMoney ?? raw.fast_money ?? raw.fastmoney ?? [];
    const pack = {
      title: String(raw.title ?? raw.name ?? 'Question Pack'),
      questions: (Array.isArray(qs) ? qs : []).map(normQuestion).filter(Boolean),
      fastMoney: (Array.isArray(fm) ? fm : []).map(normQuestion).filter(Boolean),
    };
    if (!pack.questions.length && !pack.fastMoney.length) throw new Error('No questions were found in this file.');
    const seen = new Set();
    [...pack.questions, ...pack.fastMoney].forEach((q) => { if (seen.has(q.id)) q.id = F.uid(); seen.add(q.id); });
    return pack;
  };

  F.exportPack = function (pack) {
    const out = (q) => {
      const o = { question: q.question, answers: q.answers.map((a) => ({ text: a.text, points: a.points })) };
      if (q.multiplier) o.multiplier = q.multiplier;
      return o;
    };
    return { title: pack.title, questions: pack.questions.map(out), fastMoney: pack.fastMoney.map(out) };
  };

  F.findQuestion = (pack, id) => pack.questions.find((q) => q.id === id) || null;

  /* ------------------------------------------------------------ rounds */
  F.makeRound = function (q, mult) {
    const answers = q ? q.answers.map((a) => ({ text: a.text, points: a.points })) : [];
    return {
      qid: q ? q.id : null,
      question: q ? q.question : '',
      answers,
      multiplier: mult || 1,
      phase: 'faceoff',          // faceoff | decide | play | steal | ended
      revealed: answers.map(() => false),
      scored: answers.map(() => 0), // raw (un-multiplied) points each answer put in the bank
      bankAdjust: 0,             // manual correction to the bank
      strikes: 0,
      faceoffMisses: 0,
      faceoffWinner: null,
      control: null,             // team playing the board
      stealTeam: null,
      result: null,              // { team, amount, how } once the bank is awarded / round closed
      suddenDeath: false,
    };
  };

  F.bankRaw = (r) => r.scored.reduce((a, b) => a + b, 0);
  F.bank = (r) => Math.max(0, F.bankRaw(r) * r.multiplier + r.bankAdjust);
  F.bankShown = (r) => (r.result ? 0 : F.bank(r));
  F.slotsFor = (n) => (n <= 4 ? 4 : n <= 6 ? 6 : n <= 8 ? 8 : 10);
  F.other = (t) => (t === 0 ? 1 : 0);

  /* ------------------------------------------------------------ game */
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  F.newGame = function (pack, settings, opts) {
    opts = opts || {};
    const order = pack.questions.map((q) => q.id);
    if (opts.shuffle) shuffle(order);
    const g = {
      v: 1,
      id: F.uid(),
      started: Date.now(),
      teams: [
        { name: opts.team1 || 'Team 1', score: 0 },
        { name: opts.team2 || 'Team 2', score: 0 },
      ],
      order,
      pos: 0,
      roundNo: 1,
      played: [],
      round: null,
      winner: null,
      mode: 'main',
      fm: F.makeFastMoney(pack, settings),
      log: [],
    };
    const q = F.findQuestion(pack, order[0]);
    g.round = F.makeRound(q, F.multiplierFor(settings, 1, q));
    return g;
  };

  F.syncOrder = function (g, pack) {
    const ids = new Set(pack.questions.map((q) => q.id));
    const curId = g.order[g.pos];
    g.order = g.order.filter((id) => ids.has(id));
    pack.questions.forEach((q) => { if (!g.order.includes(q.id)) g.order.push(q.id); });
    const idx = g.order.indexOf(curId);
    g.pos = idx >= 0 ? idx : Math.min(g.pos, Math.max(0, g.order.length - 1));
  };

  /* ------------------------------------------------------------ fast money */
  const blankEntry = () => ({ text: '', points: 0, pick: -1, showText: false, showPts: false });

  F.makeFastMoney = function (pack, settings, fromMain) {
    let src = (pack.fastMoney || []).slice(0, 5);
    if (src.length < 5 || fromMain) {
      const extra = pack.questions.slice().reverse();
      src = fromMain ? extra.slice(0, 5) : src.concat(extra).slice(0, 5);
    }
    const questions = src.map((q) => ({ qid: q.id, question: q.question, answers: q.answers.map((a) => ({ text: a.text, points: a.points })) }));
    return {
      questions,
      entries: [questions.map(blankEntry), questions.map(blankEntry)],
      hideP1: false,
      player: 0,
      target: settings ? settings.fastMoneyTarget : 200,
      won: false,
    };
  };

  F.fmTotal = (fm) => fm.entries.flat().reduce((s, e) => s + (e.showPts ? toInt(e.points) : 0), 0);
  F.fmPotential = (fm) => fm.entries.flat().reduce((s, e) => s + toInt(e.points), 0);

  /* ------------------------------------------------------------ actions
   * Each action receives (g, ctx, ...args). ctx = { pack, settings, fx(name,data), log(msg), toast(msg), timer(sec) }.
   * Returning false means "nothing changed" (no undo entry is recorded). */
  const A = {};
  const tn = (g, t) => (t === 0 || t === 1 ? g.teams[t].name : 'nobody');

  function award(g, ctx, team, how) {
    const r = g.round;
    if (r.result && r.result.team != null) {
      g.teams[r.result.team].score -= r.result.amount;
      ctx.log(`Correction: removed ${r.result.amount} from ${tn(g, r.result.team)}`);
    }
    const amount = F.bank(r);
    g.teams[team].score += amount;
    r.result = { team, amount, how };
    r.phase = 'ended';
    if (r.qid && !g.played.includes(r.qid)) g.played.push(r.qid);
    ctx.fx('award', { team, amount, how });
    const why = { cleared: 'cleared the board', steal: 'stole', 'steal-failed': 'kept the bank (steal failed)', 'sudden-death': 'won sudden death', manual: 'awarded by host' }[how] || how;
    ctx.log(`${tn(g, team)} ${why}: +${amount}`);
    checkWinner(g, ctx);
  }

  function checkWinner(g, ctx) {
    const target = toInt(ctx.settings.winningScore);
    if (!target || g.winner != null) return;
    const reached = g.teams.map((t, i) => (t.score >= target ? i : -1)).filter((i) => i >= 0);
    if (!reached.length) return;
    const w = reached.length === 2 ? (g.teams[0].score >= g.teams[1].score ? 0 : 1) : reached[0];
    g.winner = w;
    ctx.fx('win', { team: w });
    ctx.log(`${tn(g, w)} reached ${target} points!`);
    ctx.toast(`${tn(g, w)} reached ${target} — show the winner screen or go to Fast Money.`);
  }

  function beginSteal(g, ctx) {
    const r = g.round;
    r.phase = 'steal';
    r.stealTeam = F.other(r.control ?? 0);
    ctx.fx('steal', { team: r.stealTeam });
    ctx.log(`${r.strikes} strikes — ${tn(g, r.stealTeam)} can steal`);
    if (toInt(ctx.settings.stealTimer) > 0) ctx.timer(toInt(ctx.settings.stealTimer));
  }

  A.reveal = function (g, ctx, i, noPoints) {
    const r = g.round;
    if (!r || i < 0 || i >= r.answers.length || r.revealed[i]) return false;
    r.revealed[i] = true;
    const a = r.answers[i];
    let scores = !noPoints;
    if (r.phase === 'ended') scores = false;
    if ((r.phase === 'faceoff' || r.phase === 'decide') && !ctx.settings.faceoffPointsToBank) scores = false;
    if (r.phase === 'steal' && !ctx.settings.stealAddsAnswerPoints) scores = false;
    r.scored[i] = scores ? a.points : 0;
    ctx.fx('reveal', { i });
    ctx.log(`Revealed #${i + 1} "${a.text}" (${a.points})${scores ? '' : ' — no points'}`);

    if (r.phase === 'steal') {
      award(g, ctx, r.stealTeam, 'steal');
    } else if (r.phase === 'play' && r.revealed.every(Boolean) && ctx.settings.autoAwardOnClear && r.control != null) {
      award(g, ctx, r.control, 'cleared');
    }
  };

  A.hide = function (g, ctx, i) {
    const r = g.round;
    if (!r.revealed[i]) return false;
    r.revealed[i] = false;
    if (!r.result) r.scored[i] = 0;
    ctx.log(`Hid answer #${i + 1}${r.result ? ' (bank already awarded — use Award to correct scores)' : ''}`);
  };

  A.revealAll = function (g, ctx) {
    const r = g.round;
    if (r.revealed.every(Boolean)) return false;
    r.revealed = r.revealed.map(() => true);
    ctx.fx('revealAll', {});
    ctx.log('Revealed all remaining answers (no points)');
  };

  A.strike = function (g, ctx) {
    const r = g.round;
    const max = Math.max(1, toInt(ctx.settings.maxStrikes));
    if (r.phase === 'faceoff' || r.phase === 'decide') {
      r.faceoffMisses++;
      ctx.fx('strike', { count: 1 });
      ctx.log('Face-off: wrong answer');
    } else if (r.phase === 'play') {
      r.strikes = Math.min(max, r.strikes + 1);
      ctx.fx('strike', { count: r.strikes });
      ctx.log(`Strike ${r.strikes} on ${tn(g, r.control)}`);
      if (r.strikes >= max) beginSteal(g, ctx);
    } else if (r.phase === 'steal') {
      ctx.fx('strike', { count: 1 });
      award(g, ctx, r.control, 'steal-failed');
    } else {
      ctx.fx('strike', { count: 1 });
      return false;
    }
  };

  A.faceoffWinner = function (g, ctx, team) {
    const r = g.round;
    r.faceoffWinner = team;
    if (r.suddenDeath) { award(g, ctx, team, 'sudden-death'); return; }
    r.phase = 'decide';
    ctx.log(`${tn(g, team)} won the face-off`);
  };

  A.decide = function (g, ctx, choice) {
    const r = g.round;
    const w = r.faceoffWinner ?? 0;
    r.control = choice === 'pass' ? F.other(w) : w;
    r.phase = 'play';
    r.strikes = 0;
    ctx.fx('control', { team: r.control });
    ctx.log(`${tn(g, w)} chose to ${choice === 'pass' ? 'PASS' : 'PLAY'} — ${tn(g, r.control)} plays the board`);
  };

  A.setControl = function (g, ctx, team) {
    const r = g.round;
    r.control = team;
    if (team != null && (r.phase === 'faceoff' || r.phase === 'decide')) r.phase = 'play';
    if (r.phase === 'steal') r.stealTeam = F.other(team ?? 0);
    if (team != null) ctx.fx('control', { team });
    ctx.log(`Control set to ${tn(g, team)}`);
  };

  A.setPhase = function (g, ctx, phase) {
    const r = g.round;
    if (r.phase === phase) return false;
    if (phase !== 'ended' && r.result) {
      if (r.result.team != null) g.teams[r.result.team].score -= r.result.amount;
      ctx.log(`Round re-opened: removed ${r.result.amount || 0} from ${tn(g, r.result.team)}`);
      r.result = null;
    }
    if ((phase === 'play' || phase === 'steal') && r.control == null) r.control = r.faceoffWinner ?? 0;
    if (phase === 'decide' && r.faceoffWinner == null) r.faceoffWinner = r.control ?? 0;
    if (phase === 'steal') r.stealTeam = F.other(r.control);
    if (phase === 'ended' && !r.result) r.result = { team: null, amount: 0, how: 'none' };
    r.phase = phase;
    ctx.log(`Phase set to ${phase}`);
  };

  A.setStrikes = function (g, ctx, n) {
    const r = g.round;
    const max = Math.max(1, toInt(ctx.settings.maxStrikes));
    n = Math.max(0, Math.min(max, toInt(n)));
    if (n === r.strikes) return false;
    r.strikes = n;
    ctx.log(`Strikes set to ${n}`);
    if (r.phase === 'steal' && n < max) { r.phase = 'play'; r.stealTeam = null; }
    else if (r.phase === 'play' && n >= max) beginSteal(g, ctx);
  };

  A.award = function (g, ctx, team) { award(g, ctx, team, 'manual'); };

  A.endNoAward = function (g, ctx) {
    const r = g.round;
    if (r.result && r.result.team != null) {
      g.teams[r.result.team].score -= r.result.amount;
      ctx.log(`Removed ${r.result.amount} from ${tn(g, r.result.team)}`);
    }
    r.result = { team: null, amount: 0, how: 'none' };
    r.phase = 'ended';
    if (r.qid && !g.played.includes(r.qid)) g.played.push(r.qid);
    ctx.log('Round ended with no points awarded');
  };

  A.setBank = function (g, ctx, v) {
    const r = g.round;
    v = Math.max(0, toInt(v));
    r.bankAdjust = v - F.bankRaw(r) * r.multiplier;
    ctx.log(`Bank set to ${v}`);
  };

  A.setMultiplier = function (g, ctx, m) {
    const r = g.round;
    m = Number(m) > 0 ? Number(m) : 1;
    if (r.multiplier === m) return false;
    r.multiplier = m;
    ctx.log(`Multiplier set to ×${m}`);
  };

  A.setSuddenDeath = function (g, ctx, on) {
    const r = g.round;
    r.suddenDeath = !!on;
    if (on) r.multiplier = Number(ctx.settings.suddenDeathMultiplier) || r.multiplier;
    ctx.log(on ? 'Sudden death ON — face-off winner takes the bank' : 'Sudden death OFF');
  };

  A.restartRound = function (g, ctx) {
    const r = g.round;
    if (r.result && r.result.team != null) g.teams[r.result.team].score -= r.result.amount;
    const q = { id: r.qid, question: r.question, answers: r.answers };
    const nr = F.makeRound(q, r.multiplier);
    nr.suddenDeath = r.suddenDeath;
    g.round = nr;
    g.played = g.played.filter((id) => id !== r.qid);
    ctx.log('Round restarted');
  };

  function loadPos(g, ctx, pos, roundNo) {
    const unawarded = g.round && !g.round.result ? F.bank(g.round) : 0;
    g.pos = pos;
    g.roundNo = Math.max(1, roundNo);
    const q = F.findQuestion(ctx.pack, g.order[pos]);
    g.round = F.makeRound(q, F.multiplierFor(ctx.settings, g.roundNo, q));
    ctx.fx('newRound', {});
    ctx.log(`— Round ${g.roundNo}: ${q ? q.question : '(no question)'}`);
    if (unawarded > 0) ctx.toast(`Note: the previous bank of ${unawarded} was not awarded. Press Undo to go back.`);
    if (toInt(ctx.settings.faceoffTimer) > 0) ctx.timer(toInt(ctx.settings.faceoffTimer));
  }

  A.nextRound = function (g, ctx) {
    F.syncOrder(g, ctx.pack);
    if (g.pos + 1 >= g.order.length) { ctx.toast('No more questions in the pack. Add more in Questions, or pick one from the list.'); return false; }
    loadPos(g, ctx, g.pos + 1, g.roundNo + 1);
  };

  A.prevRound = function (g, ctx) {
    F.syncOrder(g, ctx.pack);
    if (g.pos <= 0) return false;
    loadPos(g, ctx, g.pos - 1, g.roundNo - 1);
  };

  A.gotoQuestion = function (g, ctx, qid) {
    F.syncOrder(g, ctx.pack);
    const idx = g.order.indexOf(qid);
    if (idx < 0) return false;
    // A finished round means this is the next round; otherwise we're swapping the current question.
    const finished = !!(g.round && g.round.result);
    const nextNo = finished ? g.roundNo + 1 : g.roundNo;
    if (idx !== g.pos) {
      const curId = g.order[g.pos];
      g.order.splice(idx, 1);
      const p = g.order.indexOf(curId);
      g.order.splice(finished ? p + 1 : p, 0, qid);
    }
    loadPos(g, ctx, g.order.indexOf(qid), nextNo);
  };

  A.randomQuestion = function (g, ctx) {
    F.syncOrder(g, ctx.pack);
    const pool = ctx.pack.questions.filter((q) => !g.played.includes(q.id) && q.id !== g.round.qid);
    if (!pool.length) { ctx.toast('Every question has been played.'); return false; }
    A.gotoQuestion(g, ctx, pool[Math.floor(Math.random() * pool.length)].id);
  };

  A.refreshRound = function (g, ctx) {
    const r = g.round;
    const q = F.findQuestion(ctx.pack, r.qid);
    if (!q) { ctx.toast('That question no longer exists in the pack.'); return false; }
    r.question = q.question;
    const old = r.answers;
    r.answers = q.answers.map((a) => ({ text: a.text, points: a.points }));
    r.revealed = r.answers.map((_, i) => (i < old.length ? r.revealed[i] : false));
    r.scored = r.answers.map((a, i) => (i < old.length && r.scored[i] ? a.points : 0));
    ctx.log('Live board updated from edited question');
  };

  A.setRoundNo = function (g, ctx, n) { n = Math.max(1, toInt(n)); if (n === g.roundNo) return false; g.roundNo = n; ctx.log(`Round number set to ${n}`); };

  A.adjustScore = function (g, ctx, team, delta) {
    delta = toInt(delta); if (!delta) return false;
    g.teams[team].score += delta;
    ctx.fx('score', { team });
    ctx.log(`${tn(g, team)} ${delta > 0 ? '+' : ''}${delta} (manual)`);
    checkWinner(g, ctx);
  };
  A.setScore = function (g, ctx, team, v) {
    v = toInt(v); if (g.teams[team].score === v) return false;
    g.teams[team].score = v;
    ctx.log(`${tn(g, team)} score set to ${v}`);
    checkWinner(g, ctx);
  };
  A.renameTeam = function (g, ctx, team, name) {
    name = String(name || '').trim().slice(0, 40) || `Team ${team + 1}`;
    if (g.teams[team].name === name) return false;
    g.teams[team].name = name;
  };
  A.clearWinner = function (g) { if (g.winner == null) return false; g.winner = null; };
  A.setWinner = function (g, ctx, t) { g.winner = t; ctx.fx('win', { team: t }); };

  A.setMode = function (g, ctx, mode) { if (g.mode === mode) return false; g.mode = mode; ctx.log(mode === 'fastmoney' ? '— Fast Money' : '— Main game'); };

  /* fast money actions */
  A.fmSet = function (g, ctx, p, i, patch) {
    const e = g.fm.entries[p][i];
    let changed = false;
    for (const k in patch) if (e[k] !== patch[k]) { e[k] = patch[k]; changed = true; }
    if (!changed) return false;
  };
  A.fmReveal = function (g, ctx, p, i) {
    const e = g.fm.entries[p][i];
    if (e.showText && e.showPts) return false;
    e.showText = true; e.showPts = true;
    ctx.fx('fmReveal', { p, i, points: toInt(e.points) });
    ctx.log(`Fast Money P${p + 1} Q${i + 1}: "${e.text || '—'}" = ${toInt(e.points)}`);
    fmCheckWin(g, ctx);
  };
  A.fmHide = function (g, ctx, p, i) {
    const e = g.fm.entries[p][i];
    if (!e.showText && !e.showPts) return false;
    e.showText = false; e.showPts = false;
  };
  A.fmRevealAll = function (g, ctx, p) {
    let any = false;
    g.fm.entries[p].forEach((e, i) => { if (!(e.showText && e.showPts) && (e.text || e.points)) { e.showText = e.showPts = true; any = true; } });
    if (!any) return false;
    ctx.fx('fmRevealAll', { p });
    ctx.log(`Fast Money: revealed player ${p + 1}`);
    fmCheckWin(g, ctx);
  };
  A.fmHideP1 = function (g, ctx, on) { g.fm.hideP1 = !!on; };
  A.fmPlayer = function (g, ctx, p) { if (g.fm.player === p) return false; g.fm.player = p; if (p === 1) g.fm.hideP1 = true; ctx.log(`Fast Money: player ${p + 1}`); };
  A.fmReset = function (g, ctx, fromMain) { g.fm = F.makeFastMoney(ctx.pack, ctx.settings, fromMain); ctx.log('Fast Money reset'); };
  A.fmTarget = function (g, ctx, v) { g.fm.target = Math.max(0, toInt(v)); };
  function fmCheckWin(g, ctx) {
    if (!g.fm.won && g.fm.target > 0 && F.fmTotal(g.fm) >= g.fm.target) {
      g.fm.won = true;
      ctx.fx('win', { fm: true });
      ctx.log(`Fast Money total reached ${g.fm.target}!`);
    }
  }

  F.actions = A;

  /* ------------------------------------------------------------ public view
   * Everything the audience display needs, with unrevealed answers removed. */
  F.publicState = function (g, settings, view, rev) {
    const r = g.round;
    const pub = {
      rev,
      title: settings.gameTitle,
      maxStrikes: Math.max(1, toInt(settings.maxStrikes)),
      teams: g.teams.map((t) => ({ name: t.name, score: t.score })),
      roundNo: g.roundNo,
      mode: g.mode,
      winner: g.winner,
      view,
      round: r && {
        key: `${g.roundNo}:${r.qid}`,
        question: r.question,
        n: r.answers.length,
        answers: r.answers.map((a, i) => (r.revealed[i] ? { text: a.text, points: a.points } : null)),
        multiplier: r.multiplier,
        phase: r.phase,
        strikes: r.strikes,
        control: r.control,
        stealTeam: r.stealTeam,
        bank: F.bankShown(r),
        result: r.result,
        suddenDeath: r.suddenDeath,
      },
    };
    if (g.mode === 'fastmoney' && g.fm) {
      const fm = g.fm;
      pub.fm = {
        target: fm.target,
        hideP1: fm.hideP1,
        player: fm.player,
        total: F.fmTotal(fm),
        won: fm.won,
        rows: fm.questions.length,
        entries: fm.entries.map((col, p) => col.map((e) => {
          const hidden = p === 0 && fm.hideP1;
          return { text: !hidden && e.showText ? e.text : null, points: !hidden && e.showPts ? toInt(e.points) : null };
        })),
      };
    }
    return pub;
  };
})(window.Feud = window.Feud || {});
