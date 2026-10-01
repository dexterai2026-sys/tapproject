import { chat, type ChatOptions } from '../ai/openrouter';

export type VoiceCommand = { type: 'draw' } | { type: 'callLast' } | { type: 'unknown' };

const MAX_WORDS = 8; // commands are short; long utterances are table chatter

/** Text after the wake word, or null if the wake word wasn't said. */
export function stripWakeWord(transcript: string, wake: string): string | null {
  const t = transcript.toLowerCase();
  const w = wake.trim().toLowerCase();
  if (!w) return t.trim();
  const i = t.indexOf(w);
  return i === -1 ? null : t.slice(i + w.length).trim();
}

/** Deterministic grammar for this game's command vocabulary. */
export function parseCommand(text: string): VoiceCommand {
  const t = text.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > MAX_WORDS) return { type: 'unknown' };
  if (/\b(last card|one card( left)?|down to one|call it|uno)\b/.test(t)) return { type: 'callLast' };
  if (/\b(draw|pick (one )?up|i can'?t play|nothing to play|no play)\b/.test(t)) return { type: 'draw' };
  return { type: 'unknown' };
}

export interface ResolveOptions {
  apiKey?: string;
  model?: string;
  chatImpl?: (o: ChatOptions) => Promise<string>;
}

/** Local grammar first; the cheap model only as a fallback for odd phrasing. */
export async function resolveCommand(text: string, o: ResolveOptions = {}): Promise<VoiceCommand> {
  const local = parseCommand(text);
  if (local.type !== 'unknown' || !o.apiKey || !o.model) return local;
  if (text.trim().split(/\s+/).length > MAX_WORDS) return local;
  try {
    const reply = await (o.chatImpl ?? chat)({
      apiKey: o.apiKey,
      model: o.model,
      maxTokens: 10,
      temperature: 0,
      timeoutMs: 3000,
      messages: [
        { role: 'system', content: 'Classify a card-game voice command. Answer with exactly one word: draw, last, or none. "draw" = the speaker wants to draw a card. "last" = the speaker is announcing they have one card left.' },
        { role: 'user', content: text },
      ],
    });
    const w = reply.toLowerCase();
    if (/^draw/.test(w)) return { type: 'draw' };
    if (/^last/.test(w)) return { type: 'callLast' };
  } catch {
    /* fall through: unknown */
  }
  return { type: 'unknown' };
}
