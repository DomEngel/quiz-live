'use strict';
/*
  Quiz en direct — un seul fichier, aucune dépendance.
  Lancer :  node server.js      (puis ouvrir http://localhost:3000/host)
  Variable d'environnement : HOST_PASSWORD (mot de passe animateur, "quiz" par défaut)
  Logo : déposer un fichier logo.svg (ou logo.png) à côté de server.js, il s'affiche partout.
  Aperçu du design sans mot de passe : /?demo=host-question (host-lobby, host-reveal, host-end,
  player-question, player-reveal)
*/
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'quiz';
const MAX_GAMES = 20, MAX_PLAYERS = 500;
const games = new Map();
const rid = n => crypto.randomBytes(n).toString('hex');

const LOGO_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const LOGO = Object.keys(LOGO_TYPES).map(e => path.join(__dirname, 'logo' + e)).find(f => fs.existsSync(f)) || null;

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
    const o = x.o.slice(0, 4).map(s => String(s).trim().slice(0, 120)).filter(Boolean);
    let c = Number(x.c);
    if (!Number.isInteger(c) || c < 0 || c >= o.length) c = -1; // -1 = sondage, pas de bonne réponse
    if (o.length < 2) continue;
    out.push({ q: x.q.trim().slice(0, 250), o, c, e: String(x.e || '').trim().slice(0, 600) });
  }
  return out.length ? out : null;
}
function counts(g) {
  const c = g.questions[g.q].o.map(() => 0);
  for (const p of g.players.values()) if (p.ans != null) c[p.ans]++;
  return c;
}
function stateFor(g, cl) {
  const s = { code: g.code, title: g.title, phase: g.phase, q: g.q, total: g.questions.length, n: g.players.size };
  const Q = g.questions[g.q];
  const me = cl.role === 'player' ? g.players.get(cl.id) : null;
  if (me) s.me = { name: me.name, ans: me.ans };
  if (g.phase === 'lobby' && cl.role === 'host') s.names = [...g.players.values()].slice(0, 200).map(p => p.name);
  if (Q && (g.phase === 'question' || g.phase === 'reveal')) {
    s.question = { q: Q.q, o: Q.o };
    const c = counts(g);
    s.answered = c.reduce((a, b) => a + b, 0);
    if (g.phase === 'question') {
      s.rem = Math.max(0, g.startedAt + g.dur - Date.now());
      s.dur = g.dur;
      // en direct : l'animateur voit tout de suite, un joueur seulement après avoir répondu
      if (g.live && (cl.role === 'host' || (me && me.ans != null))) s.counts = c;
    } else {
      s.counts = c; s.correct = Q.c; s.expl = Q.e;
    }
  }
  if (g.phase === 'end' && cl.role === 'host') s.recap = g.results;
  return s;
}
function push(cl, g) {
  try { cl.res.write('event: state\ndata: ' + JSON.stringify(stateFor(g, cl)) + '\n\n'); } catch (e) {}
}
function broadcast(g) { g.dirty = false; g.last = Date.now(); for (const cl of g.clients) push(cl, g); }

function beginQuestion(g) {
  for (const p of g.players.values()) p.ans = null;
  g.startedAt = Date.now();
  g.phase = 'question';
  broadcast(g);
}
function reveal(g) {
  if (g.phase !== 'question') return;
  const Q = g.questions[g.q], c = counts(g);
  g.results[g.q] = { q: Q.q, n: c.reduce((a, b) => a + b, 0), good: Q.c >= 0 ? c[Q.c] : null };
  g.phase = 'reveal';
  broadcast(g);
}
function hostAction(g, action) {
  if (action === 'start' && g.phase === 'lobby') { g.q = 0; beginQuestion(g); }
  else if (action === 'reveal') reveal(g);
  else if (action === 'next' && g.phase === 'reveal') {
    if (g.q >= g.questions.length - 1) { g.phase = 'end'; broadcast(g); }
    else { g.q++; beginQuestion(g); }
  } else if (action === 'restart') {
    g.q = -1; g.phase = 'lobby'; g.results = [];
    for (const p of g.players.values()) p.ans = null;
    broadcast(g);
  }
}
function tick() {
  const now = Date.now();
  for (const [code, g] of games) {
    if (g.phase === 'question') {
      const all = g.players.size > 0 && [...g.players.values()].every(p => p.ans != null);
      if (now >= g.startedAt + g.dur || all) reveal(g);
    }
    if (g.dirty) broadcast(g);
    else if (now - g.last > 15000 && g.clients.size) broadcast(g); // keep-alive
    if (!g.clients.size && now - g.last > 4 * 3600 * 1000) games.delete(code);
  }
}
setInterval(tick, 250);

