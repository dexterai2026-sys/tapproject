import type { Action, ActionResult, Card, GameState } from '../engine/types';
import { currentPlayer } from '../engine/turns';
import { chat, type ChatOptions } from './openrouter';
import type { Moment } from './lines';
import type { Settings } from '../settings';
import type { TraceRef } from '../perf';

export interface CommentatorDeps {
  settings: () => Settings;
  speak: (text: string, opts?: { ssml?: boolean; plain?: string; trace?: TraceRef; kind?: string }) => void;
  pick: (moment: Moment, vars: Record<string, string>) => string;
  caption: (text: string) => void;
  notice?: (msg: string) => void;
  chatImpl?: (o: ChatOptions) => Promise<string>;
}

const LIVE_MOMENTS: Moment[] = ['play', 'drawTwo', 'win'];
const DRAMATIC: Moment[] = ['drawTwo', 'win'];
const SYSTEM =
  'You are the witty host of a card game night. Reply with ONE short playful sentence (max 18 words) reacting to the play. No emojis, no quotes, no rules advice.';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const cardName = (c: Card) => `${c.number === 11 ? 'skip' : c.number === 12 ? 'reverse' : c.number === 13 ? 'plus two' : c.number} of ${c.suit}s`;

export function momentFor(prev: GameState, action: Action, result: ActionResult): Moment | null {
  if (!result.ok) return null;
  const pub = result.state.public;
  // Setup, scanning, count corrections and scoring are bookkeeping: no commentary. Confirming a win is the win.
  if (action.type === 'confirm') return pub.winner ? 'win' : null;
  if (action.type !== 'play' && action.type !== 'draw' && action.type !== 'callLast') return null;
  if (pub.winner) return 'win';
  if (action.type === 'callLast') return 'lastCall';
  const missed = prev.public.lastCardPending && prev.public.lastCardPending !== action.player;
  if (missed) return 'lastMissed';
  if (action.type === 'draw') return 'draw';
  if (pub.status === 'confirming') return null; // their last card: wait for the table to confirm before reacting
  const top = pub.discard[pub.discard.length - 1] as Card;
  return top.number === 11 ? 'skip' : top.number === 12 ? 'reverse' : top.number === 13 ? 'drawTwo' : 'play';
}

/**
 * Reacts to game results. Purely a side-channel: it never touches game state,
 * and every failure degrades to a pre-written line.
 */
export class Commentator {
  private liveUsed = 0;
  constructor(private deps: CommentatorDeps) {}

  onResult(prev: GameState, action: Action, result: ActionResult, trace?: TraceRef): void {
    const s = this.deps.settings();
    if (s.commentary === 'off') return;
    const moment = momentFor(prev, action, result);
    if (!moment) return;
    const st = result.state;
    const nameOf = (id: string) => st.players.find((p) => p.id === id)?.name ?? id;
    const next = nameOf(currentPlayer(st.public.turn));
    const actor = 'player' in action ? action.player : (st.public.winner ?? '');
    const name = nameOf(moment === 'lastMissed' ? (prev.public.lastCardPending as string) : moment === 'win' ? (st.public.winner ?? actor) : actor);
    const top = st.public.discard[st.public.discard.length - 1] as Card;
    const vars = { name, next, card: cardName(top) };
    const finished = st.public.status === 'finished';

    const canned = this.deps.pick(moment, vars);
    const turnLine = finished || moment === 'win' ? '' : this.deps.pick('turn', vars);
    const emit = (line: string) => {
      const text = turnLine ? `${line} ${turnLine}` : line;
      trace?.markOnce('textReady');
      trace?.meta('moment', moment);
      this.deps.caption(text);
      trace?.markOnce('captionShown');
      // Two separate lines: the reaction is personality (may be slow or skipped), the turn announcement is functional (must be quick).
      if (DRAMATIC.includes(moment)) {
        this.deps.speak(`<speak>${esc(line)}<break time="400ms"/></speak>`, { ssml: true, plain: line, trace, kind: 'reaction' });
      } else this.deps.speak(line, { trace, kind: 'reaction' });
      if (turnLine) this.deps.speak(turnLine, { trace, kind: 'turn' });
    };

    if (s.commentary === 'live' && s.openrouterKey && LIVE_MOMENTS.includes(moment) && this.liveUsed < s.liveCap) {
      this.liveUsed++;
      trace?.meta('liveAI', true);
      const context = `${name} played ${cardName(top)}. Cards left: ${st.players.map((p) => `${p.name} ${st.public.handCounts[p.id]}`).join(', ')}.${moment === 'win' ? ` ${name} just won the game.` : ''}`;
      (this.deps.chatImpl ?? chat)({
        apiKey: s.openrouterKey,
        model: s.premiumModel,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: context }],
        maxTokens: 60,
        timeoutMs: 4000,
        onTiming: (t) => trace?.meta('liveAIMs', t.ms),
      })
        .then((line) => emit(line.replace(/^["']|["']$/g, '').slice(0, 200)))
        .catch((err: Error) => {
          this.deps.notice?.(`AI commentary unavailable (${err.message}); using built-in lines.`);
          emit(canned);
        });
      return;
    }
    emit(canned);
  }
}
