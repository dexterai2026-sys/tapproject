import { chat, type ChatOptions } from '../ai/openrouter';

export type QueryType = 'turn' | 'score' | 'cards' | 'top' | 'repeat' | 'help';
export type VoiceCommand =
  | { type: 'draw' }
  | { type: 'callLast' }
  | { type: QueryType }
  | { type: 'pause' }
  | { type: 'again' }
  | { type: 'unknown' };

const MAX_WORDS = 8; // commands are short; long utterances are table chatter

const words = (t: string): string[] => t.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      (d[i] as number[])[j] = Math.min(
        (d[i - 1] as number[])[j]! + 1,
        (d[i] as number[])[j - 1]! + 1,
        (d[i - 1] as number[])[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/** Common recognizer mishearings of the default wake phrase. */
const ALIASES: Record<string, string[]> = {
  hey: ['hay', 'hi', 'hei', 'hey'],
  deck: ['dec', 'dek', 'deke', 'decks', 'tech', 'deck'],
};

function heardAs(heard: string, expected: string): boolean {
  if (heard === expected || ALIASES[expected]?.includes(heard)) return true;
  return expected.length >= 4 && distance(heard, expected) <= 1; // typo-tolerant for longer words only
}

/** Text after the wake phrase (normalized, lowercase), or null if it wasn't said. */
export function stripWakeWord(transcript: string, wake: string): string | null {
  const heard = words(transcript);
  const target = words(wake);
  if (target.length === 0) return heard.join(' ');
  for (let i = 0; i + target.length <= heard.length; i++) {
    if (target.every((w, j) => heardAs(heard[i + j] as string, w))) return heard.slice(i + target.length).join(' ');
  }
  return null;
}

/** Deterministic grammar for this game's command vocabulary. Order matters: first match wins. */
export function parseCommand(text: string): VoiceCommand {
  const w = words(text);
  const t = w.join(' ');
  if (!t || w.length > MAX_WORDS) return { type: 'unknown' };
  if (/\b(last card|one card( left)?|down to one|call it|uno)\b/.test(t)) return { type: 'callLast' };
  if (/\b(draw|pick (one )?up|i can'?t play|nothing to play|no play)\b/.test(t)) return { type: 'draw' };
  if (/\b(whose|who'?s|who is) (turn|up|next|go|move|going|playing)\b/.test(t) || /\b(who goes next|who plays next|my turn|whose go)\b/.test(t)) return { type: 'turn' };
  if (/\b(how many cards|card count|cards left|cards are left|how many (do|does)|how many in)\b/.test(t)) return { type: 'cards' };
  if (/\b(score|scores|points|who('?s| is) (winning|ahead|leading|in the lead)|how am i doing)\b/.test(t)) return { type: 'score' };
  if (/\b(top card|on top|what card is (up|showing|out)|what'?s showing|current card)\b/.test(t)) return { type: 'top' };
  if (/\b(repeat|say that again|say again|what was that)\b/.test(t)) return { type: 'repeat' };
  if (/\b(help|what can i say|commands)\b/.test(t)) return { type: 'help' };
  if (/\bpause\b/.test(t)) return { type: 'pause' };
  if (/\b(play again|new game|rematch)\b/.test(t)) return { type: 'again' };
  return { type: 'unknown' };
}

const LABELS: Record<string, VoiceCommand> = {
  draw: { type: 'draw' }, last: { type: 'callLast' }, turn: { type: 'turn' }, score: { type: 'score' },
  cards: { type: 'cards' }, top: { type: 'top' }, repeat: { type: 'repeat' }, help: { type: 'help' },
  pause: { type: 'pause' }, again: { type: 'again' },
};

export interface ResolveOptions {
  apiKey?: string;
  model?: string;
  chatImpl?: (o: ChatOptions) => Promise<string>;
  /** Called with the model round trip when the OpenRouter fallback was needed. */
  onFallbackTiming?: (ms: number) => void;
}

/** How a command was understood: our own grammar, the fallback model, or not at all. */
export type ResolvedVia = 'grammar' | 'model' | 'none';

export interface Resolved {
  cmd: VoiceCommand;
  via: ResolvedVia;
  modelMs?: number;
}

/** Local grammar first; the cheap model only as a fallback for odd phrasing. */
export async function resolveDetailed(text: string, o: ResolveOptions = {}): Promise<Resolved> {
  const local = parseCommand(text);
  if (local.type !== 'unknown') return { cmd: local, via: 'grammar' };
  if (!o.apiKey || !o.model || words(text).length > MAX_WORDS) return { cmd: local, via: 'none' };
  const started = performance.now();
  let cmd: VoiceCommand = { type: 'unknown' };
  try {
    const reply = await (o.chatImpl ?? chat)({
      apiKey: o.apiKey,
      model: o.model,
      maxTokens: 10,
      temperature: 0,
      timeoutMs: 3000,
      messages: [
        { role: 'system', content: 'Classify a card-game voice command. Answer with exactly one word from: draw (wants to draw a card), last (announcing one card left), turn (asking whose turn), score (asking the score), cards (asking card counts), top (asking the top card), repeat (asking to repeat), help (asking what they can say), pause (pause the game), again (play another game), none.' },
        { role: 'user', content: text },
      ],
    });
    const word = reply.toLowerCase().match(/[a-z]+/)?.[0] ?? '';
    cmd = LABELS[word] ?? { type: 'unknown' };
  } catch {
    /* fall through: unknown */
  }
  const modelMs = Math.round(performance.now() - started);
  o.onFallbackTiming?.(modelMs);
  return { cmd, via: cmd.type === 'unknown' ? 'none' : 'model', modelMs };
}

export async function resolveCommand(text: string, o: ResolveOptions = {}): Promise<VoiceCommand> {
  return (await resolveDetailed(text, o)).cmd;
}
