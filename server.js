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
  const more = Q && g.phase === 'slide' && Q.t === 'scene' && g.step < Q.subs.length - 1;
  if (Q && g.phase === 'slide') s.slide = Q.t === 'scene' ? { t: 'scene', title: Q.title, sub: Q.subs[g.step] || '' } : { t: 'info', title: Q.title, lines: Q.lines };
  const staff = cl.role === 'host' || cl.role === 'screen'; // animateur ou écran de projection
  if (cl.role === 'host') {
    s.view = g.view;
    const N = g.questions[g.q + 1];
    s.next = more ? 'sub' : N ? N.t : 'end';
    s.back = g.phase === 'end' || (g.phase !== 'lobby' && (g.q > 0 || g.step > 0));
    if (s.slide && Q.t === 'scene' && Q.subs.length > 1) s.part = [g.step + 1, Q.subs.length];
  }
  const me = cl.role === 'player' ? g.players.get(cl.id) : null;
  if (me) s.me = { name: me.name, ans: me.a[g.q] };
  if (g.phase === 'lobby' && staff) s.names = [...g.players.values()].slice(0, 200).map(p => p.name);
  if (Q && (g.phase === 'question' || g.phase === 'reveal')) {
    s.question = { q: Q.q, o: Q.o };
    const c = counts(g);
    s.answered = c.reduce((a, b) => a + b, 0);
    if (g.phase === 'question') {
      s.rem = Math.max(0, g.startedAt + g.dur - Date.now());
      s.dur = g.dur;
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
  g.results[g.q] = { q: Q.q, n: c.reduce((a, b) => a + b, 0), good: Q.c >= 0 ? c[Q.c] : null };
  g.phase = 'reveal';
  broadcast(g);
}
function show(g, i, back) {
  g.q = i; g.step = 0;
  const it = g.questions[i];
  if (!it) { g.phase = 'end'; broadcast(g); }
  else if (it.t === 'q') {
    if (g.results[i]) { g.phase = 'reveal'; broadcast(g); } // question déjà jouée : on réaffiche ses résultats
    else beginQuestion(g);
  } else {
    if (back && it.t === 'scene') g.step = Math.max(0, it.subs.length - 1);
    g.phase = 'slide'; broadcast(g);
  }
}
function hostAction(g, action) {
  if (action === 'start' && g.phase === 'lobby') show(g, 0);
  else if (action === 'reveal') reveal(g);
  else if (action === 'next' && (g.phase === 'reveal' || g.phase === 'slide')) {
    const it = g.questions[g.q];
    if (g.phase === 'slide' && it.t === 'scene' && g.step < it.subs.length - 1) { g.step++; broadcast(g); }
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
  if (req.method !== 'POST') return fail(res, 405, 'Méthode non autorisée');
  let b;
  try { b = await readBody(req); } catch (e) { return fail(res, 400, 'Requête invalide'); }

  if (url.pathname === '/api/create') {
    if (String(b.password || '') !== HOST_PASSWORD) {
      await new Promise(r => setTimeout(r, 600));
      return fail(res, 403, 'Mot de passe incorrect');
    }
    const questions = cleanQuestions(b.questions);
    if (!questions) return fail(res, 400, 'Aucune étape valide');
    if (games.size >= MAX_GAMES) return fail(res, 503, 'Trop de parties en cours');
    const dur = Math.min(300, Math.max(5, Number(b.dur) || 30)) * 1000;
    const title = String(b.title || '').trim().slice(0, 60) || 'Quiz en direct';
    const g = { code: newCode(), token: rid(16), view: rid(12), title, live: b.live !== false, questions, nq: questions.filter(x => x.t === 'q').length, dur, phase: 'lobby', q: -1, step: 0,
      startedAt: 0, players: new Map(), clients: new Set(), results: [], dirty: false, last: Date.now() };
    games.set(g.code, g);
    return json(res, 200, { code: g.code, token: g.token, view: g.view });
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
    g.players.set(id, { id, name, a: {} });
    g.dirty = true;
    return json(res, 200, { id, name });
  }
  if (url.pathname === '/api/answer') {
    const p = g.players.get(String(b.id || ''));
    const c = Number(b.c);
    if (!p || g.phase !== 'question' || p.a[g.q] != null) return json(res, 200, { ok: false });
    if (!Number.isInteger(c) || c < 0 || c >= g.questions[g.q].o.length) return fail(res, 400, 'Réponse invalide');
    p.a[g.q] = c;
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
  "e": "About 1,200 people, roughly 15 % of the group (85 % in France)."
 },
 {
  "q": "How many main sites does ArianeGroup have in France and in Germany?",
  "o": [
   "13 in France, 1 in Germany",
   "9 in France, 4 in Germany",
   "6 in France, 6 in Germany",
   "4 in France, 9 in Germany"
  ],
  "c": 1,
  "e": "13 main sites: 8 in mainland France and 1 in French Guiana (the launch base), plus 4 in Germany."
 },
 {
  "q": "Which side carries most of the defence activities?",
  "o": [
   "Mainly France",
   "Mainly Germany",
   "Half and half",
   "Neither: ArianeGroup is civil only"
  ],
  "c": 0,
  "e": "ArianeGroup builds civil and military launchers. Defence is mainly French; the German side works mainly on civil programmes. In France, even civil activities follow defence-level security rules."
 },
 {
  "q": "What is the official language of ArianeGroup?",
  "o": [
   "French",
   "German",
   "English",
   "French… until a German colleague walks in"
  ],
  "c": 2,
  "e": "English. The only official language of the group… that nobody speaks as a native."
 },
 {
  "q": "True or false: in France, a contract is only valid if you write « lu et approuvé » by hand.",
  "o": [
   "True",
   "False"
  ],
  "c": 1,
  "e": "False. The French Court of Cassation ruled as early as 1993 that this mention is a formality with no legal effect: the signature is enough. And yet everybody still asks for it."
 },
 {
  "q": "When are French and German teams most likely to be at their desks at the same time?",
  "o": [
   "7:00 – 9:00",
   "9:30 – 11:00",
   "12:00 – 13:30",
   "17:00 – 19:00"
  ],
  "c": 1,
  "e": "In Germany, people often start between 6:30 and 8:00, have a 30-minute lunch from 11:00, and offices can be empty from 16:00 (part-time often means a free afternoon). In France, people start around 9:00-9:30, have a one-hour lunch around 12:30 and stay until 18:00-19:00. Your shared windows: about 9:30-11:00 and 13:30-16:00."
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
  "e": "Both. The Germans tend to protect their information; the French simply don’t think of sharing it. It is rarely retention: it is forgetting. The reflex to build: « Who on the other side needs this? »"
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
   "Ask myself « who on the other side needs this? » before sending",
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
const DEFAULT_TEXT = "How many people work at ArianeGroup?\nAbout 2,000\n*About 8,000\nAbout 15,000\nAbout 30,000\n> About 8,000 people, in France and in Germany.\n\nHow many of them are based in Germany?\nAbout 300\n*About 1,200\nAbout 4,000\nAbout 6,000\n> About 1,200 people, roughly 15 % of the group (85 % in France).\n\nHow many main sites does ArianeGroup have in France and in Germany?\n13 in France, 1 in Germany\n*9 in France, 4 in Germany\n6 in France, 6 in Germany\n4 in France, 9 in Germany\n> 13 main sites: 8 in mainland France and 1 in French Guiana (the launch base), plus 4 in Germany.\n\nWhich side carries most of the defence activities?\n*Mainly France\nMainly Germany\nHalf and half\nNeither: ArianeGroup is civil only\n> ArianeGroup builds civil and military launchers. Defence is mainly French; the German side works mainly on civil programmes. In France, even civil activities follow defence-level security rules.\n\nWhat is the official language of ArianeGroup?\nFrench\nGerman\n*English\nFrench… until a German colleague walks in\n> English. The only official language of the group… that nobody speaks as a native.\n\nSCÈNE : 2. IGNITION – The Interview\nRight here. Right now.\n\nCONTENU : Two roads to the same engineer\n- France: the Grandes Écoles. The name of the school and its network weigh on a whole career.\n- Germany: dual study (Duales Studium). The DHBW is the largest university in Baden-Württemberg: around 33,000 students and 9,000 partner companies.\n- Students alternate study and work in a company, and are paid by that company throughout.\nDifferent road. Same rocket science.\n\nCONTENU : English: who speaks it best?\n- EF English Proficiency Index 2025: Germany ranks #4 worldwide (very high level), France #38 (moderate level).\n- On the ground, the level varies on both sides: it is more a question of generation than of nationality.\nAnd at ArianeGroup, nobody is a native speaker of the official language.\n\nCONTENU : Who decides?\n- The French manager decides quickly, says what to do… and may change the decision. Seen from Germany: unstable.\n- The German manager asks « What do you propose? », consults… and then the decision is final. Seen from France: a boss who doesn’t decide.\nSame goal: a good decision. Two different timings.\n\nSCÈNE : 3. LIFTOFF – The First Day\nThree weeks later. 7:00 a.m.\n9:30 a.m.\n11:00 a.m.\n\nSCÈNE : 4. ASCENT – Lost in Translation\nAfter lunch\n\nTrue or false: in France, a contract is only valid if you write « lu et approuvé » by hand.\nTrue\n*False\n> False. The French Court of Cassation ruled as early as 1993 that this mention is a formality with no legal effect: the signature is enough. And yet everybody still asks for it.\n\nWhen are French and German teams most likely to be at their desks at the same time?\n7:00 – 9:00\n*9:30 – 11:00\n12:00 – 13:30\n17:00 – 19:00\n> In Germany, people often start between 6:30 and 8:00, have a 30-minute lunch from 11:00, and offices can be empty from 16:00 (part-time often means a free afternoon). In France, people start around 9:00-9:30, have a one-hour lunch around 12:30 and stay until 18:00-19:00. Your shared windows: about 9:30-11:00 and 13:30-16:00.\n\nWho thinks the other side is hiding information?\nThe French\nThe Germans\n*Both\nNobody\n> Both. The Germans tend to protect their information; the French simply don’t think of sharing it. It is rarely retention: it is forgetting. The reflex to build: « Who on the other side needs this? »\n\nSCÈNE : 5. MAX Q – The Big Meeting\nThe weekly team meeting\n\nSCÈNE : 6. ORBIT INSERTION – The Conclusion\n\nFor you, good Franco-German cooperation is above all…\nListening before deciding\nChoosing our working language together\nSharing information as a reflex\nRespecting each other’s rhythm\n\nWhat do you value most in your colleagues from across the border?\nTheir expertise\nTheir reliability\nTheir agility\nTheir different way of seeing the same problem\n\nTomorrow, with my mixed team, I will…\nAsk which language people prefer for our meetings\nAsk myself « who on the other side needs this? » before sending\nSchedule our meetings in our shared time window\nAgree on how we decide, before deciding\n\nWhat makes Ariane 6 fly?\nThe French lower stage\nThe German upper stage\nA very long meeting\n*Both stages, letting go at the same second\n\nCONTENU : Two Stages, One Rocket\nWe are not that different. And it’s exactly that bit that makes it fly.\nThank you! Danke! Merci!";

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
body.host .answer p{font-size:20px}
body.host.longx #app{padding-top:16px;gap:12px}
body.host.longx .qtext{font-size:clamp(26px,3vw,40px)}
body.host.longx .tile{min-height:64px;padding:8px 18px}
body.host.longx .pct{font-size:34px}
body.host.longx .answer{padding:12px 18px}
body.host.longx .answer .ans{font-size:28px}
body.host.longx .answer p{font-size:17px;margin-top:4px}
body.host .foot{display:flex;align-items:center;gap:28px;flex-wrap:wrap}
body.host:not(.screen) .foot{position:sticky;bottom:0;z-index:5;padding:16px 0 18px;margin-bottom:-18px;background:linear-gradient(to top,rgba(0,13,26,.97) 70%,rgba(0,13,26,0))}
.foot{display:grid;gap:14px}
.scene{flex:1;display:flex;flex-direction:column;justify-content:center;gap:22px;padding:6vh 0}
.scene h1{font-size:46px;text-shadow:0 0 40px rgba(127,220,255,.4)}
body.host .scene h1{font-size:clamp(64px,8.5vw,128px)}
.rule{width:140px;height:2px;background:linear-gradient(90deg,#f1fcff,var(--halo) 60%,rgba(127,220,255,0));box-shadow:0 0 16px rgba(127,220,255,.9)}
body.host .rule{width:260px;height:3px}
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
.wait{width:64px;height:64px;margin:0 auto 16px;border-radius:50%;border:2px solid rgba(127,220,255,.2);border-top-color:var(--halo);box-shadow:0 0 22px rgba(127,220,255,.4);animation:spin 1.6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.wait{animation:none}.fill,.prg{transition:none}}
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
    es.addEventListener('gone', () => { es.close(); save(null); sess = null; S = null; err = isScreen ? 'Cette partie est terminée. Rouvrez l’écran de projection depuis la page animateur.' : 'Partie terminée ou introuvable.'; render(); });
  }
  const act = a => { if (!demo && !isScreen) post('/api/host', { code: sess.code, token: sess.token, action: a }).catch(() => {}); };

  /* format texte : question, réponses (la bonne commence par *), puis "> explication" */
  function parseQuiz(t) {
    return t.split(/\n\s*\n/).map(b => b.split('\n').map(l => l.trim()).filter(Boolean)).filter(l => l.length).map(l => {
      let m = l[0].match(/^sc[eèé]ne\s*:\s*(.*)$/i);
      if (m) return { t: 'scene', title: m[1], sub: l.slice(1).join('\n') };
      m = l[0].match(/^contenu\s*:\s*(.*)$/i);
      if (m) return { t: 'info', title: m[1], lines: l.slice(1) };
      let c = -1; const o = [], e = [];
      l.slice(1).forEach(x => {
        if (x[0] === '>') { e.push(x.slice(1).trim()); return; }
        if (x[0] === '*') { c = o.length; x = x.slice(1).trim(); }
        o.push(x);
      });
      return { t: 'q', q: l[0], o, c, e: e.join(' ') };
    }).filter(x => x.t === 'scene' ? x.title : x.t === 'info' ? (x.title || x.lines.length) : (x.o.length >= 2 && x.o.length <= 4));
  }
  const quizText = () => DEFAULT_TEXT;

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
  const nextLabel = () => ({ sub: 'Indication suivante', q: 'Lancer la question', scene: 'Scène suivante', info: 'Afficher le contenu', end: 'Terminer' })[S.next] || 'Suivant';
  function slide() {
    const d = S.slide || {};
    if (d.t === 'scene') return '<div class="scene"><h1>' + esc(d.title) + '</h1><div class="rule"></div>' + (d.sub ? '<div class="sub">' + esc(d.sub).replace(/\n/g, '<br>') + '</div>' : '') + '</div>';
    let h = '', ul = false;
    (d.lines || []).forEach(l => {
      const b = /^[-•]\s*/.test(l);
      if (b && !ul) { h += '<ul>'; ul = true; }
      if (!b && ul) { h += '</ul>'; ul = false; }
      h += b ? '<li>' + esc(l.replace(/^[-•]\s*/, '')) + '</li>' : '<p>' + esc(l) + '</p>';
    });
    if (ul) h += '</ul>';
    return '<div class="info">' + (d.title ? '<h1>' + esc(d.title) + '</h1>' : '') + (h ? '<div class="card body">' + h + '</div>' : '') + '</div>';
  }
  const plural = (n, w) => n + ' ' + w + (n > 1 ? 's' : '');
  const set = (html, bind) => { app.innerHTML = html; if (bind) bind(); const bk = $('#bk'); if (bk) bk.onclick = () => act('prev'); };
  const back = () => S && S.back ? '<button class="btn ghost back" id="bk">Retour</button>' : '';

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
    if (isScreen && !sess) return set(header() + '<div class="spacer"></div><div class="card center"><h2>Écran de projection</h2><div class="muted" style="margin-top:8px">' + esc(err || 'Ouvrez cet écran avec le bouton « Écran de projection » de la page animateur.') + '</div></div><div class="spacer"></div>');
    if (!sess) {
      let pw = ''; try { pw = sessionStorage.getItem('qz_pw') || ''; } catch (e) {}
      return set(header() + '<h1>Nouvelle partie</h1>' + errHTML() +
        '<div><label>Mot de passe animateur</label><input id="pw" type="password" value="' + esc(pw) + '"></div>' +
        '<div><label>Titre affiché</label><input id="ti" maxlength="60" value="Two Stages, One Rocket"></div>' +
        '<div><label>Durée par question (secondes)</label><input id="du" type="number" min="5" max="300" value="30"></div>' +
        '<label class="check"><input id="lv" type="checkbox" checked> Afficher les pourcentages en direct pendant la question (sinon, seulement à la révélation)</label>' +
        '<div><label>Déroulé</label><div class="muted" style="margin-bottom:8px">Une ligne vide entre deux étapes, dans l’ordre où vous les lancerez.<br><b>Question :</b> la question, puis 2 à 4 réponses. La bonne commence par * (sans *, c’est un sondage). Une ligne qui commence par &gt; est l’explication.<br><b>Écran de scène :</b> « SCÈNE : nom de la scène », puis une indication de temps ou de lieu par ligne. Elles s’affichent l’une après l’autre, à votre commande.<br><b>Écran de contenu :</b> « CONTENU : titre », puis le texte. Une ligne qui commence par - devient une puce.</div><textarea id="qs"></textarea></div>' +
        '<button class="btn" id="cr">Créer la partie</button>',
        () => {
          $('#qs').value = quizText();
          $('#cr').onclick = async () => {
            const keep = { qs: $('#qs').value, du: $('#du').value, ti: $('#ti').value, lv: $('#lv').checked };
            const back = () => { view = ''; render(); $('#qs').value = keep.qs; $('#du').value = keep.du; $('#ti').value = keep.ti; $('#lv').checked = keep.lv; };
            const questions = parseQuiz(keep.qs);
            if (!questions.length) { err = 'Aucune étape valide. Vérifiez le format des questions, scènes et contenus.'; return back(); }
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
        (S.view ? '<div class="card ctrl"><div><div class="kicker">Projeter dans la salle</div><p class="muted">Ouvrez cet écran sur l’ordinateur relié au vidéoprojecteur : il affiche le quiz sans aucun bouton.</p>' +
          '<a class="btn ghost" href="/screen?c=' + encodeURIComponent(S.code) + '&k=' + encodeURIComponent(S.view) + '" target="_blank" rel="noopener">Écran de projection</a></div>' +
          '<div class="remote"><div class="qr small" id="rq"></div><div><div class="kicker">Piloter depuis mon téléphone</div><p class="muted">Scannez ce code avec votre téléphone : il devient la télécommande. Ne le montrez pas aux participants.</p></div></div></div>' : '') +
        '<div class="spacer"></div><button class="btn" id="go">Démarrer · ' + plural(S.steps || S.total, 'étape') + '</button>',
        () => {
          $('#go').onclick = () => act('start');
          try { new QRCode($('#qr'), { text: url, width: 240, height: 240 }); } catch (e) { $('#qr').remove(); }
          if ($('#rq')) try { new QRCode($('#rq'), { text: location.origin + '/host?c=' + encodeURIComponent(S.code) + '&t=' + encodeURIComponent(sess.token), width: 150, height: 150 }); } catch (e) { $('#rq').remove(); }
        });
    }
    if (S.phase === 'slide') {
      return set(header() + slide() + '<div class="spacer"></div><div class="foot"><button class="btn" id="nx">' + nextLabel() + '</button>' + back() + (S.part ? '<div class="meta part">Indication <b>' + S.part[0] + '</b> / ' + S.part[1] + '</div>' : '') + '</div>',
        () => { $('#nx').onclick = () => act('next'); });
    }
    if (S.phase === 'question') {
      return set(header() + qhead(true) + tiles(S.question) + '<div class="spacer"></div><div class="foot"><button class="btn" id="rv">Révéler la réponse</button>' + back() + '<div class="meta" id="ans"></div></div>',
        () => { $('#rv').onclick = () => act('reveal'); });
    }
    if (S.phase === 'reveal') {
      return set(header() + qhead(false) + tiles(S.question, { reveal: true, correct: S.correct }) + answerCard() + '<div class="spacer"></div>' +
        '<div class="foot"><button class="btn" id="nx">' + nextLabel() + '</button>' + back() + '<div class="meta" id="ans"></div></div>',
        () => { $('#nx').onclick = () => act('next'); });
    }
    set(header() + '<h1>Merci à toutes et à tous</h1><div class="card"><div class="kicker">Synthèse</div>' +
      (S.recap || []).filter(Boolean).map((r, i) => '<div class="rrow"><span>' + (i + 1) + '. ' + esc(r.q) + '<div class="muted">' + plural(r.n, 'réponse') + '</div></span><b>' +
        (r.good == null ? 'Sondage' : (r.n ? Math.round(r.good / r.n * 100) : 0) + ' %') + '</b></div>').join('') + '<div class="muted" style="margin-top:10px">Pourcentage de bonnes réponses par question.</div></div>' +
      '<div class="spacer"></div><div class="foot"><button class="btn" id="nw">Nouvelle partie</button><button class="btn ghost" id="rs">Rejouer avec les mêmes participants</button>' + back() + '</div>',
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
    if (S.phase === 'slide') return set(header() + slide());
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
    document.body.classList.toggle('longx', !!(S && S.phase === 'reveal' && S.expl && S.expl.length > 240));
    const key = [isHost, !!sess, S ? S.phase : '-', S ? S.i + ':' + S.q + ':' + (S.slide ? S.slide.sub : '') + ':' + S.back : '', me ? me.ans : '', err].join('|');
    if (key !== view) { view = key; isHost ? buildHost() : buildPlayer(); requestAnimationFrame(patch); }
    else patch();
  }

  if (demo) {
    const Q = DEFAULT_QUIZ[0], ph = demo.split('-')[1] || 'question';
    if (isScreen) sess = { code: '4821', view: 'demo' };
    sess = { code: '4821', id: 'demo', token: 'demo' };
    S = { code: '4821', title: 'Quiz en direct', phase: ph, q: 0, total: DEFAULT_QUIZ.length, n: 48, question: { q: Q.q, o: Q.o }, answered: 41 };
    if (ph === 'lobby') { S.n = 6; S.names = ['Camille', 'Thomas', 'Inès', 'Julien', 'Sarah', 'Marc']; }
    if (ph === 'question') { S.dur = 30000; S.rem = 19000; if (isHost) S.counts = [5, 3, 29, 4]; else S.me = { name: 'Camille', ans: null }; }
    if (ph === 'reveal') { S.counts = [5, 3, 29, 4]; S.correct = Q.c; S.expl = Q.e; if (!isHost) S.me = { name: 'Camille', ans: 2 }; }
    if (ph === 'scene') { S.phase = 'slide'; S.next = 'q'; S.slide = { t: 'scene', title: 'Scène 1 · La réunion', sub: 'Le matin, au bureau' }; S.part = [1, 2]; S.back = true; }
    if (ph === 'info') { S.phase = 'slide'; S.next = 'q'; S.slide = { t: 'info', title: 'Focus sur les stéréotypes', lines: ['Un stéréotype est une croyance simplifiée que l’on applique à tout un groupe.', '- Il fait gagner du temps, mais il fausse le jugement', '- Tout le monde en a, souvent sans le savoir', '- Le repérer est la première étape pour s’en défaire'] }; }
    if (ph === 'end') S.recap = DEFAULT_QUIZ.map((x, i) => ({ q: x.q, n: 44 - i, good: x.c < 0 ? null : 30 - 4 * i }));
    deadline = Date.now() + (S.rem || 0);
  }
  setInterval(tickTimer, 200);
  if (isScreen) { // bouton plein écran, masqué une fois en plein écran
    const fs = document.createElement('button');
    fs.className = 'fs'; fs.textContent = 'Plein écran';
    fs.onclick = () => { try { document.documentElement.requestFullscreen().catch(() => {}); } catch (e) {} };
    document.addEventListener('fullscreenchange', () => { fs.hidden = !!document.fullscreenElement; });
    document.body.appendChild(fs);
  }
  if (sess && !demo) connect();
  render();
}

const PAGE = '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#000d1a"><title>Quiz en direct</title>' +
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
}).listen(PORT, () => console.log('Quiz en direct sur le port ' + PORT));