/* ------------------------------ HTTP ------------------------------ */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 300000) { reject(new Error('trop gros')); req.destroy(); } });
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
    const dur = Math.min(300, Math.max(5, Number(b.dur) || 30)) * 1000;
    const title = String(b.title || '').trim().slice(0, 60) || 'Quiz en direct';
    const g = { code: newCode(), token: rid(16), title, live: b.live !== false, questions, dur, phase: 'lobby', q: -1,
      startedAt: 0, players: new Map(), clients: new Set(), results: [], dirty: false, last: Date.now() };
    games.set(g.code, g);
    return json(res, 200, { code: g.code, token: g.token });
  }
  const g = games.get(String(b.code || ''));
  if (!g) return fail(res, 404, 'Partie introuvable');
  g.last = Date.now();

  if (url.pathname === '/api/join') {
    const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!name) return fail(res, 400, 'Prénom manquant');
    if (g.phase === 'end') return fail(res, 409, 'Le quiz est terminé');
    if (g.players.size >= MAX_PLAYERS) return fail(res, 503, 'Partie complète');
    for (const p of g.players.values()) if (p.name.toLowerCase() === name.toLowerCase()) return fail(res, 409, 'Ce prénom est déjà pris, ajoutez une initiale');
    const id = rid(8);
    g.players.set(id, { id, name, ans: null });
    g.dirty = true;
    return json(res, 200, { id, name });
  }
  if (url.pathname === '/api/answer') {
    const p = g.players.get(String(b.id || ''));
    const c = Number(b.c);
    if (!p || g.phase !== 'question' || p.ans != null) return json(res, 200, { ok: false });
    if (!Number.isInteger(c) || c < 0 || c >= g.questions[g.q].o.length) return fail(res, 400, 'Réponse invalide');
    p.ans = c;
    g.dirty = true;
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
  { q: 'Quelle planète est la plus proche du Soleil ?', o: ['Vénus', 'Mars', 'Mercure', 'La Terre'], c: 2,
    e: 'Mercure orbite à environ 58 millions de kilomètres du Soleil et en fait le tour en 88 jours.' },
  { q: 'En quelle année un être humain a-t-il marché sur la Lune pour la première fois ?', o: ['1961', '1969', '1972', '1981'], c: 1,
    e: 'Mission Apollo 11, juillet 1969 : Neil Armstrong, puis Buzz Aldrin, posent le pied sur la Lune.' },
  { q: 'Combien de temps la lumière du Soleil met-elle pour atteindre la Terre ?', o: ['8 secondes', '8 minutes', '8 heures', '8 jours'], c: 1,
    e: 'Environ 8 minutes et 20 secondes pour parcourir 150 millions de kilomètres.' },
  { q: 'Quel sujet aimeriez-vous approfondir aujourd’hui ?', o: ['L’innovation', 'Le travail en équipe', 'La sécurité', 'L’environnement'], c: -1,
    e: '' }
];

