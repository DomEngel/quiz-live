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
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const out = [];
  for (const x of qs.slice(0, 120)) {
    if (!x) continue;
    if (x.t === 'scene') { // écran de scène : titre + indication de temps / de lieu
      const title = str(x.title, 120);
      const subs = String(x.sub || '').split('\n').map(l => str(l, 140)).filter(Boolean).slice(0, 10); // un temps par ligne
      if (title) out.push({ t: 'scene', title, subs });
      continue;
    }
    if (x.t === 'info') { // écran de contenu : titre + paragraphes / puces
      const title = str(x.title, 120);
      const lines = (Array.isArray(x.lines) ? x.lines : []).slice(0, 14).map(l => str(l, 400)).filter(Boolean);
      if (title || lines.length) out.push({ t: 'info', title, lines });
      continue;
    }
    if (typeof x.q !== 'string' || !Array.isArray(x.o) || !x.q.trim()) continue;
    const o = x.o.slice(0, 4).map(s => String(s).trim().slice(0, 120)).filter(Boolean);
    let c = Number(x.c);
    if (!Number.isInteger(c) || c < 0 || c >= o.length) c = -1; // -1 = sondage, pas de bonne réponse
    if (o.length < 2) continue;
    out.push({ t: 'q', q: x.q.trim().slice(0, 250), o, c, e: String(x.e || '').trim().slice(0, 600) });
  }
  return out.length ? out : null;
}
function counts(g) {
  const c = g.questions[g.q].o.map(() => 0);
  for (const p of g.players.values()) if (p.a[g.q] != null) c[p.a[g.q]]++;
  return c;
}
function stateFor(g, cl) {
  const Q = g.questions[g.q];
  // i = position dans le déroulé (scènes, contenus, questions) ; q = numéro de question
  const s = { code: g.code, title: g.title, phase: g.phase, i: g.q, steps: g.questions.length, total: g.nq, n: g.players.size,
    q: g.questions.slice(0, g.q + 1).filter(x => x.t === 'q').length - 1 };
  const two = g.phase === 'slide' && ask(g, Q);
  const more = Q && g.phase === 'slide' && ((Q.t === 'scene' && g.step < Q.subs.length - 1) || (two && g.step < 1));
  if (Q && g.phase === 'slide') s.slide = Q.t === 'scene' ? { t: 'scene', title: Q.title, sub: Q.subs[g.step] || '' } : { t: 'info', title: Q.title, lines: two && !g.step ? [] : Q.lines, ask: two, fin: !g.questions[g.q + 1] }; // fin = dernier écran du déroulé
  const staff = cl.role === 'host' || cl.role === 'screen'; // animateur ou écran de projection
  if (cl.role === 'host') {
    s.view = g.view;
    const N = g.questions[g.q + 1];
    s.next = more ? (Q.t === 'info' ? 'content' : 'sub') : N ? (N.t === 'info' && !g.questions[g.q + 2] ? 'final' : N.t) : 'end';
    s.back = g.phase === 'end' || (g.phase !== 'lobby' && (g.q > 0 || g.step > 0));
    if (s.slide && Q.t === 'scene' && Q.subs.length > 1) s.part = [g.step + 1, Q.subs.length];
  }
  const me = cl.role === 'player' ? g.players.get(cl.id) : null;
  if (me) s.me = { name: me.name, ans: me.a[g.q] };
  if (g.phase === 'lobby' && staff) s.names = [...g.players.values()].slice(0, 200).map(p => p.name);
  if (Q && (g.phase === 'question' || g.phase === 'reveal')) {
    s.question = { q: Q.q, o: Q.o };
    s.poll = Q.c < 0; // sondage : pas de bonne réponse, pas de minuteur
    const c = counts(g);
    s.answered = c.reduce((a, b) => a + b, 0);
    if (g.phase === 'question') {
      if (Q.c >= 0) { s.rem = Math.max(0, g.startedAt + g.dur - Date.now()); s.dur = g.dur; }
      // en direct : l'animateur voit tout de suite, un joueur seulement après avoir répondu
      if (g.live && (staff || (me && me.a[g.q] != null))) s.counts = c;
    } else {
      s.counts = c; s.correct = Q.c; s.expl = Q.e;
    }
  }
  if (g.phase === 'end' && staff) s.recap = g.results;
  return s;
}
function push(cl, g) {
  try { cl.res.write('event: state\ndata: ' + JSON.stringify(stateFor(g, cl)) + '\n\n'); } catch (e) {}
}
function broadcast(g) { g.dirty = false; g.last = Date.now(); for (const cl of g.clients) push(cl, g); }

function beginQuestion(g) {
  for (const p of g.players.values()) delete p.a[g.q];
  g.startedAt = Date.now();
  g.phase = 'question';
  broadcast(g);
}
function reveal(g) {
  if (g.phase !== 'question') return;
  const Q = g.questions[g.q], c = counts(g);
  g.results[g.q] = { q: Q.q, n: c.reduce((a, b) => a + b, 0), good: Q.c >= 0 ? c[Q.c] : null, poll: Q.c < 0, c: Q.c, o: Q.o.map((t, i) => ({ t, n: c[i] })) };
  g.phase = 'reveal'; g.actAt = Date.now();
  broadcast(g);
}
function show(g, i, back) {
  g.q = i; g.step = 0; g.actAt = Date.now();
  const it = g.questions[i];
  if (!it) { g.phase = 'end'; broadcast(g); }
  else if (it.t === 'q') {
    if (g.results[i]) { g.phase = 'reveal'; broadcast(g); } // question déjà jouée : on réaffiche ses résultats
    else beginQuestion(g);
  } else {
    if (back && it.t === 'scene') g.step = Math.max(0, it.subs.length - 1);
    if (back && ask(g, it)) g.step = 1;
    g.phase = 'slide'; broadcast(g);
  }
}
const ask = (g, Q) => !!(Q && Q.t === 'info' && Q.title && Q.lines.length && g.questions[g.q + 1]); // contenu en 2 temps (sauf l’écran final)
function hostAction(g, action) {
  // anti double-appui : un changement d'étape vient d'avoir lieu (action ou révélation automatique) -> on ignore un appui trop rapproché
  const now = Date.now(), nav = action === 'reveal' || action === 'next' || action === 'prev';
  if (nav && g.phase !== 'lobby' && now - (g.actAt || 0) < 800) return;
  if (nav) g.actAt = now;
  if (action === 'start' && g.phase === 'lobby') show(g, 0);
  else if (action === 'reveal') reveal(g);
  else if (action === 'next' && (g.phase === 'reveal' || g.phase === 'slide')) {
    const it = g.questions[g.q];
    if (g.phase === 'slide' && it.t === 'scene' && g.step < it.subs.length - 1) { g.step++; broadcast(g); }
    else if (g.phase === 'slide' && ask(g, it) && g.step < 1) { g.step = 1; broadcast(g); }
    else show(g, g.q + 1);
  } else if (action === 'prev') {
    if (g.phase === 'end') show(g, g.questions.length - 1, true);
    else if (g.phase === 'slide' && g.step > 0) { g.step--; broadcast(g); }
    else if (g.phase !== 'lobby' && g.q > 0) show(g, g.q - 1, true);
  } else if (action === 'restart') {
    g.q = -1; g.step = 0; g.phase = 'lobby'; g.results = [];
    for (const p of g.players.values()) p.a = {};
    broadcast(g);
  }
}
function tick() {
  const now = Date.now();
  for (const [code, g] of games) {
    if (g.phase === 'question') {
      const all = g.players.size > 0 && [...g.players.values()].every(p => p.a[g.q] != null);
      const poll = g.questions[g.q].c < 0; // un sondage n’a pas de limite de temps : il se termine quand tout le monde a répondu, ou sur l’action de l’animateur
      if ((!poll && now >= g.startedAt + g.dur) || all) reveal(g);
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
    const token = url.searchParams.get('token'), id = url.searchParams.get('id'), view = url.searchParams.get('view');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    const isHost = g && token && token === g.token;
    const isScreen = g && view && view === g.view;
    const isPlayer = g && id && g.players.has(id);
    if (!isHost && !isScreen && !isPlayer) { res.write('event: gone\ndata: {}\n\n'); res.end(); return; }
    const cl = { res, role: isHost ? 'host' : isScreen ? 'screen' : 'player', id };
    g.clients.add(cl);
    g.last = Date.now();
    res.write('retry: 2000\n\n');
    push(cl, g);
    req.on('close', () => g.clients.delete(cl));
    return;
  }
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  let b;
  try { b = await readBody(req); } catch (e) { return fail(res, 400, 'Invalid request'); }

  if (url.pathname === '/api/create') {
    if (String(b.password || '') !== HOST_PASSWORD) {
      await new Promise(r => setTimeout(r, 600));
      return fail(res, 403, 'Incorrect password');
    }
    const questions = cleanQuestions(b.questions);
    if (!questions) return fail(res, 400, 'No valid step');
    if (games.size >= MAX_GAMES) return fail(res, 503, 'Trop de parties en cours');
    const dur = Math.min(300, Math.max(5, Number(b.dur) || 30)) * 1000;
    const title = String(b.title || '').trim().slice(0, 60) || 'Live quiz';
    const g = { code: newCode(), token: rid(16), view: rid(12), title, live: b.live !== false, questions, nq: questions.filter(x => x.t === 'q').length, dur, phase: 'lobby', q: -1, step: 0,
      startedAt: 0, players: new Map(), clients: new Set(), results: [], dirty: false, last: Date.now() };
    games.set(g.code, g);
    return json(res, 200, { code: g.code, token: g.token, view: g.view });
  }
  const g = games.get(String(b.code || ''));
  if (!g) return fail(res, 404, 'Game not found');
  g.last = Date.now();

  if (url.pathname === '/api/join') {
    const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!name) return fail(res, 400, 'First name missing');
    if (g.phase === 'end') return fail(res, 409, 'The quiz is over');
    if (g.players.size >= MAX_PLAYERS) return fail(res, 503, 'Game full');
    for (const p of g.players.values()) if (p.name.toLowerCase() === name.toLowerCase()) return fail(res, 409, 'This name is already taken, add an initial');
    const id = rid(8);
    g.players.set(id, { id, name, a: {} });
    g.dirty = true;
    return json(res, 200, { id, name });
  }
  if (url.pathname === '/api/answer') {
    const p = g.players.get(String(b.id || ''));
    const c = Number(b.c);
    if (!p || g.phase !== 'question' || p.a[g.q] != null) return json(res, 200, { ok: false });
    if (!Number.isInteger(c) || c < 0 || c >= g.questions[g.q].o.length) return fail(res, 400, 'Invalid answer');
    p.a[g.q] = c;
    g.dirty = true;
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/host') {
    if (String(b.token || '') !== g.token) return fail(res, 403, 'Not authorized');
    hostAction(g, String(b.action || ''));
    return json(res, 200, { ok: true });
  }
  return fail(res, 404, 'Inconnu');
}

