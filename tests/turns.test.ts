import { describe, expect, it } from 'vitest';
import { advance, createTurn, currentPlayer, reverse, skip } from '../src/engine/turns';

describe('turns', () => {
  const t = createTurn(['a', 'b', 'c', 'd']);
  it('rotates forward and wraps', () => {
    expect(currentPlayer(advance(t))).toBe('b');
    expect(currentPlayer(advance(t, 4))).toBe('a');
  });
  it('rotates backward after reverse and wraps', () => {
    const r = reverse(t);
    expect(currentPlayer(advance(r))).toBe('d');
    expect(currentPlayer(advance(r, 2))).toBe('c');
  });
  it('skip passes over one seat', () => {
    expect(currentPlayer(skip(t))).toBe('c');
  });
});
