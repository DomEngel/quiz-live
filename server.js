'use strict';
/*
  Quiz en direct (type Kahoot) — un seul fichier, aucune dépendance.
  Lancer :  node server.js      (puis ouvrir http://localhost:3000/host)
  Variable d'environnement conseillée : HOST_PASSWORD (mot de passe animateur, "quiz" par défaut)
*/
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'quiz';
const MAX_GAMES = 20, MAX_PLAYERS = 300;
const games = new Map();
const rid = n => crypto.randomBytes(n).toString('hex');

/* ------------------------------ jeu ------------------------------ */
function newCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (games.has(c));
  return c;
}
function cleanQuestions(qs) {
  if (!Array.isArray(qs)) return null;
  const out = [];
  for (const x of qs.slice(0, 60)) {
    if (!x || typeof x.q !== 'string' || !Array.isArray(x.o) || !x.q.trim()) continue;
    const o = x.o.slice(0, 4).map(s => String(s).trim().slice(0, 100));
    const c = Number(x.c);
    if (o.length < 2 || !(c >= 0 && c < o.length)) continue;
    out.push({ q: x.q.trim().slice(0, 250), o, c });
  }
  return out.length ? out : null;
}
function sortedPlayers(g) {
  return [...g.players.values()].sort((a, b) => b.score - a.score);
}
function stateFor(g, cl) {
  const ps = [...g.players.values()];
  const s = { code: g.code, phase: g.phase, q: g.q, total: g.questions.length, n: ps.length };
  const Q = g.questions[g.q];
  if (g.phase === 'lobby' && cl.role === 'host') s.names = ps.map(p => p.name);
  if (Q && (g.phase === 'question' || g.phase === 'reveal')) s.question = { q: Q.q, o: Q.o };
  if (g.phase === 'question') {
    s.rem = Math.max(0, g.startedAt + g.dur - Date.now());
    s.dur = g.dur;
    s.answered = ps.filter(p => p.ans != null).length;
  }
  if (g.phase === 'reveal') {
    s.correct = Q.c;
    s.counts = Q.o.map((_, i) => ps.filter(p => p.ans === i).length);
  }
  if (g.phase === 'reveal' || g.phase === 'end') {
    s.board = sortedPlayers(g).slice(0, 10).map(p => [p.name, p.score, p.gain]);
  }
  if (cl.role === 'player') {
    const p = g.players.get(cl.id);
    if (p) s.me = { name: p.name, score: p.score, gain: p.gain, ans: p.ans, rank: sortedPlayers(g).indexOf(p) + 1 };
  }
  return s;
}
function push(cl, g) {
  try { cl.res.write('event: state\ndata: ' + JSON.stringify(stateFor(g, cl)) + '\n\n'); } catch (e) {}
}
function broadcast(g) { for (const cl of g.clients) push(cl, g); }

function beginQuestion(g) {
  for (const p of g.players.values()) { p.ans = null; p.gain = 0; }
  g.startedAt = Date.now();
  g.phase = 'question';
  broadcast(g);
}
function reveal(g) {
  if (g.phase !== 'question') return;
  const Q = g.questions[g.q];
  for (const p of g.players.values()) {
    p.gain = 0;
    if (p.ans === Q.c) {
      const t = Math.min(Math.max(0, p.ansT - g.startedAt), g.dur);
      p.gain = Math.round(500 + 500 * (1 - t / g.dur));
      p.score += p.gain;
    }
  }
  g.phase = 'reveal';
  broadcast(g);
}
function hostAction(g, action) {
  if (action === 'start' && g.phase === 'lobby' && g.players.size) { g.q = 0; beginQuestion(g); }
  else if (action === 'reveal') reveal(g);
  else if (action === 'next' && g.phase === 'reveal') {
    if (g.q >= g.questions.length - 1) { g.phase = 'end'; broadcast(g); }
    else { g.q++; beginQuestion(g); }
  } else if (action === 'restart') {
    g.q = -1; g.phase = 'lobby';
    for (const p of g.players.values()) { p.score = 0; p.gain = 0; p.ans = null; }
    broadcast(g);
  }
}
function tick() {
  const now = Date.now();
  for (const [code, g] of games) {
    if (g.phase === 'question') {
      const n = g.players.size;
      const all = n > 0 && [...g.players.values()].every(p => p.ans != null);
      if (now >= g.startedAt + g.dur || all) reveal(g);
    }
    if (now - g.last > 15000 && g.clients.size) { broadcast(g); g.last = now; } // keep-alive
    if (!g.clients.size && now - g.last > 4 * 3600 * 1000) games.delete(code);
  }
}
setInterval(tick, 500);