const CSS = `
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{--night:#000d1a;--navy:#00162b;--halo:#7fdcff;--line:rgba(127,220,255,.38);--soft:rgba(255,255,255,.66);
--disp:'Barlow Condensed','Arial Narrow',Impact,sans-serif;--body:'Open Sans',system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
html{background:var(--night)}
body{font-family:var(--body);color:#fff;min-height:100vh;font-size:16px;line-height:1.45}
.sky{position:fixed;inset:0;z-index:-1;overflow:hidden;background:radial-gradient(120% 90% at 15% -10%,#06294a 0%,#00162b 42%,#000d1a 100%)}
.sky:before{content:"";position:absolute;inset:0;opacity:.7;background-image:
radial-gradient(1px 1px at 12% 18%,#fff 50%,transparent 51%),radial-gradient(1px 1px at 78% 12%,#cfefff 50%,transparent 51%),
radial-gradient(1.5px 1.5px at 64% 34%,#fff 50%,transparent 51%),radial-gradient(1px 1px at 33% 42%,#bfe8ff 50%,transparent 51%),
radial-gradient(1px 1px at 90% 48%,#fff 50%,transparent 51%),radial-gradient(1.5px 1.5px at 22% 64%,#d8f3ff 50%,transparent 51%),
radial-gradient(1px 1px at 48% 8%,#fff 50%,transparent 51%),radial-gradient(1px 1px at 5% 50%,#fff 50%,transparent 51%)}
.halo{position:absolute;width:206vmax;height:206vmax;left:50%;top:66vh;margin-left:-78vmax;border-radius:50%;
background:radial-gradient(closest-side,#031b33 0%,#052c50 70%,#0a4f88 86%,#1883c6 90.6%,#7fdcff 91.7%,#f1fcff 92%,rgba(127,220,255,.55) 92.5%,rgba(40,140,220,.22) 95%,rgba(40,140,220,0) 100%)}
#app{max-width:560px;margin:0 auto;padding:18px 18px 44px;min-height:100vh;display:flex;flex-direction:column;gap:18px}
body.host #app{max-width:1080px;padding:26px 32px 48px;gap:24px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:34px}
.logo{height:34px;max-width:55%;object-fit:contain;object-position:left}
body.host .logo{height:46px}
.evt{font-family:var(--disp);font-weight:600;font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:var(--soft);margin-left:auto;text-align:right}
h1,h2,.btn,.lbl,.kicker,label{font-family:var(--disp);text-transform:uppercase;letter-spacing:.04em}
h1{font-size:40px;font-weight:800;line-height:1}
body.host h1{font-size:60px}
h2{font-size:26px;font-weight:700;line-height:1.1}
.kicker{font-size:15px;font-weight:600;letter-spacing:.16em;color:var(--halo)}
.muted{color:var(--soft);font-size:15px}.center{text-align:center}.spacer{flex:1}
.card{background:rgba(2,24,46,.62);border:1px solid var(--line);border-radius:4px;padding:18px;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
label{display:block;font-size:14px;font-weight:600;letter-spacing:.12em;color:var(--soft);margin:0 0 6px}
input,textarea{width:100%;font:inherit;font-size:17px;color:#fff;background:rgba(0,13,26,.7);border:1px solid var(--line);border-radius:3px;padding:13px 14px;outline:none}
input:focus,textarea:focus{border-color:var(--halo);box-shadow:0 0 0 1px var(--halo),0 0 18px rgba(127,220,255,.35)}
input.c{text-align:center;font-size:20px}
textarea{min-height:280px;font-size:15px;line-height:1.45}
.check{display:flex;gap:10px;align-items:center;font-family:var(--body);text-transform:none;letter-spacing:0;font-size:15px;color:#fff}
.check input{width:20px;height:20px;accent-color:#7fdcff}
.btn{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;border:0;border-radius:2px;padding:17px 22px;font-size:19px;font-weight:700;letter-spacing:.1em;color:var(--navy);background:#fff;cursor:pointer;box-shadow:0 0 26px rgba(127,220,255,.35);transition:box-shadow .2s,transform .1s}
.btn:after{content:"";width:9px;height:9px;border-top:2px solid var(--navy);border-right:2px solid var(--navy);transform:rotate(45deg)}
@media (hover:hover){.btn:hover{box-shadow:0 0 38px rgba(127,220,255,.7)}}.btn:active{transform:translateY(1px)}
.btn:disabled{opacity:.4;cursor:default;box-shadow:none}
.btn.sec{background:transparent;color:#fff;border:1px solid var(--line);box-shadow:none}
.btn.sec:after{border-color:#fff}
body.host .btn{width:auto;align-self:flex-start;min-width:280px}
.err{border:1px solid #ff8f8f;background:rgba(120,20,30,.45);border-radius:3px;padding:12px;text-align:center}
.qhead{display:flex;align-items:center;gap:18px}
.qhead>div:first-child{flex:1;min-width:0}
.qtext{font-family:var(--disp);font-weight:700;font-size:30px;line-height:1.08;margin-top:6px;text-transform:none;letter-spacing:.01em}
body.host .qtext{font-size:clamp(34px,4.2vw,58px)}
.ring{position:relative;width:86px;height:86px;flex:none}
body.host .ring{width:150px;height:150px}
.ring svg{width:100%;height:100%;overflow:visible}
.trk{fill:none;stroke:rgba(127,220,255,.16);stroke-width:4}
.prg{fill:none;stroke:var(--halo);stroke-width:5;stroke-linecap:round;stroke-dasharray:326.73;filter:drop-shadow(0 0 5px rgba(127,220,255,.95)) drop-shadow(0 0 14px rgba(60,160,255,.7));transition:stroke-dashoffset .25s linear}
.ring.low .prg{stroke:#fff}
.sec{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--disp);font-weight:700;font-size:32px}
body.host .sec{font-size:56px}
.tiles{display:grid;grid-template-columns:1fr;gap:12px}
body.host .tiles{grid-template-columns:1fr 1fr;gap:16px}
.tile{position:relative;overflow:hidden;display:flex;align-items:center;gap:14px;width:100%;min-height:78px;padding:14px 16px;text-align:left;font:inherit;color:#fff;cursor:default;
background:rgba(2,24,46,.6);border:1px solid var(--line);border-radius:4px;box-shadow:inset 0 0 22px rgba(127,220,255,.07);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);transition:border-color .2s,box-shadow .2s,opacity .3s}
body.host .tile{min-height:98px;padding:16px 22px;gap:18px}
button.tile{cursor:pointer}
button.tile{outline:none}
.tile.sel{border-color:var(--halo);box-shadow:0 0 0 1px var(--halo),0 0 26px rgba(127,220,255,.5),inset 0 0 26px rgba(127,220,255,.14)}
@media (hover:hover){button.tile:hover{border-color:var(--halo);box-shadow:0 0 0 1px var(--halo),0 0 26px rgba(127,220,255,.5),inset 0 0 26px rgba(127,220,255,.14)}}
.tile.good{border-color:#fff;box-shadow:0 0 0 1px #fff,0 0 34px rgba(160,230,255,.75),inset 0 0 30px rgba(127,220,255,.22)}
.tile.dim{opacity:.5}
.fill{position:absolute;left:0;top:0;bottom:0;width:0;background:linear-gradient(90deg,rgba(31,143,208,.28),rgba(127,220,255,.42));border-right:1px solid rgba(127,220,255,.8);transition:width .5s ease;opacity:0}
.fill.on{opacity:1}
.tile>*:not(.fill){position:relative}
.ltr{flex:none;width:38px;height:38px;border-radius:50%;border:1.5px solid var(--halo);display:flex;align-items:center;justify-content:center;font-family:var(--disp);font-weight:700;font-size:20px;box-shadow:0 0 12px rgba(127,220,255,.45)}
body.host .ltr{width:50px;height:50px;font-size:26px}
.good .ltr{background:#fff;color:var(--navy);border-color:#fff}
.txt{flex:1;min-width:0;font-weight:600;font-size:17px;line-height:1.25}
body.host .txt{font-size:clamp(20px,2vw,28px)}
.tag{display:block;font-family:var(--disp);font-size:13px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--halo);margin-top:3px}
.pct{flex:none;font-family:var(--disp);font-weight:700;font-size:28px;min-width:58px;text-align:right}
body.host .pct{font-size:46px;min-width:100px}
.pct small{font-size:.5em;margin-left:2px;color:var(--soft)}
.meta{font-family:var(--disp);font-size:18px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.9);text-shadow:0 1px 10px #000d1a,0 0 3px #000d1a}
.meta b{color:#fff;font-size:1.25em}
.answer{border:1px solid #fff;border-radius:4px;padding:18px 20px;background:linear-gradient(135deg,rgba(11,90,148,.5),rgba(2,24,46,.75));box-shadow:0 0 34px rgba(127,220,255,.35);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.answer .lbl{font-size:14px;font-weight:600;letter-spacing:.16em;color:var(--halo)}
.answer .ans{font-family:var(--disp);font-weight:700;font-size:26px;line-height:1.1;margin-top:4px}
body.host .answer .ans{font-size:36px}
.answer p{margin-top:8px;color:rgba(255,255,255,.88);font-size:16px}
body.host .answer p{font-size:20px}
body.host .foot{display:flex;align-items:center;gap:28px;flex-wrap:wrap}
.foot{display:grid;gap:14px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{border:1px solid var(--line);background:rgba(2,24,46,.6);border-radius:30px;padding:5px 14px;font-size:15px}
.lobby{display:grid;gap:24px;align-items:center}
body.host .lobby{grid-template-columns:auto 1fr;gap:48px}
.qr{background:#fff;padding:14px;border-radius:4px;display:inline-block;box-shadow:0 0 40px rgba(127,220,255,.45)}
.code{font-family:var(--disp);font-weight:800;font-size:92px;line-height:1;letter-spacing:.12em;text-shadow:0 0 30px rgba(127,220,255,.6)}
.url{font-size:20px;word-break:break-all}
.rrow{display:flex;gap:16px;align-items:center;padding:12px 0;border-bottom:1px solid rgba(127,220,255,.18)}
.rrow span:first-child{flex:1;min-width:0}
.rrow b{font-family:var(--disp);font-size:26px}
.wait{width:64px;height:64px;margin:0 auto 16px;border-radius:50%;border:2px solid rgba(127,220,255,.2);border-top-color:var(--halo);box-shadow:0 0 22px rgba(127,220,255,.4);animation:spin 1.6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.wait{animation:none}.fill,.prg{transition:none}}
`;

