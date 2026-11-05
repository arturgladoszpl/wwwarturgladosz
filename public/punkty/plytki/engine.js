// Przebieg partii: rozdanie, ruch, wymiana, pas, koniec gry.
// Wspólne dla serwera (gra online) i przeglądarki (gra offline z komputerem).
// Stan gry: {status, turn, bag, board:[[x,y,t]], players:[{id, name, score, hand, moves}], passes, last}

import { checkMove, newBag, shuffle, key, HAND, BONUS } from './rules.js';

export class RuleError extends Error {}

// Rozdaje płytki i losuje kolejność graczy.
export function deal(game, random = Math.random) {
  game.bag = newBag(random);
  shuffle(game.players, random);
  for (const p of game.players) { p.hand = game.bag.splice(0, HAND); p.score = 0; p.moves = []; }
  game.board = [];
  game.status = 'play';
  game.turn = 0;
  game.passes = 0;
  game.last = null;
  return game;
}

export const boardMap = game => new Map(game.board.map(([x, y, t]) => [key(x, y), t]));
export const current = game => game.players[game.turn];

function onTurn(game, p) {
  if (game.status !== 'play') throw new RuleError(game.status === 'end' ? 'Gra jest zakończona.' : 'Gra jeszcze się nie zaczęła.');
  if (current(game).id !== p.id) throw new RuleError('Teraz nie jest Twój ruch.');
}
const next = game => { game.turn = (game.turn + 1) % game.players.length; };

// moves: [{i, x, y}], i = numer płytki na ręce gracza.
export function play(game, p, moves) {
  onTurn(game, p);
  if (!Array.isArray(moves)) throw new RuleError('Zły ruch.');
  const used = new Set();
  for (const mv of moves) {
    if (!Number.isInteger(mv.i) || mv.i < 0 || mv.i >= p.hand.length || used.has(mv.i)) throw new RuleError('Zła płytka.');
    if (!Number.isInteger(mv.x) || !Number.isInteger(mv.y) || Math.abs(mv.x) > 200 || Math.abs(mv.y) > 200) throw new RuleError('Złe pole.');
    used.add(mv.i);
  }
  const placed = moves.map(mv => ({ x: mv.x, y: mv.y, t: p.hand[mv.i] }));
  const res = checkMove(boardMap(game), placed);
  if (!res.ok) throw new RuleError(res.error);
  for (const c of placed) game.board.push([c.x, c.y, c.t]);
  p.hand = p.hand.filter((_, i) => !used.has(i));
  p.hand.push(...game.bag.splice(0, HAND - p.hand.length));
  let score = res.score;
  if (!p.hand.length && !game.bag.length) { score += BONUS; game.status = 'end'; }
  p.score += score;
  p.moves.push(score);
  game.passes = 0;
  game.last = { player: p.id, cells: placed.map(c => [c.x, c.y]), score, finished: game.status === 'end' };
  if (game.status !== 'end') next(game);
  return score;
}

export function swap(game, p, idx, random = Math.random) {
  onTurn(game, p);
  idx = [...new Set(Array.isArray(idx) ? idx : [])].filter(i => Number.isInteger(i) && i >= 0 && i < p.hand.length);
  if (!idx.length) throw new RuleError('Zaznacz płytki do wymiany.');
  if (game.bag.length < idx.length) throw new RuleError('W worku jest za mało płytek.');
  const out = idx.map(i => p.hand[i]);
  p.hand = p.hand.filter((_, i) => !idx.includes(i)).concat(game.bag.splice(0, idx.length));
  game.bag.push(...out);
  shuffle(game.bag, random);
  p.moves.push(0);
  game.passes = 0;
  game.last = { player: p.id, cells: [], score: 0, swapped: out.length };
  next(game);
}

export function pass(game, p) {
  onTurn(game, p);
  if (game.bag.length) throw new RuleError('Dopóki worek nie jest pusty, możesz wymienić płytki zamiast pasować.');
  p.moves.push(0);
  game.passes = (game.passes || 0) + 1;
  game.last = { player: p.id, cells: [], score: 0, passed: true };
  // Gdy nikt nie może się ruszyć, gra się kończy.
  if (game.passes >= game.players.length) game.status = 'end';
  else next(game);
}