/* ------------------------------ HTTP ------------------------------ */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 200000) { reject(new Error('trop gros')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
const fail = (res, code, error) => json(res, code, { error });

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const g = games.get(url.searchParams.get('code'));
    const token = url.searchParams.get('token'), id = url.searchParams.get('id');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    const isHost = g && token && token === g.token;
    const isPlayer = g && id && g.players.has(id);
    if (!isHost && !isPlayer) { res.write('event: gone\ndata: {}\n\n'); res.end(); return; }
    const cl = { res, role: isHost ? 'host' : 'player', id };
    g.clients.add(cl);
    g.last = Date.now();
    res.write('retry: 2000\n\n');
    push(cl, g);
    if (cl.role === 'host') broadcast(g); // met à jour le nombre de joueurs
    req.on('close', () => g.clients.delete(cl));
    return;
  }
  if (req.method !== 'POST') return fail(res, 405, 'Méthode non autorisée');
  let b;
  try { b = await readBody(req); } catch (e) { return fail(res, 400, 'Requête invalide'); }

  if (url.pathname === '/api/create') {
    if (String(b.password || '') !== HOST_PASSWORD) {
      await new Promise(r => setTimeout(r, 600));
      return fail(res, 403, 'Mot de passe incorrect');
    }
    const questions = cleanQuestions(b.questions);
    if (!questions) return fail(res, 400, 'Aucune question valide');
    if (games.size >= MAX_GAMES) return fail(res, 503, 'Trop de parties en cours');
    const dur = Math.min(120, Math.max(5, Number(b.dur) || 20)) * 1000;
    const g = { code: newCode(), token: rid(16), questions, dur, phase: 'lobby', q: -1,
      startedAt: 0, players: new Map(), clients: new Set(), last: Date.now() };
    games.set(g.code, g);
    return json(res, 200, { code: g.code, token: g.token });
  }
  const g = games.get(String(b.code || ''));
  if (!g) return fail(res, 404, 'Partie introuvable');
  g.last = Date.now();

  if (url.pathname === '/api/join') {
    const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!name) return fail(res, 400, 'Pseudo manquant');
    if (g.phase !== 'lobby') return fail(res, 409, 'La partie a déjà commencé');
    if (g.players.size >= MAX_PLAYERS) return fail(res, 503, 'Partie complète');
    for (const p of g.players.values()) if (p.name.toLowerCase() === name.toLowerCase()) return fail(res, 409, 'Pseudo déjà pris');
    const id = rid(8);
    g.players.set(id, { id, name, score: 0, gain: 0, ans: null, ansT: 0 });
    broadcast(g);
    return json(res, 200, { id, name });
  }
  if (url.pathname === '/api/answer') {
    const p = g.players.get(String(b.id || ''));
    const c = Number(b.c);
    if (!p || g.phase !== 'question' || p.ans != null) return json(res, 200, { ok: false });
    if (!Number.isInteger(c) || c < 0 || c >= g.questions[g.q].o.length) return fail(res, 400, 'Réponse invalide');
    p.ans = c; p.ansT = Date.now();
    broadcast(g);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/host') {
    if (String(b.token || '') !== g.token) return fail(res, 403, 'Non autorisé');
    hostAction(g, String(b.action || ''));
    return json(res, 200, { ok: true });
  }
  return fail(res, 404, 'Inconnu');
}

