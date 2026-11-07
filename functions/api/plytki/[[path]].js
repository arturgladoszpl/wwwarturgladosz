// API gry w płytki (/punkty/plytki/). Ta sama baza D1 co licznik (`DB`).
// Każdy gracz dostaje przy dołączeniu tajny token (nagłówek x-token);
// tylko z nim serwer pokazuje jego płytki na ręce.
//
//   POST /api/plytki/games              {title, pk?}  utwórz grę (pk = kod gry online licznika)
//   GET  /api/plytki/games/:g?rev=N     stan gry (albo {rev, same} bez zmian)
//   POST /api/plytki/games/:g/join      {name}        → {token, id}
//   POST /api/plytki/games/:g/start
//   POST /api/plytki/games/:g/play      {moves:[{i, x, y}]}  i = numer płytki na ręce
//   POST /api/plytki/games/:g/swap      {idx:[...]}
//   POST /api/plytki/games/:g/pass
//   POST /api/plytki/games/:g/learn-ok  {on}  przed startem: czy wolno włączać podpowiedzi (tryb nauki)
//   POST /api/plytki/games/:g/learn          gracz włącza sobie podpowiedzi (wszyscy widzą 🎓)

import { deal, play, swap, pass, RuleError } from '../../../public/punkty/plytki/engine.js';

const MAX_PLAYERS = 4;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pl_games (id TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
];
let schemaReady = false;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const cleanName = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
const newCode = () => Array.from(rand(6), x => CODE_CHARS[x % CODE_CHARS.length]).join('');
const newToken = () => Array.from(rand(16), x => x.toString(16).padStart(2, '0')).join('');
const newId = () => Array.from(rand(6), x => (x % 36).toString(36)).join('');
async function body(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'Zły format danych.'); }
}

async function load(db, g) {
  const row = await db.prepare('SELECT rev, status, data FROM pl_games WHERE id = ?').bind(g).first();
  if (!row) throw new HttpError(404, 'Nie ma takiej gry.');
  return { rev: row.rev, game: JSON.parse(row.data) };
}
// Zapis tylko wtedy, gdy nikt inny nie zmienił gry w międzyczasie.
async function store(db, g, rev, game) {
  const r = await db.prepare('UPDATE pl_games SET data = ?, status = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?')
    .bind(JSON.stringify(game), game.status, Date.now(), g, rev).run();
  if (!r.meta.changes) throw new HttpError(409, 'Ktoś właśnie wykonał ruch. Spróbuj jeszcze raz.');
  return rev + 1;
}

function view(game, rev, token) {
  const me = game.players.find(p => p.token && p.token === token);
  return {
    id: game.id, title: game.title, status: game.status, rev, pk: game.pk || null,
    turn: game.turn, bag: game.bag.length, board: game.board, last: game.last || null,
    players: game.players.map(p => ({ id: p.id, name: p.name, score: p.score, tiles: p.hand.length, moves: p.moves, learn: !!p.learn })),
    learnOk: !!game.learnOk,
    me: me ? { id: me.id, hand: me.hand } : null,
  };
}

function player(game, token) {
  const p = token && game.players.find(x => x.token === token);
  if (!p) throw new HttpError(403, 'Nie grasz w tej grze.');
  return p;
}

// Po zakończeniu gry wynik trafia do historii gry online licznika, jeśli gra była z nią połączona.
async function saveToCounter(db, game) {
  if (!game.pk) return;
  const pk = await db.prepare('SELECT id FROM pk_games WHERE id = ?').bind(game.pk).first().catch(() => null);
  if (!pk) return;
  const { results } = await db.prepare('SELECT id, name, color FROM pk_players WHERE game_id = ?').bind(game.pk).all();
  const byName = new Map(results.map(p => [p.name.trim().toLowerCase(), p]));
  const snapshot = {
    title: game.title || 'Płytki',
    players: game.players.map((p, i) => {
      const m = byName.get(p.name.trim().toLowerCase());
      return { id: m ? m.id : 'pl' + p.id, name: m ? m.name : p.name, color: m ? m.color : i, total: p.score, entries: p.moves.slice() };
    }),
  };
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO pk_rounds (id, game_id, finished_at, data) VALUES (?, ?, ?, ?)')
      .bind('pl' + game.id.toLowerCase(), game.pk, Date.now(), JSON.stringify(snapshot)),
    db.prepare('UPDATE pk_games SET rev = rev + 1, updated_at = ? WHERE id = ?').bind(Date.now(), game.pk),
  ]);
}

