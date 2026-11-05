// Zasady gry w płytki: wspólne dla strony i serwera (functions/api/plytki).
// Płytka to liczba 0–35: kolor * 6 + kształt. W worku każda jest 3 razy (108 płytek).

export const COLORS = ['#EF4A6B', '#F7984A', '#FFE11A', '#1FA94E', '#1EA8E6', '#9067D6'];
export const COLOR_NAMES = ['czerwony', 'pomarańczowy', 'żółty', 'zielony', 'niebieski', 'fioletowy'];
export const SHAPES = ['kółko', 'kwadrat', 'romb', 'koniczyna', 'gwiazdka', 'gwiazda'];
export const HAND = 6, LINE = 6, BONUS = 6;

export const colorOf = t => Math.floor(t / 6);
export const shapeOf = t => t % 6;
export const key = (x, y) => x + ',' + y;

export function newBag(random = Math.random) {
  const bag = [];
  for (let c = 0; c < 3; c++) for (let t = 0; t < 36; t++) bag.push(t);
  return shuffle(bag, random);
}
export function shuffle(a, random = Math.random) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Linia jest poprawna, gdy wszystkie płytki mają ten sam kolor i różne kształty
// albo ten sam kształt i różne kolory, i jest ich najwyżej 6.
export function lineOk(tiles) {
  if (tiles.length <= 1) return true;
  if (tiles.length > LINE || new Set(tiles).size !== tiles.length) return false;
  return new Set(tiles.map(colorOf)).size === 1 || new Set(tiles.map(shapeOf)).size === 1;
}

// Płytki w linii przez (x, y) w kierunku (dx, dy), łącznie z (x, y).
function lineAt(board, x, y, dx, dy) {
  let sx = x, sy = y;
  while (board.has(key(sx - dx, sy - dy))) { sx -= dx; sy -= dy; }
  const out = [];
  for (let cx = sx, cy = sy; board.has(key(cx, cy)); cx += dx, cy += dy) out.push(board.get(key(cx, cy)));
  return out;
}

// board: Map "x,y" -> płytka. moves: [{x, y, t}].
// Zwraca {ok:true, score, lines} albo {ok:false, error}.
export function checkMove(board, moves) {
  if (!moves.length) return { ok: false, error: 'Połóż przynajmniej jedną płytkę.' };
  const seen = new Set();
  for (const m of moves) {
    const k = key(m.x, m.y);
    if (board.has(k) || seen.has(k)) return { ok: false, error: 'To pole jest już zajęte.' };
    seen.add(k);
  }
  const sameX = moves.every(m => m.x === moves[0].x), sameY = moves.every(m => m.y === moves[0].y);
  if (!sameX && !sameY) return { ok: false, error: 'Płytki muszą leżeć w jednej linii.' };

  const next = new Map(board);
  for (const m of moves) next.set(key(m.x, m.y), m.t);

  if (board.size && !moves.some(m => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => board.has(key(m.x + dx, m.y + dy)))))
    return { ok: false, error: 'Płytki muszą dotykać tych, które już leżą.' };

  // Bez przerw: wszystkie położone płytki muszą tworzyć jedną ciągłą linię.
  if (moves.length > 1) {
    const a = moves.map(m => (sameY ? m.x : m.y));
    const lo = Math.min(...a), hi = Math.max(...a), fixed = sameY ? moves[0].y : moves[0].x;
    for (let i = lo; i <= hi; i++) if (!next.has(sameY ? key(i, fixed) : key(fixed, i)))
      return { ok: false, error: 'W linii nie może być przerwy.' };
  }

  // Każda linia przechodząca przez położoną płytkę musi być poprawna; punkty za linie z ≥2 płytkami.
  const lines = [], counted = new Set();
  for (const m of moves) for (const [dx, dy] of [[1, 0], [0, 1]]) {
    let sx = m.x, sy = m.y;
    while (next.has(key(sx - dx, sy - dy))) { sx -= dx; sy -= dy; }
    const id = sx + ',' + sy + ',' + dx;
    if (counted.has(id)) continue;
    counted.add(id);
    const line = lineAt(next, m.x, m.y, dx, dy);
    if (!lineOk(line)) return { ok: false, error: line.length > LINE ? 'Linia może mieć najwyżej 6 płytek.' : 'W linii płytki muszą mieć wspólny kolor albo kształt, bez powtórek.' };
    if (line.length > 1) lines.push(line.length);
  }
  let score = lines.reduce((s, n) => s + n + (n === LINE ? BONUS : 0), 0);
  if (!score) score = 1;
  return { ok: true, score, lines };
}