/* ------------------------------ page (client) ------------------------------ */
const DEFAULT_QUIZ = [
  { q: "Quelle est la capitale de l'Australie ?", o: ['Sydney', 'Melbourne', 'Canberra', 'Perth'], c: 2 },
  { q: 'Combien de côtés a un hexagone ?', o: ['5', '7', '8', '6'], c: 3 },
  { q: 'Qui a peint La Joconde ?', o: ['Léonard de Vinci', 'Michel-Ange', 'Raphaël', 'Botticelli'], c: 0 },
  { q: 'Quelle planète est la plus proche du Soleil ?', o: ['Vénus', 'Mars', 'Terre', 'Mercure'], c: 3 },
  { q: 'Quel est le plus grand océan du monde ?', o: ['Atlantique', 'Pacifique', 'Indien', 'Arctique'], c: 1 },
  { q: 'En quelle année a eu lieu la prise de la Bastille ?', o: ['1689', '1715', '1789', '1804'], c: 2 },
  { q: 'Quelle langue compte le plus de locuteurs natifs ?', o: ['Anglais', 'Espagnol', 'Hindi', 'Mandarin'], c: 3 },
  { q: "Quel est le symbole chimique de l'or ?", o: ['Ag', 'Au', 'Or', 'Fe'], c: 1 }
];

const CSS = `
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#2d1b69;color:#fff;min-height:100vh}
#app{max-width:720px;margin:0 auto;padding:20px 16px 40px;min-height:100vh;display:flex;flex-direction:column;gap:16px}
h1{font-size:28px;line-height:1.15}h2{font-size:22px;line-height:1.25}
.muted{opacity:.75;font-size:15px}.center{text-align:center}.big{font-size:56px;font-weight:800}
.card{background:rgba(255,255,255,.12);border-radius:16px;padding:16px}
input,textarea{width:100%;font-size:18px;padding:14px;border-radius:12px;border:0;font-family:inherit}
input.c{text-align:center;font-size:20px}textarea{min-height:260px;font-size:15px;line-height:1.4}
label{display:block;font-size:14px;opacity:.8;margin:0 0 6px}
.btn{display:block;width:100%;border:0;border-radius:14px;padding:16px;font-size:18px;font-weight:700;color:#2d1b69;background:#fff;cursor:pointer}
.btn:disabled{opacity:.5}.btn.sec{background:rgba(255,255,255,.2);color:#fff}
.err{background:#c0392b;border-radius:12px;padding:12px;text-align:center}
.opts{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.opt{border:0;border-radius:14px;padding:18px 10px;min-height:96px;font-size:18px;font-weight:700;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;text-align:center;font-family:inherit}
.opt .sh{font-size:26px}.o0{background:#e21b3c}.o1{background:#1368ce}.o2{background:#d89e00}.o3{background:#26890c}
.opt.dim{opacity:.3}.opt.good{outline:4px solid #fff}.opt .cnt{font-size:14px;font-weight:600}
.tbar{height:10px;border-radius:6px;background:rgba(255,255,255,.2);overflow:hidden}
.tbar>div{height:100%;background:#fff;width:100%;transition:width .2s linear}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{background:rgba(255,255,255,.18);border-radius:20px;padding:6px 14px;font-size:16px}
.row{display:flex;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.12);margin-bottom:6px;font-size:17px}
.row.me{background:#fff;color:#2d1b69;font-weight:700}.row span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ok{background:#26890c}.ko{background:#c0392b}.nr{background:rgba(255,255,255,.2)}
.verdict{border-radius:16px;padding:22px;text-align:center;font-size:26px;font-weight:800}
.qtext{font-size:24px;font-weight:800;line-height:1.25}.spacer{flex:1}
.qr{background:#fff;padding:12px;border-radius:12px;display:inline-block}
.code{font-size:52px;font-weight:800;letter-spacing:6px}
`;

