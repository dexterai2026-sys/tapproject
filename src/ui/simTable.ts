import { shuffle } from '../engine/deck';
import { handCount } from '../engine/table';
import type { Action, Card, GameState, PlayerId, Rng } from '../engine/types';

/**
 * Stand-in for real people with real cards, used by the simulator. It deals real hands and a real
 * pile that the engine never looks at: the engine only ever sees taps and declared draws, exactly
 * as it will with NFC cards. The simulator panel reads hands from here to know what can be tapped.
 */
export interface SimSnapshot {
  hands: Record<PlayerId, Card[]>;
  pile: Card[];
  discard: Card[];
}

export class SimTable {
  hands: Record<PlayerId, Card[]> = {};
  pile: Card[];
  discard: Card[] = [];

  constructor(deck: Card[], playerIds: PlayerId[], handSize: number, private rng: Rng) {
    this.pile = shuffle(deck, rng);
    for (const id of playerIds) this.hands[id] = this.pile.splice(-handSize);
  }

  static restore(snap: SimSnapshot, rng: Rng): SimTable {
    const t = new SimTable([], [], 0, rng);
    t.hands = structuredClone(snap.hands);
    t.pile = structuredClone(snap.pile);
    t.discard = structuredClone(snap.discard);
    return t;
  }

  snapshot(): SimSnapshot {
    return structuredClone({ hands: this.hands, pile: this.pile, discard: this.discard });
  }

  /** Turn over the next card for the start of the pile. A special card is put back and another is flipped, as the rules say. */
  flip(): Card | undefined {
    for (let i = 0; i < this.pile.length; i++) {
      const c = this.pile.pop() as Card;
      if (c.number > 10 && this.pile.length > 0) {
        this.pile.unshift(c);
        continue;
      }
      this.discard.push(c);
      return c;
    }
    return undefined;
  }

  /** Play a card from a hand onto the pile. */
  play(player: PlayerId, cardId: string): boolean {
    const hand = this.hands[player] ?? [];
    const i = hand.findIndex((c) => c.id === cardId);
    if (i < 0) return false;
    this.discard.push(hand.splice(i, 1)[0] as Card);
    return true;
  }

  /** Pick up cards. When the pile is empty the discard pile (minus its top card) is reshuffled into a new pile. */
  draw(player: PlayerId, n: number): Card[] {
    const got: Card[] = [];
    for (let i = 0; i < n; i++) {
      if (this.pile.length === 0 && this.discard.length > 1) {
        const top = this.discard.pop() as Card;
        this.pile = shuffle(this.discard, this.rng);
        this.discard = [top];
      }
      const c = this.pile.pop();
      if (!c) break;
      (this.hands[player] ??= []).push(c);
      got.push(c);
    }
    return got;
  }

  /** A card goes back to the bottom of the pile (the count was corrected downwards). */
  giveBack(player: PlayerId): void {
    const c = (this.hands[player] ?? []).pop();
    if (c) this.pile.unshift(c);
  }

  leftover(except: PlayerId): Card[] {
    return Object.entries(this.hands).filter(([id]) => id !== except).flatMap(([, h]) => h);
  }
}

/**
 * Keep the simulated hands in step with what the engine just did: a played card leaves its hand,
 * and any extra cards the engine says a player now holds (declared draws, penalties, count
 * corrections) are drawn from the simulated pile. Returns the cards each player just picked up.
 */
export function syncSim(sim: SimTable, before: GameState, after: GameState, action: Action): Record<PlayerId, Card[]> {
  const drawn: Record<PlayerId, Card[]> = {};
  const actor = 'player' in action ? action.player : null;
  const playedHere = action.type === 'play' && sim.hands[action.player]?.some((c) => c.id === action.cardId);
  const extraOf = (id: PlayerId) => handCount(after, id) - (handCount(before, id) - (action.type === 'play' && actor === id ? 1 : 0));
  const apply = (id: PlayerId) => {
    const extra = extraOf(id);
    if (extra > 0) drawn[id] = sim.draw(id, extra);
    else if (extra < 0) for (let i = 0; i < -extra; i++) sim.giveBack(id);
  };
  // The engine settles a missed "last card" (the penalty draw) before the actor's own play or draw, so the
  // pile and any reshuffle must be played out in that same order.
  for (const p of after.players) if (p.id !== actor) apply(p.id);
  if (action.type === 'play' && playedHere) sim.play(action.player, action.cardId);
  if (actor) apply(actor);
  return drawn;
}
