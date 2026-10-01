export type AiErrorKind = 'auth' | 'rate' | 'http' | 'network' | 'timeout' | 'empty';

export class AiError extends Error {
  constructor(message: string, public kind: AiErrorKind, public status?: number) {
    super(message);
    this.name = 'AiError';
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** One chat completion. The key is only ever sent to openrouter.ai. */
export async function chat(opts: ChatOptions): Promise<string> {
  if (!opts.apiKey) throw new AiError('No OpenRouter key set', 'auth');
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, opts.timeoutMs ?? 4000);
  opts.signal?.addEventListener('abort', () => ctl.abort());
  try {
    const res = await (opts.fetchImpl ?? fetch)(OPENROUTER_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Tap Cards',
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 80,
        temperature: opts.temperature ?? 0.9,
      }),
    });
    if (!res.ok) {
      const kind: AiErrorKind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate' : 'http';
      throw new AiError(`OpenRouter ${res.status}`, kind, res.status);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new AiError('OpenRouter returned no text', 'empty');
    return text;
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (timedOut) throw new AiError('OpenRouter timed out', 'timeout');
    if (opts.signal?.aborted) throw new AiError('Cancelled', 'network');
    throw new AiError(`Network error: ${(err as Error).message}`, 'network');
  } finally {
    clearTimeout(timer);
  }
}
