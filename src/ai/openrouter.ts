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
  /** Reports the round trip (non-streaming, so first byte ~ total). Observation only. */
  onTiming?: (t: { ms: number; ok: boolean }) => void;
}

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** One chat completion. The key is only ever sent to openrouter.ai. */
export async function chat(opts: ChatOptions): Promise<string> {
  if (!opts.apiKey) throw new AiError('No OpenRouter key set', 'auth');
  const ctl = new AbortController();
  const started = performance.now();
  let ok = false;
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
    ok = true;
    return text;
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (timedOut) throw new AiError('OpenRouter timed out', 'timeout');
    if (opts.signal?.aborted) throw new AiError('Cancelled', 'network');
    throw new AiError(`Network error: ${(err as Error).message}`, 'network');
  } finally {
    clearTimeout(timer);
    opts.onTiming?.({ ms: Math.round(performance.now() - started), ok });
  }
}

export type ModelCheck = { ok: true; name: string } | { ok: false; reason: string };

/** Ask OpenRouter whether a model id exists: GET /api/v1/model/{author}/{slug}. */
export async function checkModel(apiKey: string, modelId: string, fetchImpl: typeof fetch = fetch): Promise<ModelCheck> {
  const slash = modelId.indexOf('/');
  if (slash <= 0 || slash === modelId.length - 1) return { ok: false, reason: 'Expected an id like author/model-name' };
  if (!apiKey) return { ok: false, reason: 'No OpenRouter key set' };
  try {
    const res = await fetchImpl(`https://openrouter.ai/api/v1/model/${modelId.slice(0, slash)}/${modelId.slice(slash + 1)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 404) return { ok: false, reason: 'Unknown model id' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'Key rejected' };
    if (!res.ok) return { ok: false, reason: `Couldn't check (HTTP ${res.status})` };
    const data = (await res.json()) as { data?: { name?: string } };
    return { ok: true, name: data.data?.name ?? modelId };
  } catch (err) {
    return { ok: false, reason: `Couldn't check (${(err as Error).message})` };
  }
}
