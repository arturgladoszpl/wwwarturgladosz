// Komputerowy przeciwnik w grze w płytki. Trzy poziomy:
//   easy   – losowy poprawny ruch, zwykle krótki; nie szuka pełnych szóstek
//   medium – zwykle ruch za najwięcej punktów, czasem słabszy
//   hard   – spośród najlepszych ruchów wybiera ten, po którym rywal ma najmniejszą szansę
//            na duży wynik (np. domknięcie linii z 5 płytkami), i dba o dobre płytki na ręce
// Wagi dobrane turniejami komputerów między sobą.

import { checkMove, key, colorOf, shapeOf } from './rules.js';
import { boardMap } from './engine.js';

export const W = { slip: 0.35, top: 12, threat: 0.7, keep: 0.3 };
export const LEVELS = { easy: 'Łatwy', medium: 'Średni', hard: 'Trudny' };
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Wszystkie poprawne ruchy z danej ręki: [{moves:[{i,x,y}], score, lines}].
export function allMoves(board, hand) {
  const spots = new Set();
  if (!board.size) spots.add(key(0, 0));
  for (const k of board.keys()) {
    const [x, y] = k.split(',').map(Number);
    for (const [dx, dy] of DIRS) if (!board.has(key(x + dx, y + dy))) spots.add(key(x + dx, y + dy));
  }
  const found = new Map();
  const tiles = mv => mv.map(m => ({ x: m.x, y: m.y, t: hand[m.i] }));
  const remember = (mv, res) => {
    const id = mv.map(m => m.i + '@' + m.x + ',' + m.y).sort().join(';');
    if (!found.has(id)) found.set(id, { moves: mv, score: res.score, lines: res.lines });
  };
  // Rozbudowa ruchu wzdłuż jednej osi: kolejna płytka na najbliższym wolnym polu za ciągiem płytek.
  const extend = (mv, axis) => {
    if (mv.length >= hand.length) return;
    const taken = new Map(board);
    for (const m of mv) taken.set(key(m.x, m.y), hand[m.i]);
    for (const sign of [1, -1]) {
      const [dx, dy] = axis === 'x' ? [sign, 0] : [0, sign];
      let { x, y } = mv[0];
      while (taken.has(key(x, y))) { x += dx; y += dy; }
      for (let i = 0; i < hand.length; i++) {
        if (mv.some(m => m.i === i)) continue;
        const next = [...mv, { i, x, y }];
        const res = checkMove(board, tiles(next));
        if (res.ok) { remember(next, res); extend(next, axis); }
      }
    }
  };
  for (const s of spots) {
    const [x, y] = s.split(',').map(Number);
    const seen = new Set();
    for (let i = 0; i < hand.length; i++) {
      if (seen.has(hand[i])) continue;
      seen.add(hand[i]);
      const mv = [{ i, x, y }];
      const res = checkMove(board, tiles(mv));
      if (!res.ok) continue;
      remember(mv, res);
      extend(mv, 'x');
      extend(mv, 'y');
    }
  }
  return [...found.values()];
}

// Rodzaje płytek, które rywale mogą jeszcze mieć: nie leżą na planszy i nie są na mojej ręce.
function unseenTiles(game, p) {
  const left = new Array(36).fill(3);
  for (const [, , t] of game.board) left[t]--;
  for (const t of p.hand) left[t]--;
  return left.map((n, t) => (n > 0 ? t : -1)).filter(t => t >= 0);
}

// Najwięcej punktów, jakie rywal zdobyłby jedną płytką po moim ruchu – przybliżenie zagrożenia
// (np. linia z 5 płytkami, którą da się domknąć za 12).
function threat(board, unseen) {
  let best = 0;
  const spots = new Set();
  for (const k of board.keys()) {
    const [x, y] = k.split(',').map(Number);
    for (const [dx, dy] of DIRS) if (!board.has(key(x + dx, y + dy))) spots.add(key(x + dx, y + dy));
  }
  for (const s of spots) {
    const [x, y] = s.split(',').map(Number);
    for (const t of unseen) {
      const r = checkMove(board, [{ x, y, t }]);
      if (r.ok && r.score > best) best = r.score;
    }
  }
  return best;
}

// Jak dobrze pasują do siebie płytki, które zostają na ręce (więcej wspólnych cech = lepiej).
function keepValue(hand, used) {
  const rest = hand.filter((_, i) => !used.has(i));
  let v = 0;
  for (let a = 0; a < rest.length; a++) for (let b = a + 1; b < rest.length; b++) {
    if (rest[a] === rest[b]) v -= 1;
    else if (colorOf(rest[a]) === colorOf(rest[b]) || shapeOf(rest[a]) === shapeOf(rest[b])) v += 0.5;
  }
  return v;
}

// Płytki do wymiany: powtórki i te, które najmniej pasują do reszty.
function swapPick(hand, bagSize, level) {
  const fit = hand.map((t, i) => hand.reduce((s, u, j) => s + (i !== j && u !== t && (colorOf(u) === colorOf(t) || shapeOf(u) === shapeOf(t)) ? 1 : 0), 0));
  const dup = hand.map((t, i) => hand.indexOf(t) !== i);
  let idx = hand.map((_, i) => i).filter(i => dup[i] || fit[i] <= (level === 'easy' ? 5 : 1));
  if (!idx.length) idx = hand.map((_, i) => i);
  return idx.slice(0, bagSize);
}

// Decyzja komputera: {type:'play', moves} | {type:'swap', idx} | {type:'pass'}.
export function decide(game, p, level = 'medium', random = Math.random) {
  const board = boardMap(game);
  const moves = allMoves(board, p.hand);
  if (!moves.length) {
    return game.bag.length ? { type: 'swap', idx: swapPick(p.hand, game.bag.length, level) } : { type: 'pass' };
  }
  if (level === 'easy') {
    const short = moves.filter(m => m.moves.length <= 2 && m.score < 12);
    const pool = short.length ? short : moves;
    return { type: 'play', moves: pool[Math.floor(random() * pool.length)].moves };
  }
  if (level === 'medium') {
    // Zwykle najlepszy ruch, ale co jakiś czas „przeoczenie”: dobry, choć nie najlepszy.
    const best = Math.max(...moves.map(m => m.score));
    const pool = random() < W.slip ? moves.filter(m => m.score >= best * 0.5 && m.score < best) : [];
    const top = pool.length ? pool : moves.filter(m => m.score === best);
    return { type: 'play', moves: top[Math.floor(random() * top.length)].moves };
  }
  // hard: kilka najlepszych ruchów, każdy oceniony też przez to, co zostawia rywalowi
  const unseen = unseenTiles(game, p);
  const cands = moves.slice().sort((a, b) => b.score - a.score).slice(0, W.top);
  let bestMove = null, bestValue = -Infinity;
  for (const m of cands) {
    const used = new Set(m.moves.map(x => x.i));
    const next = new Map(board);
    for (const x of m.moves) next.set(key(x.x, x.y), p.hand[x.i]);
    const value = m.score - W.threat * threat(next, unseen) + keepValue(p.hand, used) * W.keep;
    if (value > bestValue || (value === bestValue && random() < 0.5)) { bestValue = value; bestMove = m; }
  }
  return { type: 'play', moves: bestMove.moves };
}