async function route(request, db, parts) {
  const m = request.method, token = request.headers.get('x-token') || '';
  if (parts[0] !== 'games') throw new HttpError(404, 'Nie ma takiego adresu.');

  if (parts.length === 1 && m === 'POST') {
    const data = await body(request);
    let code;
    for (let i = 0; i < 5 && !code; i++) {
      const c = newCode();
      if (!await db.prepare('SELECT 1 FROM pl_games WHERE id = ?').bind(c).first()) code = c;
    }
    if (!code) throw new HttpError(503, 'Spróbuj ponownie.');
    const pk = /^[A-Z0-9]{6}$/.test(String(data.pk || '')) ? data.pk : null;
    const game = { id: code, title: cleanName(data.title, 40), pk, status: 'lobby', turn: 0, bag: [], board: [], players: [], passes: 0 };
    const now = Date.now();
    await db.prepare('INSERT INTO pl_games (id, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(code, game.status, JSON.stringify(game), now, now).run();
    return json(view(game, 1, ''), 201);
  }

  const g = String(parts[1] || '').toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(g)) throw new HttpError(404, 'Nie ma takiej gry.');
  const action = parts[2] || '';

  if (!action && m === 'GET') {
    const since = Number(new URL(request.url).searchParams.get('rev'));
    if (since) {
      const row = await db.prepare('SELECT rev FROM pl_games WHERE id = ?').bind(g).first();
      if (!row) throw new HttpError(404, 'Nie ma takiej gry.');
      if (row.rev === since) return json({ rev: row.rev, same: true });
    }
    const { rev, game } = await load(db, g);
    return json(view(game, rev, token));
  }
  if (m !== 'POST') throw new HttpError(405, 'Niedozwolone.');

  const { rev, game } = await load(db, g);
  const data = await body(request);
  let reply = {};

  if (action === 'join') {
    if (game.status !== 'lobby') throw new HttpError(400, 'Gra już trwa, nie można dołączyć.');
    if (game.players.length >= MAX_PLAYERS) throw new HttpError(400, 'W grze może być najwyżej 4 graczy.');
    const name = cleanName(data.name, 24);
    if (!name) throw new HttpError(400, 'Wpisz swoje imię.');
    if (game.players.some(p => p.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'Ktoś już gra pod tym imieniem.');
    const p = { id: newId(), token: newToken(), name, score: 0, hand: [], moves: [] };
    game.players.push(p);
    reply = { token: p.token, id: p.id };
  } else if (action === 'start') {
    player(game, token);
    if (game.status !== 'lobby') throw new HttpError(400, 'Gra już się zaczęła.');
    deal(game, random);
  } else if (action === 'learn-ok') {
    player(game, token);
    if (game.status !== 'lobby') throw new HttpError(400, 'Gra już się zaczęła.');
    game.learnOk = !!data.on;
  } else if (action === 'learn') {
    const p = player(game, token);
    if (!game.learnOk) throw new HttpError(400, 'W tej grze podpowiedzi są wyłączone.');
    p.learn = true;
  } else if (action === 'play') {
    play(game, player(game, token), data.moves);
  } else if (action === 'swap') {
    swap(game, player(game, token), data.idx, random);
  } else if (action === 'pass') {
    pass(game, player(game, token));
  } else {
    throw new HttpError(404, 'Nie ma takiego adresu.');
  }

  const newRev = await store(db, g, rev, game);
  if (game.status === 'end' && action !== 'join') await saveToCounter(db, game).catch(e => console.error(e));
  return json({ ...view(game, newRev, reply.token || token), ...reply });
}

export async function onRequest({ request, env, params }) {
  const db = env.DB;
  if (!db) return json({ error: 'Baza danych nie jest podłączona (brak powiązania DB).' }, 503);
  try {
    if (!schemaReady) { await db.batch(SCHEMA.map(s => db.prepare(s))); schemaReady = true; }
    return await route(request, db, [].concat(params.path || []));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof RuleError) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: 'Błąd serwera.' }, 500);
  }
}