/* ------------------------------ page (client) ------------------------------ */
const DEFAULT_QUIZ = [
 {
  "q": "How many people work at ArianeGroup?",
  "o": [
   "About 2,000",
   "About 8,000",
   "About 15,000",
   "About 30,000"
  ],
  "c": 1,
  "e": "About 8,000 people, in France and in Germany."
 },
 {
  "q": "How many of them are based in Germany?",
  "o": [
   "About 300",
   "About 1,200",
   "About 4,000",
   "About 6,000"
  ],
  "c": 1,
  "e": "About 1,200 people: roughly 15 % of the group.\n85 % are in France."
 },
 {
  "q": "When are French and German teams most likely to be at their desks at the same time?",
  "o": [
   "7 – 9 a.m.",
   "9:30 – 11 a.m.",
   "12 – 1:30 p.m.",
   "5 – 7 p.m."
  ],
  "c": 1,
  "e": "**Germany:** early start (around 7 a.m.), short lunch, often gone by 4 p.m.\n**France:** starts around 9 a.m., long lunch, stays until 6 or 7 p.m.\n**Shared windows:** 9:30 – 11 a.m. and 1:30 – 4 p.m."
 },
 {
  "q": "And if we add Kourou? When can France, Germany and Kourou all meet (Paris / Munich time)?",
  "o": [
   "9:30 – 11 a.m.",
   "1:30 – 4 p.m.",
   "5 – 7 p.m.",
   "Never"
  ],
  "c": 1,
  "e": "In winter, Kourou is **4 hours behind** Paris and Munich.\nIts working day starts around **noon, our time**.\n**Only shared window:** 1:30 – 4 p.m. (9:30 a.m. – noon in Kourou)."
 },
 {
  "q": "Who thinks the other side is hiding information?",
  "o": [
   "The French",
   "The Germans",
   "Both",
   "Nobody"
  ],
  "c": 2,
  "e": "**France:** export control slows sharing. **Germany:** the Betriebsrat.\nAnd often the French simply forget to share: it is rarely on purpose.\n**The reflex:** “Who on the other side needs this?”"
 },
 {
  "q": "For you, good Franco-German cooperation is above all…",
  "o": [
   "Listening before deciding",
   "Choosing our working language together",
   "Sharing information as a reflex",
   "Respecting each other’s rhythm"
  ],
  "c": -1,
  "e": ""
 },
 {
  "q": "What do you value most in your colleagues from across the border?",
  "o": [
   "Their expertise",
   "Their reliability",
   "Their agility",
   "Their different way of seeing the same problem"
  ],
  "c": -1,
  "e": ""
 },
 {
  "q": "Tomorrow, with my mixed team, I will…",
  "o": [
   "Ask which language people prefer for our meetings",
   "Ask myself “who on the other side needs this?” before sending",
   "Schedule our meetings in our shared time window",
   "Agree on how we decide, before deciding"
  ],
  "c": -1,
  "e": ""
 },
 {
  "q": "What makes Ariane 6 fly?",
  "o": [
   "The French lower stage",
   "The German upper stage",
   "A very long meeting",
   "Both stages, letting go at the same second"
  ],
  "c": 3,
  "e": ""
 }
];
const DEFAULT_TEXT = "How many people work at ArianeGroup?\nAbout 2,000\n*About 8,000\nAbout 15,000\nAbout 30,000\n> About 8,000 people, in France and in Germany.\n\nHow many of them are based in Germany?\nAbout 300\n*About 1,200\nAbout 4,000\nAbout 6,000\n> About 1,200 people: roughly 15 % of the group.\n> 85 % are in France.\n\nSCENE: 2. IGNITION – The Interview\nRight here. Right now.\n\nCONTENT: How do the French and the Germans see each other?\n- **The French** are often seen as **agile, fast, improvising**: a solution in five minutes.\n- **The Germans** are often seen as **planned, structured, reliable**: a plan that holds.\n- **Neither works alone:** a plan needs a plan B, and a plan B needs a plan.\nFrench agility + German rigour: what makes mixed teams strong.\n\nCONTENT: English: who speaks it best?\n- **Germany:** #4 worldwide, **very high level** (EF English Proficiency Index 2025).\n- **France:** #38, **moderate level**.\n- **On the ground:** it varies on both sides. More a question of **generation** than of nationality.\nAt ArianeGroup, few people are native speakers of the official language.\n\nCONTENT: Who decides?\n- **The French manager** decides quickly, says what to do… and may change the decision. **Seen from Germany:** unstable.\n- **The German manager** asks “What do you propose?”, consults… then the decision is final. **Seen from France:** a boss who doesn’t decide.\nSame goal: a good decision. Two different timings.\n\nSCENE: 3. LIFTOFF – The First Day\nThree weeks later. 7:00 a.m.\n9:30 a.m.\n11:00 a.m.\n\nSCENE: 4. ASCENT – Lost in Translation\nAfter lunch\n\nWhen are French and German teams most likely to be at their desks at the same time?\n7 – 9 a.m.\n*9:30 – 11 a.m.\n12 – 1:30 p.m.\n5 – 7 p.m.\n> **Germany:** early start (around 7 a.m.), short lunch, often gone by 4 p.m.\n> **France:** starts around 9 a.m., long lunch, stays until 6 or 7 p.m.\n> **Shared windows:** 9:30 – 11 a.m. and 1:30 – 4 p.m.\n\nAnd if we add Kourou? When can France, Germany and Kourou all meet (Paris / Munich time)?\n9:30 – 11 a.m.\n*1:30 – 4 p.m.\n5 – 7 p.m.\nNever\n> In winter, Kourou is **4 hours behind** Paris and Munich.\n> Its working day starts around **noon, our time**.\n> **Only shared window:** 1:30 – 4 p.m. (9:30 a.m. – noon in Kourou).\n\nWho thinks the other side is hiding information?\nThe French\nThe Germans\n*Both\nNobody\n> **France:** export control slows sharing. **Germany:** the Betriebsrat.\n> And often the French simply forget to share: it is rarely on purpose.\n> **The reflex:** “Who on the other side needs this?”\n\nSCENE: 5. MAX Q – The Big Meeting\nThe weekly team meeting\n\nSCENE: 6. ORBIT INSERTION – The Conclusion\n\nFor you, good Franco-German cooperation is above all…\nListening before deciding\nChoosing our working language together\nSharing information as a reflex\nRespecting each other’s rhythm\n\nWhat do you value most in your colleagues from across the border?\nTheir expertise\nTheir reliability\nTheir agility\nTheir different way of seeing the same problem\n\nTomorrow, with my mixed team, I will…\nAsk which language people prefer for our meetings\nAsk myself “who on the other side needs this?” before sending\nSchedule our meetings in our shared time window\nAgree on how we decide, before deciding\n\nWhat makes Ariane 6 fly?\nThe French lower stage\nThe German upper stage\nA very long meeting\n*Both stages, letting go at the same second\n\nCONTENT: Two Stages, One Rocket\nWe are not that different. And it’s exactly that bit that makes it fly.\nThank you! Danke! Merci!";

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
.btn.ghost{background:rgba(2,24,46,.6);color:#fff;border:1px solid var(--halo);box-shadow:none}
.btn.ghost:after{border-color:#fff}
.btn.back:after{display:none}
.btn.back:before{content:"";width:9px;height:9px;border-left:2px solid #fff;border-bottom:2px solid #fff;transform:rotate(45deg)}
body.host .btn.back{min-width:0}
.sub{animation:rise .5s ease}
@keyframes rise{from{opacity:0;transform:translateY(8px)}}
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
body.host .answer p{font-size:clamp(20px,1.6vw,30px);line-height:1.4}
body.host.longx #app{padding-top:16px;gap:12px}
body.host.longx .qtext{font-size:clamp(26px,3vw,40px)}
body.host.longx .tile{min-height:64px;padding:8px 18px}
body.host.longx .pct{font-size:34px}
body.host.longx .answer{padding:12px 18px}
body.host.longx .answer .ans{font-size:28px}
body.host.longx .answer p{font-size:clamp(17px,1.3vw,24px);margin-top:4px}
body.host .foot{display:flex;align-items:center;gap:28px;flex-wrap:wrap}
body.host:not(.screen) .foot{position:sticky;bottom:0;z-index:5;padding:16px 0 18px;margin-bottom:-18px;background:linear-gradient(to top,rgba(0,13,26,.97) 70%,rgba(0,13,26,0))}
body.host:not(.screen) .foot.endfoot{position:static;margin:0;padding:0;background:none}
.foot{display:grid;gap:14px}
.scene{flex:1;display:flex;flex-direction:column;justify-content:center;gap:22px;padding:6vh 0}
.scene h1{font-size:46px;text-shadow:0 0 40px rgba(127,220,255,.4)}
body.host .scene h1{font-size:clamp(64px,8.5vw,128px)}
.rule{width:140px;height:2px;background:linear-gradient(90deg,#f1fcff,var(--halo) 60%,rgba(127,220,255,0));box-shadow:0 0 16px rgba(127,220,255,.9)}
body.host .rule{width:260px;height:3px}
.fin{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;text-align:center;padding:2vh 0}
.fin .fr{height:34vh;max-height:320px;width:auto;flex:none;overflow:visible;filter:drop-shadow(0 0 8px rgba(127,220,255,.4))}
.fr-ol,.fr-fair,.fr-noz{fill:none;stroke:var(--halo);stroke-width:1.4;stroke-linejoin:round}
.fr-fair{fill:#00162b}.fr-noz{fill:#00162b}
.fl-o{fill:rgba(127,220,255,.35);stroke:var(--halo);stroke-width:1.2;stroke-linejoin:round}
.fl-i{fill:#f1fcff;opacity:.9}
.fr-join{stroke:#fff;stroke-width:2;stroke-linecap:round;opacity:0}
.fr-flame,.fr-join{transform-box:view-box}
.fr-flame{transform-origin:50px 289px}.fr-join{transform-origin:50px 171px}
.ftx{display:flex;flex-direction:column;align-items:center;gap:20px;min-width:0;max-width:100%}
.fin h1{font-size:56px;white-space:nowrap;line-height:.95;text-shadow:0 0 30px rgba(127,220,255,.45),0 0 6px rgba(127,220,255,.35)}
.fin .fmsg{font-size:20px;line-height:1.45;font-weight:600;max-width:30ch}
.fin .fthx{font-family:var(--disp);font-weight:600;font-size:24px;letter-spacing:.12em;text-transform:uppercase;color:var(--halo);text-shadow:0 0 12px rgba(127,220,255,.4)}
body.host .fin{flex-direction:row;text-align:left;gap:6vw}
body.host .fin .fr{height:min(70vh,760px);max-height:none}
body.host .ftx{align-items:flex-start;gap:clamp(20px,2.2vw,40px);max-width:58vw}
body.host .fin h1{font-size:clamp(64px,8.5vw,150px)}
body.host .fin .fmsg{font-size:clamp(24px,2.4vw,46px);max-width:24ch}
body.host .fin .fthx{font-size:clamp(28px,3vw,58px)}
@media (prefers-reduced-motion:no-preference){
.fin.play .fr-up{animation:frup 1.2s cubic-bezier(.2,.75,.25,1) .2s both}
.fin.play .fr-lo{animation:frlo 1.2s cubic-bezier(.2,.75,.25,1) .2s both}
.fin.play .fr-join{animation:frjoin 1.3s ease-out 1.35s both}
.fin.play .fr{animation:frglow 1.8s ease-out 1.35s both}
.fin.play .fr-flame{animation:frfl 2s ease-out 1.6s both}
.fin.play .ftx>*{animation:frtx .7s ease both}
.fin.play .ftx>:nth-child(1){animation-delay:1.5s}.fin.play .ftx>:nth-child(2){animation-delay:1.7s}
.fin.play .ftx>:nth-child(3){animation-delay:2s}.fin.play .ftx>:nth-child(4){animation-delay:2.5s}
}
@keyframes frup{from{transform:translateY(-80px);opacity:0}to{transform:none;opacity:1}}
@keyframes frlo{from{transform:translateY(100px);opacity:0}to{transform:none;opacity:1}}
@keyframes frjoin{0%{opacity:0;transform:scaleX(.2)}20%{opacity:1;transform:scaleX(1.7)}100%{opacity:0;transform:scaleX(1)}}
@keyframes frglow{0%{filter:drop-shadow(0 0 8px rgba(127,220,255,.4))}25%{filter:drop-shadow(0 0 26px rgba(170,235,255,.95))}100%{filter:drop-shadow(0 0 8px rgba(127,220,255,.4))}}
@keyframes frfl{0%{transform:scaleY(0);opacity:0}14%{transform:scaleY(1.35);opacity:1}28%{transform:scaleY(.85)}42%{transform:scaleY(1.18)}58%{transform:scaleY(.92)}76%{transform:scaleY(1.06)}100%{transform:none;opacity:1}}
@keyframes frtx{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.scene{gap:0}
.scene h1.nm{white-space:nowrap;margin-top:8px}
.scene .rule{margin-top:22px}
.scene .sub{margin-top:22px}
.ph span{white-space:nowrap}
.ph{display:flex;align-items:center;gap:12px;font-family:var(--disp);font-weight:600;font-size:24px;line-height:1;letter-spacing:.18em;text-transform:uppercase;color:var(--halo);text-shadow:0 0 12px rgba(127,220,255,.4)}
.ph .pi{flex:none;width:52px;height:52px;color:var(--halo);--g:3px;filter:drop-shadow(0 0 var(--g) rgba(127,220,255,.55))}
body.host .ph{gap:clamp(12px,1.35vw,26px);font-size:clamp(24px,3.125vw,60px)}
body.host .ph .pi{width:clamp(52px,5vw,96px);height:clamp(52px,5vw,96px);--g:6px;filter:drop-shadow(0 0 var(--g) rgba(127,220,255,.55))}
body.host .scene h1.nm{margin-top:clamp(8px,1.15vw,22px)}
body.host .scene .rule{margin-top:clamp(22px,1.8vw,34px)}
body.host .scene .sub{margin-top:clamp(22px,1.6vw,30px)}
.scene.play .ph span{animation:phtxt .6s ease .15s both}
.scene.play h1.nm{animation:nmin .6s ease .45s both}
@keyframes nmin{from{opacity:0}to{opacity:1}}
@keyframes phtxt{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:none}}
@keyframes phpeak{0%{filter:drop-shadow(0 0 0 rgba(127,220,255,0))}35%{filter:drop-shadow(0 0 calc(var(--g)*3) rgba(160,235,255,.95))}100%{filter:drop-shadow(0 0 var(--g) rgba(127,220,255,.55))}}
.pi .ig-fl{transform-box:view-box;transform-origin:24px 36.5px}
.pi .ig-sp{transform-box:view-box;transform-origin:24px 40px}
.pi .lo-pl{transform-box:view-box;transform-origin:21px 35px}
.pi .mq-a1,.pi .mq-a2,.pi .mq-a3{transform-box:view-box;transform-origin:24px 30px}
.pi .ob-mk{transform-box:view-box;transform-origin:37.63px 36.04px}
@media (prefers-reduced-motion:no-preference){
.scene.play .k-ignition{animation:phpeak 2.2s ease-out both}
.scene.play .ig-fl{animation:igfl 2.2s ease-out both}
.scene.play .ig-sp{animation:igsp 1.6s ease-out .1s both}
.scene.play .lo-mv{animation:lomv 2.1s cubic-bezier(.55,0,.25,1) .25s both}
.scene.play .lo-pl{animation:lopl 2.1s ease-out .25s both}
.scene.play .lo-st{animation:lost 1.5s ease-out .7s both}
.scene.play .k-maxq{animation:phpeak 2s ease-out .3s both}
.scene.play .mq-rk{animation:mqrk 1.5s linear .3s both}
.scene.play .mq-a1{animation:mqa 1.1s ease-out .3s both}
.scene.play .mq-a2{animation:mqa 1.1s ease-out .65s both}
.scene.play .mq-a3{animation:mqa 1.1s ease-out 1s both}
.scene.play .ob-mk.hit{animation:obmk .8s ease-out}
.scene.play .pi[data-fly] .fl-rk{opacity:0}
}
@keyframes igfl{0%{transform:scale(.5,0)}16%{transform:scale(1.12,1.4)}32%{transform:scale(.92,.8)}48%{transform:scale(1.08,1.3)}64%{transform:scale(.96,.88)}82%{transform:scale(1.04,1.12)}100%{transform:none}}
@keyframes igsp{0%{transform:scale(.2);opacity:0}35%{opacity:1}100%{transform:none;opacity:1}}
@keyframes lomv{0%{transform:translateY(13px)}100%{transform:none}}
@keyframes lopl{0%{transform:scaleY(.05)}35%{transform:scaleY(.7)}100%{transform:none}}
@keyframes lost{0%{opacity:0;transform:translateY(-9px)}30%{opacity:1}100%{opacity:1;transform:none}}
@keyframes mqrk{0%{transform:none}8%{transform:translate(-.45px,.2px)}16%{transform:translate(.45px,-.25px)}24%{transform:translate(-.5px,.25px)}32%{transform:translate(.5px,-.2px)}40%{transform:translate(-.4px,.3px)}48%{transform:translate(.4px,-.3px)}58%{transform:translate(-.3px,.2px)}68%{transform:translate(.25px,-.2px)}80%{transform:translate(-.12px,.1px)}100%{transform:none}}
@keyframes mqa{0%{transform:scale(.45);opacity:0}45%{transform:scale(1.1);opacity:1}100%{transform:none;opacity:1}}
@keyframes obmk{0%{transform:none}45%{transform:scale(1.8)}100%{transform:none}}
.sub{font-family:var(--disp);font-weight:600;font-size:22px;line-height:1.5;letter-spacing:.2em;text-transform:uppercase;color:var(--halo)}
body.host .sub{font-size:clamp(26px,2.8vw,42px)}
.info{display:grid;gap:18px}
.body p,.body li{font-size:17px;line-height:1.5}
body.host .body{padding:28px 32px}
body.host .body p,body.host .body li{font-size:clamp(20px,2vw,30px)}
.body p+p,.body p+ul,.body ul+p{margin-top:14px}
.body ul{list-style:none}
.body li{position:relative;padding-left:1.3em;margin-top:10px}
.body li:before{content:"";position:absolute;left:0;top:.55em;width:.5em;height:.5em;border-radius:50%;border:1.5px solid var(--halo);box-shadow:0 0 8px rgba(127,220,255,.7)}
a.btn{text-decoration:none}
.sub.cue{display:block;font-size:28px;line-height:1.15;letter-spacing:.14em;color:#d4f6ff;text-shadow:0 0 16px rgba(127,220,255,.6),0 0 4px rgba(127,220,255,.45);font-variant-numeric:tabular-nums;animation:none}
body.host .sub.cue{font-size:clamp(36px,3.9vw,74px)}
.cue .tw{white-space:nowrap}
.cue .cl{display:inline-grid;vertical-align:top}
.cue .ca,.cue .cb{grid-area:1/1;transition:opacity .45s ease}
.cue .cb{opacity:0}
.cue.sw .ca{opacity:0}
.cue.sw .cb{opacity:1}
.cue .ck{width:1em;height:1em;vertical-align:-.14em;margin-right:.4em;fill:none;stroke:var(--halo);stroke-width:1.8;stroke-linecap:round;filter:drop-shadow(0 0 6px rgba(127,220,255,.6))}
.cue .tm,.cue .ct{color:#fff}
.cue .ct.roll{display:inline-block;position:relative;overflow:hidden;vertical-align:top;height:1.15em;line-height:1.15;text-align:right}
.cue .ct.roll .rw{display:block}
.cue .ct.roll .rw.out{position:absolute;left:0;right:0;top:0}
.cue .pl{transition:opacity .3s ease}
@media (prefers-reduced-motion:no-preference){
.cue .ct.roll .rw.in{animation:rwin .42s cubic-bezier(.2,.8,.25,1) both}
.cue .ct.roll .rw.out{animation:rwout .42s cubic-bezier(.5,0,.75,.4) both}
}
@keyframes rwin{from{transform:translateY(-100%);opacity:0}to{transform:none;opacity:1}}
@keyframes rwout{from{transform:none;opacity:1}to{transform:translateY(100%);opacity:0}}
.scene .shd{position:relative}
.scene .shd>.sub{position:absolute;left:0;right:0;top:100%}
.scene{padding-bottom:calc(6vh + 90px)}
body.host .scene{padding-bottom:calc(6vh + 150px)}
@media (prefers-reduced-motion:no-preference){
.cue.in{animation:cuein .7s cubic-bezier(.2,.7,.25,1) var(--cd,0ms) both;transform-origin:0 50%}
.cue .flk{animation:cflk .35s ease-out}
}
@keyframes cuein{from{opacity:0;transform:scale(1.12)}to{opacity:1;transform:none}}
@keyframes cflk{from{opacity:.25}to{opacity:1}}
.info{display:flex;flex-direction:column;justify-content:flex-start;gap:20px;padding-top:2vh}
.info h1.iq{font-size:34px;line-height:1.08;text-shadow:0 0 30px rgba(127,220,255,.4),0 0 6px rgba(127,220,255,.3)}
body.host .info h1.iq{font-size:clamp(40px,3.6vw,72px)}
.info .rule{margin:2px 0 6px}
.info .body{padding:20px 22px}
body.host .info .body{padding:clamp(18px,1.6vw,32px) clamp(22px,2.2vw,44px)}
.info .body li,.info .body p{font-size:18px;line-height:1.42;color:rgba(255,255,255,.86)}
body.host .info .body li,body.host .info .body p{font-size:clamp(21px,1.75vw,34px)}
.info .body li{margin-top:.55em}
.info .body li:first-child{margin-top:0}
.info .body strong{color:#fff;font-weight:700}
.info .body p.concl{margin-top:.9em;padding-top:.75em;border-top:1px solid rgba(127,220,255,.35);font-family:var(--disp);font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--halo);text-shadow:0 0 12px rgba(127,220,255,.4);font-size:21px;line-height:1.25}
body.host .info .body p.concl{font-size:clamp(25px,2.1vw,40px)}
.answer p strong{color:#fff}
@media (prefers-reduced-motion:no-preference){.info .body.in{animation:infoin .6s ease both}}
@keyframes infoin{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.ctrl{display:none}
body.host .ctrl{display:grid;grid-template-columns:1fr 1fr;gap:28px;align-items:center}
.ctrl p{margin:6px 0 14px}
.remote{display:flex;gap:18px;align-items:center}
.qr.small{padding:8px;flex:none}
.screen .btn,.screen .ctrl,.screen .part{display:none!important}
.fs{position:fixed;top:14px;right:14px;z-index:5;font:600 13px var(--disp);letter-spacing:.12em;text-transform:uppercase;color:#fff;background:rgba(2,24,46,.7);border:1px solid var(--line);border-radius:2px;padding:8px 14px;cursor:pointer;opacity:.55}
.fs:hover{opacity:1}
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
.rpoll{display:grid;gap:6px;margin-top:10px}
.rp{position:relative;display:flex;justify-content:space-between;gap:12px;padding:7px 12px;border:1px solid rgba(127,220,255,.25);border-radius:3px;overflow:hidden}
.rp i{position:absolute;left:0;top:0;bottom:0;background:rgba(127,220,255,.22)}
.rp em,.rp b{position:relative;font-style:normal;font-size:16px}
.rp b{font-family:var(--disp)}
@media print{
  body{background:#fff!important;color:#0a1b33!important}
  body *{color:#0a1b33!important;text-shadow:none!important;box-shadow:none!important}
  .halo,.stars,canvas,.foot,.btn,.part{display:none!important}
  img{filter:brightness(0)!important}
  .card.recap{border:0!important;background:#fff!important;padding:0!important}
  .rrow{break-inside:avoid;border-bottom:1px solid #cfd8e6!important}
  .rp{border-color:#9db4d6!important}.rp i{background:#cfe3f7!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
.wait{width:64px;height:64px;margin:0 auto 16px;border-radius:50%;border:2px solid rgba(127,220,255,.2);border-top-color:var(--halo);box-shadow:0 0 22px rgba(127,220,255,.4);animation:spin 1.6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.wait{animation:none}.scene.play h1.nm,.scene.play .ph span{animation:none}.fill,.prg{transition:none}}
`;

function client(DEFAULT_QUIZ, HAS_LOGO, DEFAULT_TEXT) {
  const L = ['A', 'B', 'C', 'D'], CIRC = 326.73;
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = $('#app');
  const params = new URLSearchParams(location.search);
  const demo = params.get('demo');
  const route = location.pathname.replace(/\/+$/, '');
  const isScreen = demo ? demo.indexOf('screen') === 0 : route === '/screen';
  const isHost = isScreen || (demo ? demo.indexOf('host') === 0 : route === '/host');
  // grand écran : mise en page "salle" ; sur un téléphone, l'animateur garde la mise en page mobile (télécommande)
  if (isScreen || (isHost && innerWidth > 700)) document.body.classList.add('host');
  if (isScreen) document.body.classList.add('screen');
  if (!isScreen && !demo) { // raccourcis clavier de l'animateur : → ou Espace = suite, ← = retour
    document.addEventListener('keydown', e => {
      if (!isHost || e.altKey || e.ctrlKey || e.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName || '')) return;
      const go = id => { const b = document.getElementById(id); if (b && b.offsetParent) { e.preventDefault(); b.click(); return true; } return false; };
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { go('nx') || go('rv') || go('go'); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go('bk');
    });
  }
  const KEY = isHost ? 'qz_host' : 'qz_player';
  let S = null, es = null, deadline = 0, err = '', view = '';
  let sess = null;
  if (!demo) { try { sess = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {} }
  if (!demo && isScreen) sess = params.get('c') && params.get('k') ? { code: params.get('c'), view: params.get('k') } : null;
  else if (!demo && isHost && params.get('c') && params.get('t')) { // lien "télécommande" scanné depuis l'ordinateur
    sess = { code: params.get('c'), token: params.get('t') };
    try { localStorage.setItem(KEY, JSON.stringify(sess)); } catch (e) {}
    history.replaceState(null, '', '/host');
  }
  const save = v => { if (isScreen) return; try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch (e) {} };

  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Erreur');
    return j;
  }
  function connect() {
    if (es) es.close();
    es = new EventSource('/api/events?code=' + encodeURIComponent(sess.code) + (isScreen ? '&view=' + sess.view : isHost ? '&token=' + sess.token : '&id=' + sess.id));
    es.addEventListener('state', e => { S = JSON.parse(e.data); deadline = Date.now() + (S.rem || 0); render(); });
    es.addEventListener('gone', () => { es.close(); save(null); sess = null; S = null; err = isScreen ? 'This game is over. Reopen the projection screen from the host page.' : 'Game over or not found.'; render(); });
  }
  const act = a => { if (!demo && !isScreen) post('/api/host', { code: sess.code, token: sess.token, action: a }).catch(() => {}); };

  /* format texte : question, réponses (la bonne commence par *), puis "> explication" */
  function parseQuiz(t) {
    return t.split(/\n\s*\n/).map(b => b.split('\n').map(l => l.trim()).filter(Boolean)).filter(l => l.length).map(l => {
      let m = l[0].match(/^sc[eèé]ne\s*:\s*(.*)$/i); // « SCENE: … » (ou SCÈNE)
      if (m) return { t: 'scene', title: m[1], sub: l.slice(1).join('\n') };
      m = l[0].match(/^(?:content|contenu)\s*:\s*(.*)$/i);
      if (m) return { t: 'info', title: m[1], lines: l.slice(1) };
      let c = -1; const o = [], e = [];
      l.slice(1).forEach(x => {
        if (x[0] === '>') { e.push(x.slice(1).trim()); return; }
        if (x[0] === '*') { c = o.length; x = x.slice(1).trim(); }
        o.push(x);
      });
      return { t: 'q', q: l[0], o, c, e: e.join('\n') }; // une ligne « > » = une ligne d’explication
    }).filter(x => x.t === 'scene' ? x.title : x.t === 'info' ? (x.title || x.lines.length) : (x.o.length >= 2 && x.o.length <= 4));
  }
  const quizText = () => DEFAULT_TEXT;

  const header = () => '<header class="top">' + (HAS_LOGO ? '<img class="logo" src="/logo" alt="">' : '') + '<span class="evt">' + esc((S && S.title) || 'Live quiz') + '</span></header>';
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
        '<span class="ltr">' + L[i] + '</span><span class="txt">' + esc(t) + (o.picked === i ? '<span class="tag">Your answer</span>' : '') + '</span>' +
        '<span class="pct" data-pct="' + i + '"></span></' + tag + '>';
    }).join('') + '</div>';
  }
  function answerCard() {
    const Q = S.question;
    if (S.correct >= 0) return '<div class="answer"><div class="lbl">Correct answer</div><div class="ans">' + L[S.correct] + ' · ' + esc(Q.o[S.correct]) + '</div>' + (S.expl ? '<p>' + rich(S.expl) + '</p>' : '') + '</div>';
    return S.expl ? '<div class="answer"><div class="lbl">Key takeaway</div><p>' + rich(S.expl) + '</p></div>' : '';
  }
  const qhead = withRing => '<div class="qhead"><div><div class="kicker">Question ' + (S.q + 1) + ' / ' + S.total + '</div><div class="qtext">' + esc(S.question.q) + '</div></div>' + (withRing && !S.poll ? ring() : '') + '</div>';
  /* synthèse de fin : quiz = % de bonnes réponses ; sondage = réponses classées par pourcentage décroissant */
  const pc = (n, tot) => tot ? Math.round(n / tot * 100) : 0;
  function recapRows() {
    return (S.recap || []).filter(Boolean).map((r, i) => {
      const head = '<span>' + (i + 1) + '. ' + esc(r.q) + '<div class="muted">' + plural(r.n, 'answer') + (r.poll ? ' · poll' : '') + '</div>';
      if (r.poll && r.o) {
        const rows = r.o.map((x, j) => ({ t: x.t, n: x.n, j })).sort((a, b) => b.n - a.n || a.j - b.j);
        return '<div class="rrow poll"><span>' + head.slice(6) + '<div class="rpoll">' + rows.map(x => '<div class="rp"><i style="width:' + pc(x.n, r.n) + '%"></i><em>' + esc(x.t) + '</em><b>' + pc(x.n, r.n) + ' %</b></div>').join('') + '</div></span></div>';
      }
      return '<div class="rrow">' + head + '</span><b>' + (r.good == null ? 'Poll' : pc(r.good, r.n) + ' %') + '</b></div>';
    }).join('');
  }
  function downloadRecap() {
    const q = v => '"' + String(v).replace(/"/g, '""') + '"', L2 = ['A', 'B', 'C', 'D', 'E', 'F'];
    const lines = [['No.', 'Type', 'Question', 'Answer', 'Count', 'Percentage', 'Correct answer'].map(q).join(';')];
    (S.recap || []).filter(Boolean).forEach((r, i) => {
      let rows = (r.o || []).map((x, j) => ({ t: x.t, n: x.n, j }));
      if (r.poll) rows.sort((a, b) => b.n - a.n || a.j - b.j);
      rows.forEach(x => lines.push([i + 1, r.poll ? 'Poll' : 'Quiz', r.q, (L2[x.j] || '') + '. ' + x.t, x.n, pc(x.n, r.n) + ' %', !r.poll && x.j === r.c ? 'yes' : ''].map(q).join(';')));
    });
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'quiz-summary-' + ((S && S.code) || '') + '.csv'; document.body.appendChild(a); a.click(); a.remove();
  }

  const PHASE_ICONS = {
    "IGNITION": "<svg class=\"pi k-ignition\" viewBox=\"0 0 48 48\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path stroke-width=\"2\" d=\"M24 4 C27.575 6 29.5 9 29.5 12 V31 H18.5 V12 C18.5 9 20.425 6 24 4 Z\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M18.5 15 H29.5 M24 24 V31\"/><path stroke-width=\"2\" d=\"M19.8 31 L19.1 34 H23.5 L22.8 31 M25.2 31 L24.5 34 H28.9 L28.2 31\"/><g class=\"ig-fl\"><path stroke-width=\"2\" d=\"M19.4 36.5 C19.4 39.5 20.6 41.5 21.3 43 C22 41.5 23.2 39.5 23.2 36.5\"/><path stroke-width=\"2\" d=\"M24.8 36.5 C24.8 39.5 26 41.5 26.7 43 C27.4 41.5 28.6 39.5 28.6 36.5\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M21.3 37 V39.5 M26.7 37 V39.5\"/></g><path stroke-width=\"2\" d=\"M5 46 H43\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M15.5 41 V46 M32.5 41 V46\"/><g class=\"ig-sp\"><path stroke-width=\"2\" d=\"M13 37 L10.5 35.5 M35 37 L37.5 35.5 M11 42 L8.5 42 M37 42 L39.5 42\"/></g></svg>",
    "LIFTOFF": "<svg class=\"pi k-liftoff\" viewBox=\"0 0 48 48\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><g class=\"lo-st\"><path stroke-width=\"1\" opacity=\".5\" d=\"M12 10 V16 M10 19 V24\"/></g><g class=\"lo-mv\"><path stroke-width=\"2\" d=\"M21 3 C23.6 5 25.0 8 25.0 11 V29 H17.0 V11 C17.0 8 18.4 5 21 3 Z\"/><path stroke-width=\"2\" d=\"M18.5 29 L17.8 32 H24.2 L23.5 29\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M17 14 H25\"/><g class=\"lo-pl\"><path stroke-width=\"2\" d=\"M17.5 35 C16.5 39.5 13.5 42.5 9 44.5 M24.5 35 C25.5 39.5 28.5 42.5 33 44.5\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M21 35 V41\"/></g></g><path stroke-width=\"2\" d=\"M4 46 H31\"/><path stroke-width=\"2\" d=\"M38 8 V46\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M43 12 V46 M38 15 L43 21 L38 27 L43 33 L38 39 L43 45\"/><path stroke-width=\"2\" d=\"M38 17 H32\"/></svg>",
    "ASCENT": "<svg class=\"pi k-ascent\" viewBox=\"0 0 48 48\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" data-fly=\"ascent\"><path stroke-width=\"2\" stroke-dasharray=\"0 4\" d=\"M5 45 C8 38 13 32 19.5 27.5\" class=\"as-trail\"/><g transform=\"translate(33 15) rotate(48)\" class=\"fl-rk\"><path stroke-width=\"2\" d=\"M0 -12 C2.3 -10 3.5 -7.5 3.5 -4.5 V8 H-3.5 V-4.5 C-3.5 -7.5 -2.3 -10 0 -12 Z\"/><path stroke-width=\"2\" d=\"M-2 8 L-2.7 10.6 H2.7 L2 8\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M-3.5 -1.5 H3.5\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M-1.6 13.5 Q0 18 1.6 13.5\" class=\"as-fl\"/></g><path stroke-width=\"1\" opacity=\".5\" d=\"M3 45 H21\"/><path stroke-width=\"2\" d=\"M11.3 33.2 L14.3 36.2\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M14.3 36.2 L18 40 H24\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M40 33 V39 M37 36 H43\"/></svg>",
    "MAX Q": "<svg class=\"pi k-maxq\" viewBox=\"0 0 48 48\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><g class=\"mq-rk\"><path stroke-width=\"2\" d=\"M24 17 C26.275 19 27.5 22 27.5 25 V39 H20.5 V25 C20.5 22 21.725 19 24 17 Z\"/><path stroke-width=\"2\" d=\"M22.0 39 L21.3 42 H26.7 L26.0 39\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M20.5 27 H27.5\"/></g><g class=\"mq-a1\"><path stroke-width=\"2\" d=\"M16 24 Q24 6 32 24\"/></g><g class=\"mq-a2\"><path stroke-width=\"1\" opacity=\".5\" d=\"M11.5 29 Q24 -4 36.5 29\"/></g><g class=\"mq-a3\"><path stroke-width=\"1\" opacity=\".5\" stroke-dasharray=\"1 3\" d=\"M7 34 Q24 -14 41 34\"/></g></svg>",
    "ORBIT INSERTION": "<svg class=\"pi k-orbit\" viewBox=\"0 0 48 48\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" data-fly=\"orbit\"><path stroke-width=\"2\" d=\"M4 32 A15 15 0 0 1 19 47\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M4 29 A18 18 0 0 1 22 47\"/><path stroke-width=\"2\" d=\"M2.53 14.53 L3.48 14.24 L4.42 13.99 L5.38 13.76 L6.34 13.57 L7.31 13.42 L8.28 13.30 L9.25 13.21 L10.22 13.15 L11.19 13.13 L12.16 13.14 L13.13 13.19 L14.10 13.27 L15.06 13.39 L16.01 13.53 L16.95 13.72 L17.89 13.93 L18.82 14.18 L19.74 14.46 L20.64 14.77 L21.53 15.12 L22.41 15.49 L23.28 15.90 L24.12 16.34 L24.95 16.81 L25.76 17.30 L26.56 17.83 L27.33 18.38 L28.08 18.97 L28.81 19.58 L29.51 20.21 L30.20 20.87 L30.85 21.56 L31.49 22.26 L32.09 23.00 L32.67 23.75 L33.22 24.52 L33.75 25.32 L34.24 26.13 L34.71 26.96 L35.14 27.81 L35.55 28.67 L35.92 29.55 L36.26 30.45 L36.57 31.35 L36.85 32.27 L37.09 33.20 L37.30 34.14 L37.48 35.09 L37.63 36.04 L37.74 37.00 L37.82 37.96 L37.86 38.93 L37.87 39.90 L37.84 40.88 L37.79 41.85 L37.69 42.82 L37.57 43.79 L37.41 44.75 L37.27 45.48\" class=\"ob-path\"/><g class=\"ob-mk\"><circle stroke-width=\"1\" opacity=\".5\" cx=\"37.63\" cy=\"36.04\" r=\"3.6\"/><path stroke-width=\"2\" d=\"M37.63 36.04 h0.01\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M43.03 36.04 H44.43 M32.23 36.04 H30.83 M37.63 30.64 V29.24 M37.63 41.44 V42.84\"/></g><g transform=\"translate(16.44 13.61) rotate(-79.2)\" class=\"fl-rk\"><path stroke-width=\"2\" d=\"M0 -6.5 C1.8 -5.2 2.7 -3.6 2.7 -1.8 V4.5 H-2.7 V-1.8 C-2.7 -3.6 -1.8 -5.2 0 -6.5 Z\"/><path stroke-width=\"2\" d=\"M-1.5 4.5 L-2 6.8 H2 L1.5 4.5\"/></g></svg>",
    "COUNTDOWN": "<svg class=\"pi k-countdown\" viewBox=\"0 0 48 48\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path stroke-width=\"2\" d=\"M22 6 C24.6 8 26.0 11 26.0 14 V36 H18.0 V14 C18.0 11 19.4 8 22 6 Z\"/><path stroke-width=\"2\" d=\"M19.5 36 L18.8 39 H25.2 L24.5 36\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M18 18 H26\"/><path stroke-width=\"2\" d=\"M4 45 H44\"/><path stroke-width=\"2\" d=\"M36 4 V45\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M41 9 V45 M36 12 L41 18 L36 24 L41 30 L36 36 L41 42\"/><path stroke-width=\"2\" d=\"M36 15 H26\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M36 27 H26\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M17 45 V41 M27 45 V41\"/><path stroke-width=\"2\" d=\"M8 4 A4.5 4.5 0 1 1 3.5 8.5\"/><path stroke-width=\"1\" opacity=\".5\" d=\"M8 8.5 V6.5 M8 8.5 H9.8\"/></svg>"
  };
  let sceneSeen = '';
  const REDUCE = !!(window.matchMedia && matchMedia('(prefers-reduced-motion:reduce)').matches);
  // Indications de temps : l’heure défile jusqu’à la bonne heure, les semaines se comptent, puis tout se fige
  const NUMW = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  let cueKey = '', cueMem = { scene: '', min: null };
  const ICON_END = { IGNITION: 2200, LIFTOFF: 2350, ASCENT: 2650, 'MAX Q': 2300, 'ORBIT INSERTION': 3300 }; // fin de l’animation de chaque icône (ms)
  const fmtTime = (min, ap) => {
    min = ((Math.round(min) % 1440) + 1440) % 1440;
    const h = Math.floor(min / 60), m = String(min % 60).padStart(2, '0');
    if (!ap) return h + ':' + m;
    return ((h + 11) % 12 + 1) + ':' + m + (ap === 1 ? (h < 12 ? ' a.m.' : ' p.m.') : (h < 12 ? ' am' : ' pm'));
  };
  const numWord = (n, cap) => { const w = NUMW[n] || String(n); return cap ? w[0].toUpperCase() + w.slice(1) : w; };
  const CLOCK = '<svg class="ck" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line class="hh" x1="12" y1="12" x2="12" y2="7.2"/><line class="mh" x1="12" y1="12" x2="12" y2="4.6"/></svg>';
  function cueHTML(scene, text, first) {
    const key = scene + '|' + text, fresh = cueKey !== key; cueKey = key;
    const re = /(\b\d{1,2}[:h]\d{2}(?:\s*[ap]\.?\s?m\.?)?)|(\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\b)(\s+)(days?|weeks?|months?|years?)\b/gi;
    let out = '', outA = '', outB = '', last = 0, mm, timeMin = null, counting = false;
    const prev = cueMem.scene === scene ? cueMem.min : null;
    while ((mm = re.exec(text))) {
      const gap = esc(text.slice(last, mm.index)); out += gap; outA += gap; last = re.lastIndex;
      if (mm[1]) {
        const t = /(\d{1,2})[:h](\d{2})(?:\s*([ap])(\.)?)?/i.exec(mm[1]);
        let h = +t[1] % (t[3] ? 12 : 24); if (t[3] && /p/i.test(t[3])) h += 12;
        const to = h * 60 + +t[2], ap = t[3] ? (t[4] ? 1 : 2) : 0; timeMin = to;
        const from = prev != null && prev !== to ? prev : to - 90;
        const tw = '<span class="tw">' + CLOCK + '<span class="tm" data-to="' + to + '" data-from="' + from + '" data-ap="' + ap + '">' + esc(fmtTime(to, ap)) + '</span></span>';
        out += tw; outB += tw;
      } else {
        const w = mm[2], n = /^\d/.test(w) ? +w : NUMW.indexOf(w.toLowerCase());
        if (n > 1 && n <= 12) counting = true;
        const ctx = '<span class="ct" data-n="' + n + '" data-w="' + (/^\d/.test(w) ? 0 : 1) + '" data-cap="' + (w[0] !== w[0].toLowerCase() ? 1 : 0) + '">' + esc(w) + '</span>' + esc(mm[3]) + '<span class="cu" data-u="' + esc(mm[4].replace(/s$/i, '')) + '">' + esc(mm[4]) + '</span>';
        out += ctx; outA += ctx;
      }
    }
    const tail = esc(text.slice(last)); out += tail; outA += tail;
    cueMem = { scene, min: timeMin != null ? timeMin : prev };
    const go = fresh && !REDUCE, br = x => x.trim().replace(/\n/g, '<br>');
    if (counting && timeMin != null) { // « Three weeks later. 7:00 a.m. » : d’abord les semaines seules, puis elles sont remplacées par l’heure
      if (!go) return '<div class="sub cue"><span class="cx">' + br(outB) + '</span></div>';
      return '<div class="sub cue swap in" data-go="1" style="--cd:' + (+first || 0) + 'ms"><span class="cl"><span class="ca">' + br(outA) + '</span><span class="cb">' + br(outB) + '</span></span></div>';
    }
    const cont = go && timeMin != null && prev != null && !counting && !/\S/.test(out.replace(/<span class="tw">[\s\S]*?<\/span><\/span>/g, '').replace(/<[^>]+>/g, '')); // heure seule qui suit une heure : elle continue sans réapparaître
    return '<div class="sub cue' + (go ? (cont ? ' cont' : ' in') + '" data-go="1" style="--cd:' + (+first || 0) + 'ms' : '') + '"><span class="cx">' + br(out) + '</span></div>';
  }
  function setClock(el, min) {
    const ck = el.querySelector('.ck'); if (!ck) return;
    ck.querySelector('.hh').setAttribute('transform', 'rotate(' + ((min % 720) / 2) + ' 12 12)');
    ck.querySelector('.mh').setAttribute('transform', 'rotate(' + ((min % 60) * 6) + ' 12 12)');
  }
  function cueAnim() {
    document.querySelectorAll('.cue').forEach(cue => {
      const tm = cue.querySelector('.tm'); if (tm) setClock(cue, +tm.dataset.to);
      if (!cue.dataset.go) return; delete cue.dataset.go;
      const d0 = parseInt(getComputedStyle(cue).getPropertyValue('--cd')) || 0;
      const flick = el => { el.classList.remove('flk'); void el.offsetWidth; el.classList.add('flk'); };
      const tws = [...cue.querySelectorAll('.tw')];
      let t = d0 + 700; // laisser l’apparition se terminer
      const cts = [...cue.querySelectorAll('.ct')].filter(ct => +ct.dataset.n > 1 && +ct.dataset.n <= 12);
      cts.forEach(ct => { // One week… Two weeks… Three weeks later
        const n = +ct.dataset.n, cu = ct.nextElementSibling && ct.nextElementSibling.classList.contains('cu') ? ct.nextElementSibling : null;
        const word = k => +ct.dataset.w ? numWord(k, +ct.dataset.cap) : String(k);
        let wmax = 0; // largeur fixe = le mot le plus large : « weeks later » ne bouge jamais
        for (let k = 1; k <= n; k++) { ct.textContent = word(k); wmax = Math.max(wmax, ct.getBoundingClientRect().width); }
        ct.classList.add('roll'); ct.style.width = Math.ceil(wmax + 2) + 'px';
        ct.innerHTML = '<span class="rw">' + esc(word(1)) + '</span>';
        const pl = k => { if (cu) cu.innerHTML = esc(cu.dataset.u) + '<span class="pl"' + (k > 1 ? '' : ' style="opacity:0"') + '>s</span>'; }; // le « s » garde sa place
        pl(1);
        const show = k => { // le chiffre suivant descend du haut, le précédent sort par le bas (comme un sélecteur iPhone)
          if (!ct.isConnected) return;
          const old = ct.querySelector('.rw:not(.out)'), nw = document.createElement('span');
          nw.className = 'rw in'; nw.textContent = word(k); ct.appendChild(nw);
          if (old) { old.classList.add('out'); setTimeout(() => old.remove(), 450); }
          pl(k);
        };
        for (let k = 2; k <= n; k++) setTimeout(() => show(k), t + (k - 2) * 650 + 300);
        t += (n - 1) * 600 + 700;
      });
      tws.forEach(w => { // puis l’heure apparaît et défile jusqu’à l’heure de la scène
        const el = w.querySelector('.tm'), from = +el.dataset.from, to = +el.dataset.to, ap = +el.dataset.ap, dur = Math.min(2000, 900 + Math.abs(to - from) * 6);
        el.textContent = fmtTime(from, ap); setClock(cue, from);
        setTimeout(() => {
          cue.classList.add('sw'); // les semaines s’effacent, l’heure prend leur place
          const t0 = performance.now() + (cue.classList.contains('swap') ? 350 : 0); let shown = '';
          const fr = now => {
            if (!el.isConnected) return;
            const k = Math.max(0, Math.min(1, (now - t0) / dur)), e = 1 - Math.pow(1 - k, 3), cur = Math.round(from + (to - from) * e);
            const txt = fmtTime(cur, ap); if (txt !== shown) { el.textContent = shown = txt; setClock(cue, cur); }
            if (k < 1) requestAnimationFrame(fr); else { el.textContent = fmtTime(to, ap); setClock(cue, to); }
          };
          requestAnimationFrame(fr);
        }, cts.length ? t : cue.classList.contains('cont') ? 120 : d0 + 500);
      });
    });
  }

  function flights() { // Ascent et Orbit : le lanceur suit une trajectoire, puis se fige à sa place d’origine
    if (REDUCE) return;
    document.querySelectorAll('.scene.play .pi[data-fly]').forEach(svg => {
      if (svg.dataset.go) return; svg.dataset.go = '1';
      const rk = svg.querySelector('.fl-rk'); if (!rk) return;
      const fin = rk.getAttribute('transform'), m = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)\s*\)/.exec(fin);
      if (!m) { rk.style.opacity = '1'; return; }
      const fx = +m[1], fy = +m[2], kind = svg.dataset.fly, num = d => (d.match(/-?\d+\.?\d*/g) || []).map(Number);
      let pts = [];
      if (kind === 'orbit') {
        const n = num(svg.querySelector('.ob-path').getAttribute('d')), all = [];
        for (let i = 0; i + 1 < n.length; i += 2) all.push([n[i], n[i + 1]]);
        let k = 0, best = 1e9;
        all.forEach((q, i) => { const dd = Math.hypot(q[0] - fx, q[1] - fy); if (dd < best) { best = dd; k = i; } });
        pts = all.slice(k).reverse(); pts[pts.length - 1] = [fx, fy]; // du bas de l’orbite jusqu’à la position finale
      } else {
        const b = num(svg.querySelector('.as-trail').getAttribute('d'));
        for (let i = 0; i <= 14; i++) {
          const t = i / 14, u = 1 - t;
          pts.push([u*u*u*b[0] + 3*u*u*t*b[2] + 3*u*t*t*b[4] + t*t*t*b[6], u*u*u*b[1] + 3*u*u*t*b[3] + 3*u*t*t*b[5] + t*t*t*b[7]]);
        }
        for (let i = 1; i <= 6; i++) pts.push([b[6] + (fx - b[6]) * i / 6, b[7] + (fy - b[7]) * i / 6]);
      }
      const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const T = L[L.length - 1];
      const at = s => { s = Math.max(0, Math.min(T, s)); let i = 1; while (i < L.length - 1 && L[i] < s) i++; const f = (s - L[i - 1]) / ((L[i] - L[i - 1]) || 1); return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f]; };
      const dur = kind === 'orbit' ? 3000 : 2400, delay = 250, fl = svg.querySelector('.as-fl'), mk = svg.querySelector('.ob-mk');
      const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2, t0 = performance.now();
      const done = () => { rk.setAttribute('transform', fin); rk.style.opacity = '1'; if (fl) fl.removeAttribute('transform'); };
      const frame = now => {
        if (!svg.isConnected) return;
        const t = Math.max(0, Math.min(1, (now - t0 - delay) / dur));
        if (t >= 1) return done();
        const s = ease(t) * T, a = at(s - .8), c = at(s), z = at(s + .8);
        rk.setAttribute('transform', 'translate(' + c[0].toFixed(2) + ' ' + c[1].toFixed(2) + ') rotate(' + (Math.atan2(z[0] - a[0], -(z[1] - a[1])) * 180 / Math.PI).toFixed(1) + ')');
        rk.style.opacity = String(Math.min(1, t * 12));
        if (fl) fl.setAttribute('transform', 'translate(0 13.5) scale(1 ' + (1 + .5 * Math.sin(now / 40) * (1 - t * .6)).toFixed(2) + ') translate(0 -13.5)');
        if (mk && !mk.classList.contains('hit') && Math.hypot(c[0] - 37.63, c[1] - 36.04) < 3) mk.classList.add('hit');
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }
  const sceneHead = title => { // « 2. IGNITION – The Interview » → repère de phase + nom de scène
    const m = /^\s*(\d+)\s*[.·:)]\s*(.+?)\s+[–—-]\s+(.+?)\s*$/.exec(String(title));
    if (!m) return null;
    const ph = m[2].toUpperCase(), ic = PHASE_ICONS[ph];
    return { n: m[1], ph, name: m[3], ic };
  };
  function fitScene() { // le nom de scène reste sur une ligne : on réduit seulement s'il déborde
    document.querySelectorAll('.scene .ph').forEach(h => { // même règle pour la ligne « N · PHASE » (ex. ORBIT INSERTION sur téléphone)
      h.style.fontSize = '';
      const w = h.scrollWidth, avail = h.clientWidth;
      if (avail > 0 && w > avail) h.style.fontSize = Math.floor(parseFloat(getComputedStyle(h).fontSize) * avail / w * 0.98) + 'px';
    });
    document.querySelectorAll('.scene h1.nm, .fin h1.fit').forEach(h => {
      h.style.fontSize = '';
      const avail = h.parentElement.clientWidth, w = h.scrollWidth;
      if (avail > 0 && w > avail) h.style.fontSize = Math.floor(parseFloat(getComputedStyle(h).fontSize) * avail / w * 0.99) + 'px';
    });
  }
  window.addEventListener('resize', fitScene);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitScene);
  const nextLabel = () => ({ sub: 'Next cue', content: 'Show the content', final: 'Final screen', q: 'Start the question', scene: 'Next scene', info: 'Next topic', end: 'Finish' })[S.next] || 'Next';
  function slide() {
    const d = S.slide || {};
    if (d.t === 'scene') {
      const hd = sceneHead(d.title);
      const play = sceneSeen !== d.title; sceneSeen = d.title; // l’animation ne se joue qu’à l’apparition de la scène, pas à chaque indication
      const sub = d.sub ? cueHTML(d.title, d.sub, play && hd ? (ICON_END[hd.ph] || 800) + 400 : 0) : ''; // l’indication n’arrive qu’une fois l’icône figée
      if (!hd) return '<div class="scene"><div class="shd"><h1>' + esc(d.title) + '</h1><div class="rule"></div>' + sub + '</div></div>';
      return '<div class="scene' + (play ? ' play' : '') + '"><div class="shd"><p class="ph">' + (hd.ic || '') + '<span>' + esc(hd.n) + ' · ' + esc(hd.ph) + '</span></p><h1 class="nm">' + esc(hd.name) + '</h1><div class="rule"></div>' + sub + '</div></div>';
    }
    if (d.t === 'info' && d.fin) { // écran final : la fusée franco-allemande se rassemble, puis se fige
      const L = (d.lines || []).map(l => l.replace(/^[-•]\s*/, '')), thx = L.length > 1 ? L.pop() : '';
      const k = 'fin|' + d.title, play = sceneSeen !== k; sceneSeen = k;
      return '<div class="fin' + (play ? ' play' : '') + '"><svg class="fr" viewBox="0 0 100 340" aria-hidden="true"><g class="fr-lo"><g class="fr-flame"><path class="fl-o" d="M38 290 C40 311 46 325 50 337 C54 325 60 311 62 290 Z"/><path class="fl-i" d="M43.5 290 C45 304 48 313 50 320 C52 313 55 304 56.5 290 Z"/></g><path class="fr-noz" d="M41 270 L37 289 H63 L59 270 Z"/><rect x="32" y="171" width="12.2" height="99" fill="#0055A4"/><rect x="44" y="171" width="12.2" height="99" fill="#FFFFFF"/><rect x="56" y="171" width="12" height="99" fill="#EF4135"/><rect class="fr-ol" x="32" y="171" width="36" height="99"/></g><g class="fr-up"><path class="fr-fair" d="M50 8 C61 20 68 38 68 60 V72 H32 V60 C32 38 39 20 50 8 Z"/><rect x="32" y="72" width="36" height="33.3" fill="#000000"/><rect x="32" y="105" width="36" height="33.3" fill="#DD0000"/><rect x="32" y="138" width="36" height="33" fill="#FFCE00"/><rect class="fr-ol" x="32" y="72" width="36" height="99"/></g><line class="fr-join" x1="24" y1="171" x2="76" y2="171"/></svg><div class="ftx">' +
        (d.title ? '<h1 class="fit">' + esc(d.title).replace(/,\s*/, ',<br>') + '</h1>' : '') + '<div class="rule"></div>' +
        L.map(l => '<p class="fmsg">' + esc(l) + '</p>').join('') + (thx ? '<p class="fthx">' + esc(thx) + '</p>' : '') + '</div></div>';
    }
    let h = '', ul = false, had = false;
    (d.lines || []).forEach(l => {
      const b = /^[-•]\s*/.test(l);
      if (b && !ul) { h += '<ul>'; ul = true; had = true; }
      if (!b && ul) { h += '</ul>'; ul = false; }
      h += b ? '<li>' + rich(l.replace(/^[-•]\s*/, '')) + '</li>' : '<p' + (had ? ' class="concl"' : '') + '>' + rich(l) + '</p>'; // une phrase après les puces = conclusion
    });
    if (ul) h += '</ul>';
    const k = d.title + '|' + (d.lines || []).length, anim = h && infoSeen !== k; infoSeen = k; // le contenu n’apparaît en fondu qu’une fois
    return '<div class="info' + (d.ask ? ' ask' : '') + '">' + (d.title ? '<h1 class="iq">' + esc(d.title) + '</h1><div class="rule"></div>' : '') +
      (h ? '<div class="card body' + (anim ? ' in' : '') + '">' + h + '</div>' : '') + '</div>';
  }
  const rich = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  let infoSeen = '';
  const plural = (n, w) => n + ' ' + w + (n > 1 ? 's' : '');
  const set = (html, bind) => { app.innerHTML = html; if (bind) bind(); const bk = $('#bk'); if (bk) bk.onclick = () => act('prev'); };
  const back = () => S && S.back ? '<button class="btn ghost back" id="bk">Back</button>' : '';

  /* met à jour barres, pourcentages et compteurs sans tout redessiner */
  function patch() {
    if (!S) return;
    const c = S.counts, tot = c ? c.reduce((a, b) => a + b, 0) : 0;
    document.querySelectorAll('[data-bar]').forEach(el => {
      const den = S.phase === 'question' ? Math.max(S.n || 0, tot) : tot;
      const i = +el.dataset.bar, p = c && den ? Math.round(c[i] / den * 100) : 0;
      el.classList.toggle('on', !!c);
      el.style.width = (c ? p : 0) + '%';
      const t = document.querySelector('[data-pct="' + i + '"]');
      if (t) t.innerHTML = c ? p + '<small>%</small>' : '';
    });
    const cnt = $('#cnt');
    if (cnt) {
      cnt.innerHTML = '<b>' + S.n + '</b> ' + (S.n > 1 ? 'participants connected' : 'participant connected');
      $('#names').innerHTML = (S.names || []).map(n => '<span class="chip">' + esc(n) + '</span>').join('') || '<span class="muted">Waiting for participants…</span>';
    }
    const a = $('#ans');
    if (a) a.innerHTML = isHost ? '<b>' + (S.answered || 0) + '</b> / ' + plural(S.n, 'participant') + ' answered' : plural(S.answered || 0, 'answer');
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
    if (isScreen && !sess) return set(header() + '<div class="spacer"></div><div class="card center"><h2>Projection screen</h2><div class="muted" style="margin-top:8px">' + esc(err || 'Open this screen with the “Projection screen” button on the host page.') + '</div></div><div class="spacer"></div>');
    if (!sess) {
      let pw = ''; try { pw = sessionStorage.getItem('qz_pw') || ''; } catch (e) {}
      return set(header() + '<h1>New game</h1>' + errHTML() +
        '<div><label>Host password</label><input id="pw" type="password" value="' + esc(pw) + '"></div>' +
        '<div><label>Displayed title</label><input id="ti" maxlength="60" value="Two Stages, One Rocket"></div>' +
        '<div><label>Time per question (seconds)</label><input id="du" type="number" min="5" max="300" value="30"></div>' +
        '<label class="check"><input id="lv" type="checkbox" checked> Show live percentages during the question (otherwise only at the reveal)</label>' +
        '<div><label>Running order</label><div class="muted" style="margin-bottom:8px">One blank line between two steps, in the order you will run them.<br><b>Question:</b> the question, then 2 to 4 answers. The correct one starts with * (without *, it is a poll). A line starting with &gt; is the explanation.<br><b>Scene screen:</b> “SCENE: 4. ASCENT – Scene name”, then one time or place cue per line. They appear one after another, on your command.<br><b>Content screen:</b> “CONTENT: title”, then the text. A line starting with - becomes a bullet.</div><textarea id="qs"></textarea></div>' +
        '<button class="btn" id="cr">Create the game</button>',
        () => {
          $('#qs').value = quizText();
          $('#cr').onclick = async () => {
            const keep = { qs: $('#qs').value, du: $('#du').value, ti: $('#ti').value, lv: $('#lv').checked };
            const back = () => { view = ''; render(); $('#qs').value = keep.qs; $('#du').value = keep.du; $('#ti').value = keep.ti; $('#lv').checked = keep.lv; };
            const questions = parseQuiz(keep.qs);
            if (!questions.length) { err = 'No valid step. Check the format of questions, scenes and content.'; return back(); }
            try {
              const password = $('#pw').value;
              try { sessionStorage.setItem('qz_pw', password); } catch (e) {}
              const r = await post('/api/create', { password, questions, dur: +keep.du, title: keep.ti, live: keep.lv });
              sess = { code: r.code, token: r.token }; save(sess); err = ''; connect(); render();
            } catch (e) { err = e.message; back(); }
          };
        });
    }
    if (!S) return set(header() + '<div class="card center"><div class="wait"></div>Connecting…</div>');
    if (S.phase === 'lobby') {
      const url = location.origin + '/?c=' + S.code;
      return set(header() + '<div class="lobby"><div class="center"><div class="qr" id="qr"></div></div><div><div class="kicker">Scan the QR code, or go to</div><div class="url">' + esc(location.host) + '</div><div class="kicker" style="margin-top:18px">Game code</div><div class="code">' + esc(S.code) + '</div></div></div>' +
        '<div class="card"><div class="meta" id="cnt"></div><div class="chips" id="names" style="margin-top:12px"></div></div>' +
        (S.view ? '<div class="card ctrl"><div><div class="kicker">Project in the room</div><p class="muted">Open this screen on the computer connected to the projector: it shows the quiz without any buttons.</p>' +
          '<a class="btn ghost" href="/screen?c=' + encodeURIComponent(S.code) + '&k=' + encodeURIComponent(S.view) + '" target="_blank" rel="noopener">Projection screen</a></div>' +
          '<div class="remote"><div class="qr small" id="rq"></div><div><div class="kicker">Control from my phone</div><p class="muted">Scan this code with your phone: it becomes the remote control. Do not show it to participants.</p></div></div></div>' : '') +
        '<div class="spacer"></div><button class="btn" id="go">Start · ' + plural(S.steps || S.total, 'step') + '</button>',
        () => {
          $('#go').onclick = () => act('start');
          try { new QRCode($('#qr'), { text: url, width: 240, height: 240 }); } catch (e) { $('#qr').remove(); }
          if ($('#rq')) try { new QRCode($('#rq'), { text: location.origin + '/host?c=' + encodeURIComponent(S.code) + '&t=' + encodeURIComponent(sess.token), width: 150, height: 150 }); } catch (e) { $('#rq').remove(); }
        });
    }
    if (S.phase === 'slide') {
      return set(header() + slide() + '<div class="spacer"></div><div class="foot"><button class="btn" id="nx">' + nextLabel() + '</button>' + back() + (S.part ? '<div class="meta part">Cue <b>' + S.part[0] + '</b> / ' + S.part[1] + '</div>' : '') + '</div>',
        () => { $('#nx').onclick = () => act('next'); });
    }
    if (S.phase === 'question') {
      return set(header() + qhead(true) + tiles(S.question) + '<div class="spacer"></div><div class="foot"><button class="btn" id="rv">' + (S.poll ? 'Show results' : 'Reveal the answer') + '</button>' + back() + '<div class="meta" id="ans"></div></div>',
        () => { $('#rv').onclick = () => act('reveal'); });
    }
    if (S.phase === 'reveal') {
      return set(header() + qhead(false) + tiles(S.question, { reveal: true, correct: S.correct }) + answerCard() + '<div class="spacer"></div>' +
        '<div class="foot"><button class="btn" id="nx">' + nextLabel() + '</button>' + back() + '<div class="meta" id="ans"></div></div>',
        () => { $('#nx').onclick = () => act('next'); });
    }
    set(header() + '<h1>Thank you all</h1><div class="card recap"><div class="kicker">Summary</div>' + recapRows() +
      '<div class="muted" style="margin-top:10px">Quiz: percentage of correct answers. Polls: share of each answer, from most to least chosen.</div></div>' +
      '<div class="spacer"></div><div class="foot endfoot"><button class="btn" id="nw">New game</button><button class="btn ghost" id="rs">Replay with the same participants</button>' + (isScreen ? '' : '<button class="btn ghost" id="dl">Download (Excel)</button><button class="btn ghost" id="pr">Save as PDF</button>') + back() + '</div>',
      () => {
        $('#rs').onclick = () => act('restart');
        if ($('#dl')) { $('#dl').onclick = downloadRecap; $('#pr').onclick = () => window.print(); }
        $('#nw').onclick = () => { if (demo) return; if (es) es.close(); save(null); sess = null; S = null; err = ''; render(); };
      });
  }

  /* ---------- participant ---------- */
  function buildPlayer() {
    if (!sess) {
      const c = params.get('c') || '';
      let nm = ''; try { nm = localStorage.getItem('qz_name') || ''; } catch (e) {}
      return set(header() + '<div class="spacer"></div><h1>Join<br>the quiz</h1>' + errHTML() +
        '<div><label>Game code</label><input class="c" id="cd" inputmode="numeric" maxlength="4" value="' + esc(c) + '"></div>' +
        '<div><label>Your first name</label><input class="c" id="nm" maxlength="20" autocomplete="off" value="' + esc(nm) + '"></div>' +
        '<button class="btn" id="jn">Join</button><div class="spacer"></div><div class="spacer"></div>',
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
    if (!S) return set(header() + '<div class="spacer"></div><div class="card center"><div class="wait"></div>Connecting…</div><div class="spacer"></div>');
    const me = S.me || { name: '', ans: null };
    if (S.phase === 'lobby') {
      return set(header() + '<div class="spacer"></div><div class="card center"><div class="wait"></div><h2>Welcome ' + esc(me.name) + '</h2><div class="muted" style="margin-top:8px">The quiz will start soon. Keep this page open.</div></div><div class="spacer"></div><div class="spacer"></div>');
    }
    if (S.phase === 'slide') return set(header() + slide());
    if (S.phase === 'question') {
      let pick = null;
      const done = me.ans != null;
      return set(header() + qhead(true) + tiles(S.question, { click: !done, picked: me.ans }) +
        (done ? '<div class="meta center">Answer submitted · <span id="ans"></span></div>'
              : '<button class="btn" id="vd" disabled>Submit my answer</button><div class="muted center">You can change your choice until you submit. An unsubmitted answer is not counted.</div>'),
        () => {
          const vd = $('#vd'); if (!vd) return;
          app.querySelectorAll('button[data-c]').forEach(b => b.onclick = () => {
            pick = +b.dataset.c;
            app.querySelectorAll('.tile').forEach((t, i) => t.classList.toggle('sel', i === pick));
            vd.disabled = false;
          });
          vd.onclick = () => {
            if (pick == null || (!S.poll && Date.now() > deadline + 800)) return;
            S.me = { name: me.name, ans: pick }; render();
            if (!demo) post('/api/answer', { code: sess.code, id: sess.id, c: pick }).catch(() => {});
          };
        });
    }
    if (S.phase === 'reveal') {
      return set(header() + qhead(false) + tiles(S.question, { reveal: true, correct: S.correct, picked: me.ans }) + answerCard() + '<div class="meta center" id="ans"></div>');
    }
    set(header() + '<div class="spacer"></div><div class="card center"><h2>Thank you for taking part</h2><div class="muted" style="margin-top:8px">The quiz is over.</div></div><div class="spacer"></div><div class="spacer"></div>');
  }

  function render() {
    const me = S && S.me;
    document.body.classList.toggle('longx', !!(S && S.phase === 'reveal' && S.expl && S.expl.length > 320));
    const key = [isHost, !!sess, S ? S.phase : '-', S ? S.i + ':' + S.q + ':' + (S.slide ? S.slide.sub + '/' + (S.slide.lines || []).length : '') + ':' + S.back : '', me ? me.ans : '', err].join('|');
    if (key !== view) { view = key; if (!(S && S.phase === 'slide' && S.slide && (S.slide.t === 'scene' || S.slide.fin))) { sceneSeen = ''; cueKey = ''; cueMem = { scene: '', min: null }; } isHost ? buildHost() : buildPlayer(); requestAnimationFrame(() => { fitScene(); flights(); cueAnim(); patch(); }); }
    else patch();
  }

  if (demo) {
    const Q = DEFAULT_QUIZ[0], ph = demo.split('-')[1] || 'question';
    if (isScreen) sess = { code: '4821', view: 'demo' };
    sess = { code: '4821', id: 'demo', token: 'demo' };
    S = { code: '4821', title: 'Live quiz', phase: ph, q: 0, total: DEFAULT_QUIZ.length, n: 48, question: { q: Q.q, o: Q.o }, answered: 41 };
    if (ph === 'lobby') { S.n = 6; S.names = ['Camille', 'Thomas', 'Inès', 'Julien', 'Sarah', 'Marc']; }
    if (ph === 'question') { S.dur = 30000; S.rem = 19000; if (isHost) S.counts = [5, 3, 29, 4]; else S.me = { name: 'Camille', ans: null }; }
    if (ph === 'reveal') { S.counts = [5, 3, 29, 4]; S.correct = Q.c; S.expl = Q.e; if (!isHost) S.me = { name: 'Camille', ans: 2 }; }
    if (ph === 'scene') { S.phase = 'slide'; S.next = 'q'; S.slide = { t: 'scene', title: '4. ASCENT – Lost in Translation', sub: 'After lunch' }; S.part = [1, 2]; S.back = true; }
    if (ph === 'final') { S.phase = 'slide'; S.next = 'end'; S.back = true; S.slide = { t: 'info', fin: true, title: 'Two Stages, One Rocket', lines: ['We are not that different. And it’s exactly that bit that makes it fly.', 'Thank you! Danke! Merci!'] }; }
    if (ph === 'info') { S.phase = 'slide'; S.next = 'info'; S.slide = { t: 'info', title: 'Focus on stereotypes', lines: ['A stereotype is a simplified belief applied to a whole group.', '- It saves time, but it distorts judgement', '- Everyone has them, often without knowing it', '- Spotting them is the first step to getting rid of them'] }; }
    if (ph === 'end') S.recap = DEFAULT_QUIZ.map((x, i) => ({ q: x.q, n: 44 - i, good: x.c < 0 ? null : 30 - 4 * i, poll: x.c < 0, c: x.c, o: x.o.map((t, j) => ({ t, n: [9, 21, 6, 8][j] || 1 })) }));
    deadline = Date.now() + (S.rem || 0);
  }
  setInterval(tickTimer, 200);
  if (isScreen) { // bouton plein écran, masqué une fois en plein écran
    const fs = document.createElement('button');
    fs.className = 'fs'; fs.textContent = 'Full screen';
    fs.onclick = () => { try { document.documentElement.requestFullscreen().catch(() => {}); } catch (e) {} };
    document.addEventListener('fullscreenchange', () => { fs.hidden = !!document.fullscreenElement; });
    document.body.appendChild(fs);
  }
  if (sess && !demo) connect();
  render();
}

const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#000d1a"><title>Live quiz</title>' +
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Open+Sans:wght@400;600&display=swap" rel="stylesheet">' +
  '<style>' + CSS + '</style></head><body><div class="sky"><div class="halo"></div></div><div id="app"></div>' +
  '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>' +
  '<script>(' + client.toString() + ')(' + JSON.stringify(DEFAULT_QUIZ) + ',' + (LOGO ? 'true' : 'false') + ',' + JSON.stringify(DEFAULT_TEXT) + ');</script></body></html>';

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(() => { if (!res.headersSent) fail(res, 500, 'Erreur serveur'); });
  } else if (url.pathname === '/healthz') {
    res.writeHead(200); res.end('ok');
  } else if (url.pathname === '/logo' && LOGO) {
    res.writeHead(200, { 'Content-Type': LOGO_TYPES[path.extname(LOGO)], 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    fs.createReadStream(LOGO).pipe(res);
  } else if (['/', '/host', '/host/', '/screen', '/screen/'].includes(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
  } else {
    res.writeHead(404); res.end('Not found');
  }
}).listen(PORT, () => console.log('Live quiz on port ' + PORT));
