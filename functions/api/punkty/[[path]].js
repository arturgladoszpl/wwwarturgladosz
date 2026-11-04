// API wspólnej gry dla licznika punktów (/punkty/).
// Cloudflare Pages Function z bazą D1 podpiętą jako `DB`.
//
//   POST   /api/punkty/games                         utwórz grę {title, players:[{id,name,entries:[{id,value}]}]}
//   GET    /api/punkty/games/:g?rev=N                stan gry (albo {rev} bez zmian, jeśli N jest aktualne)
//   PATCH  /api/punkty/games/:g                      {title}
//   POST   /api/punkty/games/:g/reset                wyzeruj punkty wszystkich
//   PUT    /api/punkty/games/:g/order                {ids:[...]} kolejność graczy
//   POST   /api/punkty/games/:g/players              {id, name}
//   PATCH  /api/punkty/games/:g/players/:p           {name}
//   DELETE /api/punkty/games/:g/players/:p
//   POST   /api/punkty/games/:g/players/:p/entries   {id, value}
//   DELETE /api/punkty/games/:g/entries/:e

const COLORS = 8, MAX_PLAYERS = 16, MAX_ENTRIES = 3000, MAX_VALUE = 1e6;
const KEEP_DAYS = 60;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ID_RE = /^[a-z0-9]{4,24}$/;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pk_games (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', rev INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pk_players (id TEXT NOT NULL, game_id TEXT NOT NULL, name TEXT NOT NULL, color INTEGER NOT NULL, pos INTEGER NOT NULL, PRIMARY KEY (game_id, id))`,
  `CREATE TABLE IF NOT EXISTS pk_entries (id TEXT NOT NULL, game_id TEXT NOT NULL, player_id TEXT NOT NULL, value INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (game_id, id))`,
  `CREATE INDEX IF NOT EXISTS pk_entries_player ON pk_entries (game_id, player_id, created_at)`,
];
let schemaReady = false;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const cleanName = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
function checkId(id) { if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, 'Zły identyfikator.'); return id; }
function checkValue(v) {
  if (!Number.isInteger(v) || Math.abs(v) > MAX_VALUE) throw new HttpError(400, 'Zła liczba punktów.');
  return v;
}
function newCode() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(b, x => CODE_CHARS[x % CODE_CHARS.length]).join('');
}
async function body(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'Zły format danych.'); }
}

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map(s => db.prepare(s)));
  schemaReady = true;
}

async function requireGame(db, g) {
  const row = await db.prepare('SELECT id, title, rev FROM pk_games WHERE id = ?').bind(g).first();
  if (!row) throw new HttpError(404, 'Nie ma takiej gry.');
  return row;
}
const bump = (db, g) => db.prepare('UPDATE pk_games SET rev = rev + 1, updated_at = ? WHERE id = ?').bind(Date.now(), g);

async function readGame(db, g) {
  const [game, players, entries] = await db.batch([
    db.prepare('SELECT id, title, rev FROM pk_games WHERE id = ?').bind(g),
    db.prepare('SELECT id, name, color FROM pk_players WHERE game_id = ? ORDER BY pos, rowid').bind(g),
    db.prepare('SELECT id, player_id, value FROM pk_entries WHERE game_id = ? ORDER BY created_at, rowid').bind(g),
  ]);
  const row = game.results[0];
  if (!row) throw new HttpError(404, 'Nie ma takiej gry.');
  const byPlayer = new Map(players.results.map(p => [p.id, { id: p.id, name: p.name, color: p.color, entries: [] }]));
  for (const e of entries.results) byPlayer.get(e.player_id)?.entries.push({ id: e.id, value: e.value });
  return { id: row.id, title: row.title, rev: row.rev, players: [...byPlayer.values()] };
}

async function freeColor(db, g) {
  const { results } = await db.prepare('SELECT color FROM pk_players WHERE game_id = ?').bind(g).all();
  const used = new Set(results.map(r => r.color));
  for (let i = 0; i < COLORS; i++) if (!used.has(i)) return i;
  return results.length % COLORS;
}