function client(DEFAULT_QUIZ, HAS_LOGO) {
  const L = ['A', 'B', 'C', 'D'], CIRC = 326.73;
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = $('#app');
  const params = new URLSearchParams(location.search);
  const demo = params.get('demo');
  const isHost = demo ? demo.indexOf('host') === 0 : location.pathname.replace(/\/+$/, '') === '/host';
  if (isHost) document.body.classList.add('host');
  const KEY = isHost ? 'qz_host' : 'qz_player';
  let S = null, es = null, deadline = 0, err = '', view = '';
  let sess = null;
  if (!demo) { try { sess = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {} }
  const save = v => { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch (e) {} };

  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Erreur');
    return j;
  }
  function connect() {
    if (es) es.close();
    es = new EventSource('/api/events?code=' + encodeURIComponent(sess.code) + (isHost ? '&token=' + sess.token : '&id=' + sess.id));
    es.addEventListener('state', e => { S = JSON.parse(e.data); deadline = Date.now() + (S.rem || 0); render(); });
    es.addEventListener('gone', () => { es.close(); save(null); sess = null; S = null; err = 'Partie terminée ou introuvable.'; render(); });
  }
  const act = a => { if (!demo) post('/api/host', { code: sess.code, token: sess.token, action: a }).catch(() => {}); };

  /* format texte : question, réponses (la bonne commence par *), puis "> explication" */
  function parseQuiz(t) {
    return t.split(/\n\s*\n/).map(b => b.split('\n').map(l => l.trim()).filter(Boolean)).filter(l => l.length >= 3).map(l => {
      let c = -1; const o = [], e = [];
      l.slice(1).forEach(x => {
        if (x[0] === '>') { e.push(x.slice(1).trim()); return; }
        if (x[0] === '*') { c = o.length; x = x.slice(1).trim(); }
        o.push(x);
      });
      return { q: l[0], o, c, e: e.join(' ') };
    }).filter(x => x.o.length >= 2 && x.o.length <= 4);
  }
  const quizText = () => DEFAULT_QUIZ.map(x => x.q + '\n' + x.o.map((o, i) => (i === x.c ? '*' : '') + o).join('\n') + (x.e ? '\n> ' + x.e : '')).join('\n\n');

  const header = () => '<header class="top">' + (HAS_LOGO ? '<img class="logo" src="/logo" alt="">' : '') + '<span class="evt">' + esc((S && S.title) || 'Quiz en direct') + '</span></header>';
  const errHTML = () => err ? '<div class="err">' + esc(err) + '</div>' : '';
  const ring = () => '<div class="ring" id="ring"><svg viewBox="0 0 120 120"><circle class="trk" cx="60" cy="60" r="52"/><circle class="prg" id="prg" cx="60" cy="60" r="52" transform="rotate(-90 60 60)"/></svg><div class="sec" id="sec"></div></div>';
  function tiles(Q, o) {
    o = o || {};
    return '<div class="tiles">' + Q.o.map((t, i) => {
      const cls = ['tile'];
      if (o.picked === i) cls.push('sel');
      if (o.reveal && o.correct === i) cls.push('good');
      if (o.reveal && o.correct >= 0 && o.correct !== i) cls.push('dim');
      const tag = o.click ? 'button' : 'div';
      return '<' + tag + ' class="' + cls.join(' ') + '"' + (o.click ? ' data-c="' + i + '"' : '') + '><span class="fill" data-bar="' + i + '"></span>' +
        '<span class="ltr">' + L[i] + '</span><span class="txt">' + esc(t) + (o.picked === i ? '<span class="tag">Votre réponse</span>' : '') + '</span>' +
        '<span class="pct" data-pct="' + i + '"></span></' + tag + '>';
    }).join('') + '</div>';
  }
  function answerCard() {
    const Q = S.question;
    if (S.correct >= 0) return '<div class="answer"><div class="lbl">La bonne réponse</div><div class="ans">' + L[S.correct] + ' · ' + esc(Q.o[S.correct]) + '</div>' + (S.expl ? '<p>' + esc(S.expl) + '</p>' : '') + '</div>';
    return S.expl ? '<div class="answer"><div class="lbl">À retenir</div><p>' + esc(S.expl) + '</p></div>' : '';
  }
  const qhead = withRing => '<div class="qhead"><div><div class="kicker">Question ' + (S.q + 1) + ' / ' + S.total + '</div><div class="qtext">' + esc(S.question.q) + '</div></div>' + (withRing ? ring() : '') + '</div>';
  const plural = (n, w) => n + ' ' + w + (n > 1 ? 's' : '');
  const set = (html, bind) => { app.innerHTML = html; if (bind) bind(); };

  /* met à jour barres, pourcentages et compteurs sans tout redessiner */
  function patch() {
    if (!S) return;
    const c = S.counts, tot = c ? c.reduce((a, b) => a + b, 0) : 0;
    document.querySelectorAll('[data-bar]').forEach(el => {
      const i = +el.dataset.bar, p = c && tot ? Math.round(c[i] / tot * 100) : 0;
      el.classList.toggle('on', !!c);
      el.style.width = (c ? p : 0) + '%';
      const t = document.querySelector('[data-pct="' + i + '"]');
      if (t) t.innerHTML = c ? p + '<small>%</small>' : '';
    });
    const cnt = $('#cnt');
    if (cnt) {
      cnt.innerHTML = '<b>' + S.n + '</b> ' + (S.n > 1 ? 'participants connectés' : 'participant connecté');
      $('#names').innerHTML = (S.names || []).map(n => '<span class="chip">' + esc(n) + '</span>').join('') || '<span class="muted">En attente des participants…</span>';
    }
    const a = $('#ans');
    if (a) a.innerHTML = isHost ? '<b>' + (S.answered || 0) + '</b> / ' + plural(S.n, 'participant') + ' ont répondu' : plural(S.answered || 0, 'réponse');
    tickTimer();
  }
  function tickTimer() {
    const prg = $('#prg'); if (!prg || !S || !S.dur) return;
    const r = Math.max(0, deadline - Date.now());
    prg.style.strokeDashoffset = CIRC * (1 - r / S.dur);
    $('#sec').textContent = Math.ceil(r / 1000);
    $('#ring').classList.toggle('low', r < 5000);
  }

  /* ---------- animateur ---------- */
  function buildHost() {
    if (!sess) {
      let pw = ''; try { pw = sessionStorage.getItem('qz_pw') || ''; } catch (e) {}
      return set(header() + '<h1>Nouvelle partie</h1>' + errHTML() +
        '<div><label>Mot de passe animateur</label><input id="pw" type="password" value="' + esc(pw) + '"></div>' +
        '<div><label>Titre affiché</label><input id="ti" maxlength="60" value="Quiz en direct"></div>' +
        '<div><label>Durée par question (secondes)</label><input id="du" type="number" min="5" max="300" value="30"></div>' +
        '<label class="check"><input id="lv" type="checkbox" checked> Afficher les pourcentages en direct pendant la question (sinon, seulement à la révélation)</label>' +
        '<div><label>Questions</label><div class="muted" style="margin-bottom:8px">Une ligne vide entre deux questions. La bonne réponse commence par *. Sans *, la question devient un sondage. Une ligne qui commence par &gt; est l’explication affichée avec la réponse.</div><textarea id="qs"></textarea></div>' +
        '<button class="btn" id="cr">Créer la partie</button>',
        () => {
          $('#qs').value = quizText();
          $('#cr').onclick = async () => {
            const keep = { qs: $('#qs').value, du: $('#du').value, ti: $('#ti').value, lv: $('#lv').checked };
            const back = () => { view = ''; render(); $('#qs').value = keep.qs; $('#du').value = keep.du; $('#ti').value = keep.ti; $('#lv').checked = keep.lv; };
            const questions = parseQuiz(keep.qs);
            if (!questions.length) { err = 'Aucune question valide : il faut une question et 2 à 4 réponses.'; return back(); }
            try {
              const password = $('#pw').value;
              try { sessionStorage.setItem('qz_pw', password); } catch (e) {}
              const r = await post('/api/create', { password, questions, dur: +keep.du, title: keep.ti, live: keep.lv });
              sess = { code: r.code, token: r.token }; save(sess); err = ''; connect(); render();
            } catch (e) { err = e.message; back(); }
          };
        });
    }
    if (!S) return set(header() + '<div class="card center"><div class="wait"></div>Connexion…</div>');
    if (S.phase === 'lobby') {
      const url = location.origin + '/?c=' + S.code;
      return set(header() + '<div class="lobby"><div class="center"><div class="qr" id="qr"></div></div><div><div class="kicker">Scannez le QR code, ou allez sur</div><div class="url">' + esc(location.host) + '</div><div class="kicker" style="margin-top:18px">Code de la partie</div><div class="code">' + esc(S.code) + '</div></div></div>' +
        '<div class="card"><div class="meta" id="cnt"></div><div class="chips" id="names" style="margin-top:12px"></div></div>' +
        '<div class="spacer"></div><button class="btn" id="go">Lancer le quiz · ' + plural(S.total, 'question') + '</button>',
        () => {
          $('#go').onclick = () => act('start');
          try { new QRCode($('#qr'), { text: url, width: 240, height: 240 }); } catch (e) { $('#qr').remove(); }
        });
    }
    if (S.phase === 'question') {
      return set(header() + qhead(true) + tiles(S.question) + '<div class="spacer"></div><div class="foot"><button class="btn" id="rv">Révéler la réponse</button><div class="meta" id="ans"></div></div>',
        () => { $('#rv').onclick = () => act('reveal'); });
    }
    if (S.phase === 'reveal') {
      return set(header() + qhead(false) + tiles(S.question, { reveal: true, correct: S.correct }) + answerCard() + '<div class="spacer"></div>' +
        '<div class="foot"><button class="btn" id="nx">' + (S.q >= S.total - 1 ? 'Terminer' : 'Question suivante') + '</button><div class="meta" id="ans"></div></div>',
        () => { $('#nx').onclick = () => act('next'); });
    }
    set(header() + '<h1>Merci à toutes et à tous</h1><div class="card"><div class="kicker">Synthèse</div>' +
      (S.recap || []).filter(Boolean).map((r, i) => '<div class="rrow"><span>' + (i + 1) + '. ' + esc(r.q) + '<div class="muted">' + plural(r.n, 'réponse') + '</div></span><b>' +
        (r.good == null ? 'Sondage' : (r.n ? Math.round(r.good / r.n * 100) : 0) + ' %') + '</b></div>').join('') + '<div class="muted" style="margin-top:10px">Pourcentage de bonnes réponses par question.</div></div>' +
      '<div class="spacer"></div><button class="btn" id="rs">Rejouer avec les mêmes participants</button><button class="btn sec" id="nw">Nouvelle partie</button>',
      () => {
        $('#rs').onclick = () => act('restart');
        $('#nw').onclick = () => { if (demo) return; if (es) es.close(); save(null); sess = null; S = null; err = ''; render(); };
      });
  }

  /* ---------- participant ---------- */
  function buildPlayer() {
    if (!sess) {
      const c = params.get('c') || '';
      let nm = ''; try { nm = localStorage.getItem('qz_name') || ''; } catch (e) {}
      return set(header() + '<div class="spacer"></div><h1>Rejoindre<br>le quiz</h1>' + errHTML() +
        '<div><label>Code de la partie</label><input class="c" id="cd" inputmode="numeric" maxlength="4" value="' + esc(c) + '"></div>' +
        '<div><label>Votre prénom</label><input class="c" id="nm" maxlength="20" autocomplete="off" value="' + esc(nm) + '"></div>' +
        '<button class="btn" id="jn">Rejoindre</button><div class="spacer"></div><div class="spacer"></div>',
        () => {
          const go = async () => {
            const code = $('#cd').value.trim(), name = $('#nm').value.trim();
            if (!code || !name) return;
            try {
              const r = await post('/api/join', { code, name });
              try { localStorage.setItem('qz_name', name); } catch (e) {}
              sess = { code, id: r.id }; save(sess); err = ''; connect(); render();
            } catch (e) { err = e.message; view = ''; render(); $('#cd').value = code; $('#nm').value = name; }
          };
          $('#jn').onclick = go;
          $('#nm').onkeydown = e => { if (e.key === 'Enter') go(); };
        });
    }
    if (!S) return set(header() + '<div class="spacer"></div><div class="card center"><div class="wait"></div>Connexion…</div><div class="spacer"></div>');
    const me = S.me || { name: '', ans: null };
    if (S.phase === 'lobby') {
      return set(header() + '<div class="spacer"></div><div class="card center"><div class="wait"></div><h2>Bienvenue ' + esc(me.name) + '</h2><div class="muted" style="margin-top:8px">Le quiz va bientôt commencer. Gardez cette page ouverte.</div></div><div class="spacer"></div><div class="spacer"></div>');
    }
    if (S.phase === 'question') {
      let pick = null;
      const done = me.ans != null;
      return set(header() + qhead(true) + tiles(S.question, { click: !done, picked: me.ans }) +
        (done ? '<div class="meta center">Réponse validée · <span id="ans"></span></div>'
              : '<button class="btn" id="vd" disabled>Valider ma réponse</button><div class="muted center">Vous pouvez changer de choix tant que vous n’avez pas validé. Une réponse non validée n’est pas comptée.</div>'),
        () => {
          const vd = $('#vd'); if (!vd) return;
          app.querySelectorAll('button[data-c]').forEach(b => b.onclick = () => {
            pick = +b.dataset.c;
            app.querySelectorAll('.tile').forEach((t, i) => t.classList.toggle('sel', i === pick));
            vd.disabled = false;
          });
          vd.onclick = () => {
            if (pick == null || Date.now() > deadline + 800) return;
            S.me = { name: me.name, ans: pick }; render();
            if (!demo) post('/api/answer', { code: sess.code, id: sess.id, c: pick }).catch(() => {});
          };
        });
    }
    if (S.phase === 'reveal') {
      return set(header() + qhead(false) + tiles(S.question, { reveal: true, correct: S.correct, picked: me.ans }) + answerCard() + '<div class="meta center" id="ans"></div>');
    }
    set(header() + '<div class="spacer"></div><div class="card center"><h2>Merci pour votre participation</h2><div class="muted" style="margin-top:8px">Le quiz est terminé.</div></div><div class="spacer"></div><div class="spacer"></div>');
  }

  function render() {
    const me = S && S.me;
    const key = [isHost, !!sess, S ? S.phase : '-', S ? S.q : '', me ? me.ans : '', err].join('|');
    if (key !== view) { view = key; isHost ? buildHost() : buildPlayer(); requestAnimationFrame(patch); }
    else patch();
  }

  if (demo) {
    const Q = DEFAULT_QUIZ[0], ph = demo.split('-')[1] || 'question';
    sess = { code: '4821', id: 'demo', token: 'demo' };
    S = { code: '4821', title: 'Quiz en direct', phase: ph, q: 0, total: DEFAULT_QUIZ.length, n: 48, question: { q: Q.q, o: Q.o }, answered: 41 };
    if (ph === 'lobby') { S.n = 6; S.names = ['Camille', 'Thomas', 'Inès', 'Julien', 'Sarah', 'Marc']; }
    if (ph === 'question') { S.dur = 30000; S.rem = 19000; if (isHost) S.counts = [5, 3, 29, 4]; else S.me = { name: 'Camille', ans: null }; }
    if (ph === 'reveal') { S.counts = [5, 3, 29, 4]; S.correct = Q.c; S.expl = Q.e; if (!isHost) S.me = { name: 'Camille', ans: 2 }; }
    if (ph === 'end') S.recap = DEFAULT_QUIZ.map((x, i) => ({ q: x.q, n: 44 - i, good: x.c < 0 ? null : 30 - 4 * i }));
    deadline = Date.now() + (S.rem || 0);
  }
  setInterval(tickTimer, 200);
  if (sess && !demo) connect();
  render();
}

const PAGE = '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#000d1a"><title>Quiz en direct</title>' +
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Open+Sans:wght@400;600&display=swap" rel="stylesheet">' +
  '<style>' + CSS + '</style></head><body><div class="sky"><div class="halo"></div></div><div id="app"></div>' +
  '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>' +
  '<script>(' + client.toString() + ')(' + JSON.stringify(DEFAULT_QUIZ) + ',' + (LOGO ? 'true' : 'false') + ');</script></body></html>';

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(() => { if (!res.headersSent) fail(res, 500, 'Erreur serveur'); });
  } else if (url.pathname === '/healthz') {
    res.writeHead(200); res.end('ok');
  } else if (url.pathname === '/logo' && LOGO) {
    res.writeHead(200, { 'Content-Type': LOGO_TYPES[path.extname(LOGO)], 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    fs.createReadStream(LOGO).pipe(res);
  } else if (url.pathname === '/' || url.pathname === '/host' || url.pathname === '/host/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
  } else {
    res.writeHead(404); res.end('Not found');
  }
}).listen(PORT, () => console.log('Quiz en direct sur le port ' + PORT));
