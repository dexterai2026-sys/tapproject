import { describe, expect, it } from 'vitest';
import { HELP_TEXT, answerQuery } from '../src/voice/answers';
import { matchingGame } from '../src/games/matching';
import { applyAction, startGame } from '../src/engine/engine';
import { STANDARD_DECK, mulberry32 } from '../src/engine/deck';
import type { Card, GameState } from '../src/engine/types';

const rng = mulberry32(9);
const card = (id: string) => STANDARD_DECK.find((c) => c.id === id) as Card;
const players = [{ id: 'p0', name: 'Sam' }, { id: 'p1', name: 'Lee' }, { id: 'p2', name: 'Kai' }];
function game(hands: string[][], top = 'star-5'): GameState {
  const s = startGame(matchingGame, players, rng);
  hands.forEach((h, i) => (s.private[`p${i}`] = { hand: h.map(card) }));
  s.public.discard = [card(top)];
  s.public.handCounts = Object.fromEntries(hands.map((h, i) => [`p${i}`, h.length]));
  return s;
}
const noTally = { games: 0, wins: {} };
const ask = (t: Parameters<typeof answerQuery>[0], s: GameState, tally = noTally, lastSpoken = '') => answerQuery(t, { state: s, tally, lastSpoken });

describe('answerQuery', () => {
  const s = game([['star-9', 'circle-1', 'square-2'], ['circle-8'], ['star-1', 'star-2']]);
  it('turn names the current player, and notes a pending +2', () => {
    expect(ask('turn', s)).toBe("It's Sam's turn.");
    const p = structuredClone(s); p.public.pendingDraw = 4;
    expect(ask('turn', p)).toContain('must play a plus two or draw 4');
  });
  it('cards lists everyone in seat order', () => {
    expect(ask('cards', s)).toMatch(/^Sam 3, Lee 1, Kai 2 cards\. Draw pile \d+\.$/);
  });
  it('top reads the top card, using the special-card names', () => {
    expect(ask('top', s)).toBe('The top card is the 5 of stars.');
    expect(ask('top', game([['star-9']], 'square-13'))).toContain('plus two');
  });
  it('score mid-game: no points yet, closest player, and game-night wins', () => {
    expect(ask('score', s)).toBe('No points yet this game. Lee is closest with 1 cards.');
    expect(ask('score', s, { games: 3, wins: { Sam: 1, Lee: 2 } })).toContain('Game night: Lee 2 wins, Sam 1 win.');
  });
  it('score after a win reports the winner and points; turn says who won', () => {
    const w = game([['star-9'], ['circle-8', 'circle-13'], ['star-1']]);
    const done = applyAction(matchingGame, w, { type: 'play', player: 'p0', cardId: 'star-9' }, rng).state;
    expect(ask('score', done)).toBe('Sam won and scored 19.');
    expect(ask('turn', done)).toBe('Sam won this game.');
  });
  it('repeat returns the last spoken line, or a fallback', () => {
    expect(ask('repeat', s, noTally, 'Nice, 5 of stars.')).toBe('Nice, 5 of stars.');
    expect(ask('repeat', s)).toBe('Nothing to repeat yet.');
  });
  it('help lists every command', () => {
    const t = ask('help', s);
    expect(t).toBe(HELP_TEXT);
    for (const w of ['draw', 'last card', 'whose turn', 'score', 'how many cards', 'top card', 'repeat', 'pause', 'play again']) expect(t).toContain(w);
  });
  it('queries never change game state', () => {
    const before = JSON.stringify(s);
    for (const t of ['turn', 'score', 'cards', 'top', 'repeat', 'help'] as const) ask(t, s);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('answerQuery for the physical-table phases', () => {
  const base = () => startGame(matchingGame, players, rng, { mode: 'physical', knowledge: 'counts', deck: STANDARD_DECK.map((c) => c.id), handSize: 7 });
  it('before the first card: turn and top card say the game has not started', () => {
    const s = base();
    expect(ask('turn', s)).toMatch(/has not started yet/);
    expect(ask('top', s)).toBe('No card has been flipped yet.');
    expect(ask('cards', s)).toMatch(/^Sam 7, Lee 7, Kai 7 cards\. Draw pile \d+/);
  });
  it('while confirming or scoring, the answers name who and what is pending', () => {
    const s = base();
    const c = structuredClone(s); c.public.status = 'confirming'; c.public.pendingWin = 'p1';
    expect(ask('turn', c)).toBe('Waiting to confirm that Lee is out.');
    const sc = structuredClone(s); sc.public.status = 'scoring'; sc.public.winner = 'p2';
    expect(ask('turn', sc)).toBe('Kai is out. Tap the leftover cards to score.');
    const sn = structuredClone(s); sn.public.status = 'scanning'; sn.public.scanning = { player: 'p0', remaining: 2 };
    expect(ask('turn', sn)).toBe('Sam is tapping the cards they drew.');
  });
});