async function createGame(db, data) {
  const now = Date.now();
  const players = Array.isArray(data.players) ? data.players.slice(0, MAX_PLAYERS) : [];
  let code;
  for (let i = 0; i < 5 && !code; i++) {
    const c = newCode();
    if (!await db.prepare('SELECT 1 FROM pk_games WHERE id = ?').bind(c).first()) code = c;
  }
  if (!code) throw new HttpError(503, 'Spróbuj ponownie.');

  const stmts = [db.prepare('INSERT INTO pk_games (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(code, cleanName(data.title, 40), now, now)];
  let t = now, count = 0;
  players.forEach((p, i) => {
    const pid = checkId(p.id);
    const color = Number.isInteger(p.color) && p.color >= 0 ? p.color % COLORS : i % COLORS;
    stmts.push(db.prepare('INSERT INTO pk_players (id, game_id, name, color, pos) VALUES (?, ?, ?, ?, ?)')
      .bind(pid, code, cleanName(p.name, 24) || 'Gracz', color, i));
    for (const e of Array.isArray(p.entries) ? p.entries : []) {
      if (++count > MAX_ENTRIES) throw new HttpError(400, 'Za dużo wpisów.');
      stmts.push(db.prepare('INSERT INTO pk_entries (id, game_id, player_id, value, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(checkId(e.id), code, pid, checkValue(e.value), t++));
    }
  });
  await db.batch(stmts);

  // Sprzątanie starych gier przy okazji tworzenia nowej.
  const cutoff = now - KEEP_DAYS * 864e5;
  await db.batch([
    db.prepare('DELETE FROM pk_entries WHERE game_id IN (SELECT id FROM pk_games WHERE updated_at < ?)').bind(cutoff),
    db.prepare('DELETE FROM pk_players WHERE game_id IN (SELECT id FROM pk_games WHERE updated_at < ?)').bind(cutoff),
    db.prepare('DELETE FROM pk_games WHERE updated_at < ?').bind(cutoff),
  ]);
  return readGame(db, code);
}

async function route(request, db, parts) {
  const m = request.method;
  if (parts[0] !== 'games') throw new HttpError(404, 'Nie ma takiego adresu.');
  if (parts.length === 1) {
    if (m === 'POST') return json(await createGame(db, await body(request)), 201);
    throw new HttpError(405, 'Niedozwolone.');
  }

  const g = String(parts[1]).toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(g)) throw new HttpError(404, 'Nie ma takiej gry.');
  const rest = parts.slice(2);

  if (rest.length === 0 && m === 'GET') {
    const since = Number(new URL(request.url).searchParams.get('rev'));
    if (since) {
      const row = await requireGame(db, g);
      if (row.rev === since) return json({ rev: row.rev, same: true });
    }
    return json(await readGame(db, g));
  }

  await requireGame(db, g);
  let stmts;

  if (rest.length === 0 && m === 'PATCH') {
    const data = await body(request);
    stmts = [db.prepare('UPDATE pk_games SET title = ? WHERE id = ?').bind(cleanName(data.title, 40), g)];
  } else if (rest[0] === 'reset' && rest.length === 1 && m === 'POST') {
    stmts = [db.prepare('DELETE FROM pk_entries WHERE game_id = ?').bind(g)];
  } else if (rest[0] === 'order' && rest.length === 1 && m === 'PUT') {
    const data = await body(request);
    const ids = Array.isArray(data.ids) ? data.ids.slice(0, MAX_PLAYERS).map(checkId) : [];
    stmts = ids.map((id, i) => db.prepare('UPDATE pk_players SET pos = ? WHERE game_id = ? AND id = ?').bind(i, g, id));
  } else if (rest[0] === 'players' && rest.length === 1 && m === 'POST') {
    const data = await body(request);
    const id = checkId(data.id);
    const n = await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(pos), -1) AS last FROM pk_players WHERE game_id = ?').bind(g).first();
    if (n.n >= MAX_PLAYERS) throw new HttpError(400, 'Za dużo graczy.');
    stmts = [db.prepare('INSERT OR IGNORE INTO pk_players (id, game_id, name, color, pos) VALUES (?, ?, ?, ?, ?)')
      .bind(id, g, cleanName(data.name, 24) || 'Gracz', await freeColor(db, g), n.last + 1)];
  } else if (rest[0] === 'players' && rest.length === 2 && m === 'PATCH') {
    const data = await body(request);
    stmts = [db.prepare('UPDATE pk_players SET name = ? WHERE game_id = ? AND id = ?')
      .bind(cleanName(data.name, 24) || 'Gracz', g, checkId(rest[1]))];
  } else if (rest[0] === 'players' && rest.length === 2 && m === 'DELETE') {
    const pid = checkId(rest[1]);
    stmts = [
      db.prepare('DELETE FROM pk_entries WHERE game_id = ? AND player_id = ?').bind(g, pid),
      db.prepare('DELETE FROM pk_players WHERE game_id = ? AND id = ?').bind(g, pid),
    ];
  } else if (rest[0] === 'players' && rest[2] === 'entries' && rest.length === 3 && m === 'POST') {
    const data = await body(request);
    const pid = checkId(rest[1]);
    if (!await db.prepare('SELECT 1 FROM pk_players WHERE game_id = ? AND id = ?').bind(g, pid).first())
      throw new HttpError(404, 'Nie ma takiego gracza.');
    const n = await db.prepare('SELECT COUNT(*) AS n FROM pk_entries WHERE game_id = ?').bind(g).first();
    if (n.n >= MAX_ENTRIES) throw new HttpError(400, 'Za dużo wpisów.');
    stmts = [db.prepare('INSERT OR IGNORE INTO pk_entries (id, game_id, player_id, value, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(checkId(data.id), g, pid, checkValue(data.value), Date.now())];
  } else if (rest[0] === 'entries' && rest.length === 2 && m === 'DELETE') {
    stmts = [db.prepare('DELETE FROM pk_entries WHERE game_id = ? AND id = ?').bind(g, checkId(rest[1]))];
  } else {
    throw new HttpError(404, 'Nie ma takiego adresu.');
  }

  await db.batch([...stmts, bump(db, g)]);
  return json(await readGame(db, g));
}

export async function onRequest({ request, env, params }) {
  const db = env.DB;
  if (!db) return json({ error: 'Baza danych nie jest podłączona (brak powiązania DB).' }, 503);
  try {
    await ensureSchema(db);
    const parts = [].concat(params.path || []);
    return await route(request, db, parts);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Błąd serwera.' }, 500);
  }
}
