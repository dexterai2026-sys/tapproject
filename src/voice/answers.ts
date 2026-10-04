import type { GameState } from '../engine/types';
import { currentPlayer } from '../engine/turns';
import { restockDue } from '../engine/table';
import type { Tally } from '../save';
import { cardName } from '../ai/commentator';
import type { QueryType } from './command';

export const HELP_TEXT =
  'You can say: draw, last card, whose turn, score, how many cards, top card, repeat, undo, pause, or play again.';

export interface AnswerContext {
  state: GameState;
  tally: Tally;
  lastSpoken: string;
}

/** Spoken answers for read-only questions. They never change game state. */
export function answerQuery(type: QueryType, ctx: AnswerContext): string {
  const { state, tally } = ctx;
  const pub = state.public;
  const name = (id: string) => state.players.find((p) => p.id === id)?.name ?? id;

  switch (type) {
    case 'turn': {
      if (pub.status === 'setup') return 'The game has not started yet. Deal the cards, then flip and tap the first card.';
      if (pub.status === 'scanning') return `${name(pub.scanning?.player ?? '')} is tapping the cards they drew.`;
      if (pub.status === 'confirming') return `Waiting to confirm that ${name(pub.pendingWin ?? '')} is out.`;
      if (pub.status === 'scoring') return `${name(pub.winner ?? '')} is out. Tap the leftover cards to score.`;
      if (pub.status === 'finished') return `${name(pub.winner as string)} won this game.`;
      const extra = pub.pendingDraw ? ` They must play a plus two or draw ${pub.pendingDraw}.` : '';
      return `It's ${name(currentPlayer(pub.turn))}'s turn.${extra}`;
    }
    case 'cards':
      return `${state.players.map((p) => `${p.name} ${pub.handCounts[p.id] ?? 0}`).join(', ')} cards. Draw pile ${pub.drawPileCount}${restockDue(state) ? ': empty, shuffle the discards into a new pile' : ''}.`;
    case 'top':
      return pub.discard.length ? `The top card is the ${cardName(pub.discard[pub.discard.length - 1] as never)}.` : 'No card has been flipped yet.';
    case 'repeat':
      return ctx.lastSpoken || 'Nothing to repeat yet.';
    case 'help':
      return HELP_TEXT;
    case 'score': {
      let line: string;
      if (pub.status === 'finished') {
        const w = pub.winner as string;
        line = `${name(w)} won and scored ${pub.scores[w] ?? 0}.`;
      } else {
        const closest = [...state.players].sort((a, b) => (pub.handCounts[a.id] ?? 0) - (pub.handCounts[b.id] ?? 0))[0];
        line = `No points yet this game.${closest ? ` ${closest.name} is closest with ${pub.handCounts[closest.id] ?? 0} cards.` : ''}`;
      }
      const night = Object.entries(tally.wins).sort((a, b) => b[1] - a[1]);
      return night.length ? `${line} Game night: ${night.map(([n, w]) => `${n} ${w} win${w === 1 ? '' : 's'}`).join(', ')}.` : line;
    }
  }
}