function client(DEFAULT_QUIZ) {
  const SH = ['▲', '◆', '●', '■'];
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = $('#app');
  const isHostPage = location.pathname.replace(/\/+$/, '') === '/host';
  const KEY = isHostPage ? 'qz_host' : 'qz_player';
  let S = null, es = null, deadline = 0, err = '';
  let sess = null;
  try { sess = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
  const save = v => { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch (e) {} };

  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Erreur');
    return j;
  }
  function connect() {
    if (es) es.close();
    const u = '/api/events?code=' + encodeURIComponent(sess.code) + (isHostPage ? '&token=' + sess.token : '&id=' + sess.id);
    es = new EventSource(u);
    es.addEventListener('state', e => { S = JSON.parse(e.data); deadline = Date.now() + (S.rem || 0); render(); });
    es.addEventListener('gone', () => { es.close(); save(null); sess = null; S = null; err = 'Partie terminée ou introuvable.'; render(); });
  }
  const act = a => post('/api/host', { code: sess.code, token: sess.token, action: a }).catch(() => {});
  const ord = r => r + (r === 1 ? 'er' : 'e');

  function parseQuiz(t) {
    return t.split(/\n\s*\n/).map(b => b.split('\n').map(l => l.trim()).filter(Boolean)).filter(l => l.length >= 3).map(l => {
      let c = -1; const o = [];
      l.slice(1).forEach(x => { if (x[0] === '*') { c = o.length; x = x.slice(1).trim(); } o.push(x); });
      return { q: l[0], o, c };
    }).filter(x => x.c >= 0 && x.o.length <= 4);
  }
  const quizText = () => DEFAULT_QUIZ.map(x => x.q + '\n' + x.o.map((o, i) => (i === x.c ? '*' : '') + o).join('\n')).join('\n\n');

  const errHTML = () => err ? '<div class="err">' + esc(err) + '</div>' : '';
  function opts(Q, o) {
    o = o || {};
    return '<div class="opts">' + Q.o.map((t, i) => {
      const cls = ['opt', 'o' + i];
      if (o.reveal) cls.push(i === o.correct ? 'good' : 'dim');
      else if (o.picked != null && o.picked !== i) cls.push('dim');
      const tag = o.click ? 'button' : 'div';
      return '<' + tag + ' class="' + cls.join(' ') + '"' + (o.click ? ' data-c="' + i + '"' : '') + '><span class="sh">' + SH[i] + '</span><span>' + esc(t) + '</span>' +
        (o.counts ? '<span class="cnt">' + o.counts[i] + ' réponse' + (o.counts[i] > 1 ? 's' : '') + '</span>' : '') + '</' + tag + '>';
    }).join('') + '</div>';
  }
  const timerHTML = () => '<div><div class="tbar"><div id="bar"></div></div><div class="center muted" style="margin-top:6px" id="sec"></div></div>';
  const board = (b, n, me) => b.slice(0, n).map((r, i) =>
    '<div class="row ' + (r[0] === me ? 'me' : '') + '"><span>' + (i + 1) + '. ' + esc(r[0]) + '</span><span>' + r[1] + (r[2] ? ' (+' + r[2] + ')' : '') + '</span></div>').join('');
  const set = (html, bind) => { app.innerHTML = html; if (bind) bind(); };

  /* ---------- animateur ---------- */
  function renderHost() {
    if (!sess) {
      let pw = ''; try { pw = sessionStorage.getItem('qz_pw') || ''; } catch (e) {}
      return set('<h1>🎮 Nouvelle partie</h1>' + errHTML() +
        '<div><label>Mot de passe animateur</label><input id="pw" type="password" value="' + esc(pw) + '"></div>' +
        '<div><label>Durée par question (secondes)</label><input id="du" type="number" min="5" max="120" value="20"></div>' +
        '<div><label>Questions — séparées par une ligne vide ; la bonne réponse commence par * ; 2 à 4 réponses</label><textarea id="qs"></textarea></div>' +
        '<button class="btn" id="cr">Créer la partie</button>',
        () => {
          $('#qs').value = quizText();
          $('#cr').onclick = async () => {
            const questions = parseQuiz($('#qs').value);
            if (!questions.length) { err = 'Aucune question valide (vérifie le *).'; return renderHost(); }
            try {
              const password = $('#pw').value;
              try { sessionStorage.setItem('qz_pw', password); } catch (e) {}
              const r = await post('/api/create', { password, questions, dur: +$('#du').value });
              sess = { code: r.code, token: r.token }; save(sess); err = ''; connect(); render();
            } catch (e) { err = e.message; const v = $('#qs').value, d = $('#du').value; renderHost(); $('#qs').value = v; $('#du').value = d; }
          };
        });
    }
    if (!S) return set('<div class="card center">Connexion…</div>');
    const Q = S.question;
    if (S.phase === 'lobby') {
      const url = location.origin + '/?c=' + S.code;
      return set('<div class="center"><div class="muted">Rejoins sur ton téléphone</div><div class="code">' + esc(S.code) + '</div><div class="qr" id="qr"></div><div class="muted" style="margin-top:8px;word-break:break-all">' + esc(url) + '</div></div>' +
        '<div class="card"><b>' + S.n + ' joueur' + (S.n > 1 ? 's' : '') + '</b><div class="chips" style="margin-top:10px">' +
        ((S.names || []).map(n => '<span class="chip">' + esc(n) + '</span>').join('') || '<span class="muted">En attente des joueurs…</span>') + '</div></div>' +
        '<div class="spacer"></div><button class="btn" id="go" ' + (S.n ? '' : 'disabled') + '>Lancer le quiz (' + S.total + ' questions)</button>',
        () => {
          $('#go').onclick = () => act('start');
          try { new QRCode($('#qr'), { text: url, width: 220, height: 220 }); } catch (e) { $('#qr').remove(); }
        });
    }
    if (S.phase === 'question') {
      return set('<div class="muted">Question ' + (S.q + 1) + ' / ' + S.total + '</div><div class="qtext">' + esc(Q.q) + '</div>' + timerHTML() + opts(Q) +
        '<div class="center"><b>' + S.answered + ' / ' + S.n + '</b> ont répondu</div><div class="spacer"></div><button class="btn sec" id="rv">Révéler maintenant</button>',
        () => { $('#rv').onclick = () => act('reveal'); });
    }
    if (S.phase === 'reveal') {
      return set('<div class="muted">Question ' + (S.q + 1) + ' / ' + S.total + '</div><div class="qtext">' + esc(Q.q) + '</div>' +
        opts(Q, { reveal: true, correct: S.correct, counts: S.counts }) + '<b>Classement</b><div>' + board(S.board, 5) + '</div>' +
        '<div class="spacer"></div><button class="btn" id="nx">' + (S.q >= S.total - 1 ? 'Voir les résultats' : 'Question suivante') + '</button>',
        () => { $('#nx').onclick = () => act('next'); });
    }
    set('<h1>🏆 Résultats finaux</h1><div>' + (S.board.length ? S.board.map((r, i) =>
      '<div class="row"><span>' + (['🥇', '🥈', '🥉'][i] || (i + 1) + '.') + ' ' + esc(r[0]) + '</span><span>' + r[1] + '</span></div>').join('') : '<div class="muted">Aucun joueur.</div>') + '</div>' +
      '<div class="spacer"></div><button class="btn" id="rs">Rejouer avec les mêmes joueurs</button><button class="btn sec" id="nw">Nouvelle partie</button>',
      () => {
        $('#rs').onclick = () => act('restart');
        $('#nw').onclick = () => { if (es) es.close(); save(null); sess = null; S = null; err = ''; render(); };
      });
  }

  /* ---------- joueur ---------- */
  function renderPlayer() {
    if (!sess) {
      const c = new URLSearchParams(location.search).get('c') || '';
      let nm = ''; try { nm = localStorage.getItem('qz_name') || ''; } catch (e) {}
      return set('<div class="spacer"></div><h1 class="center">🎮 Quiz en direct</h1>' + errHTML() +
        '<input class="c" id="cd" inputmode="numeric" maxlength="4" placeholder="Code de la partie" value="' + esc(c) + '">' +
        '<input class="c" id="nm" maxlength="16" placeholder="Ton pseudo" autocomplete="off" value="' + esc(nm) + '">' +
        '<button class="btn" id="jn">Rejoindre</button><div class="spacer"></div>',
        () => {
          const go = async () => {
            const code = $('#cd').value.trim(), name = $('#nm').value.trim();
            if (!code || !name) return;
            try {
              const r = await post('/api/join', { code, name });
              try { localStorage.setItem('qz_name', name); } catch (e) {}
              sess = { code, id: r.id }; save(sess); err = ''; connect(); render();
            } catch (e) { err = e.message; renderPlayer(); $('#cd').value = code; $('#nm').value = name; }
          };
          $('#jn').onclick = go;
          $('#nm').onkeydown = e => { if (e.key === 'Enter') go(); };
        });
    }
    if (!S) return set('<div class="spacer"></div><div class="card center">Connexion…</div><div class="spacer"></div>');
    const me = S.me || { name: '', score: 0, gain: 0, ans: null, rank: 0 }, Q = S.question;
    if (S.phase === 'lobby') {
      return set('<div class="spacer"></div><div class="card center"><h2>Tu es dans la partie, ' + esc(me.name) + ' !</h2><div class="muted" style="margin-top:8px">' + S.n + ' joueur' + (S.n > 1 ? 's' : '') + ' · le quiz va démarrer…</div></div><div class="spacer"></div>');
    }
    if (S.phase === 'question') {
      return set('<div class="muted center">Question ' + (S.q + 1) + ' / ' + S.total + '</div><div class="qtext center">' + esc(Q.q) + '</div>' + timerHTML() +
        opts(Q, { click: me.ans == null, picked: me.ans }) +
        (me.ans != null ? '<div class="center"><b>Réponse envoyée ✓</b><div class="muted">Attends la fin du temps…</div></div>' : ''),
        () => app.querySelectorAll('button[data-c]').forEach(b => b.onclick = () => {
          if (Date.now() > deadline + 800) return;
          const c = +b.dataset.c;
          S.me = Object.assign({}, me, { ans: c }); render();
          post('/api/answer', { code: sess.code, id: sess.id, c }).catch(() => {});
        }));
    }
    if (S.phase === 'reveal') {
      const cls = me.gain > 0 ? 'ok' : (me.ans != null ? 'ko' : 'nr');
      const txt = me.gain > 0 ? 'Bonne réponse ! +' + me.gain : (me.ans != null ? 'Raté !' : 'Pas de réponse');
      return set('<div class="verdict ' + cls + '">' + txt + '</div><div class="center muted">Bonne réponse : <b>' + esc(Q.o[S.correct]) + '</b></div>' +
        '<div class="card center"><div class="muted">Ton score</div><div class="big">' + me.score + '</div><div class="muted">' + ord(me.rank) + ' sur ' + S.n + '</div></div>' +
        '<div>' + board(S.board, 3, me.name) + '</div>');
    }
    set('<h1 class="center">🏆 Terminé !</h1><div class="card center"><div class="muted">Ton classement</div><div class="big">' + ord(me.rank) + '</div><div class="muted">' + me.score + ' points</div></div><div>' + board(S.board, 5, me.name) + '</div>');
  }

  function render() { isHostPage ? renderHost() : renderPlayer(); }
  setInterval(() => {
    const bar = $('#bar'); if (!bar || !S || !S.dur) return;
    const r = Math.max(0, deadline - Date.now());
    bar.style.width = (r / S.dur * 100) + '%';
    const s = $('#sec'); if (s) s.textContent = Math.ceil(r / 1000) + ' s';
  }, 200);
  if (sess) connect();
  render();
}

const PAGE = '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Quiz en direct</title>' +
  '<style>' + CSS + '</style></head><body><div id="app"></div>' +
  '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>' +
  '<script>(' + client.toString() + ')(' + JSON.stringify(DEFAULT_QUIZ) + ');</script></body></html>';

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(() => { if (!res.headersSent) fail(res, 500, 'Erreur serveur'); });
  } else if (url.pathname === '/healthz') {
    res.writeHead(200); res.end('ok');
  } else if (url.pathname === '/' || url.pathname === '/host' || url.pathname === '/host/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
  } else {
    res.writeHead(404); res.end('Not found');
  }
}).listen(PORT, () => console.log('Quiz en direct sur le port ' + PORT));
