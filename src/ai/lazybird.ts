import { AiError } from './openrouter';

// Per Lazybird's API reference: X-API-Key auth, GET /voices, POST /generate-speech -> audio/mpeg.
// Their docs advise calling the API from a server, not browser code (see README).
export const LAZYBIRD_BASE = 'https://api.lazybird.app/v1';
export const VOICES_PATH = '/voices';
export const SPEECH_PATH = '/generate-speech';

export interface Voice {
  id: string;
  name: string;
  language?: string;
}

interface Opts {
  apiKey: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

async function call(path: string, init: RequestInit, o: Opts): Promise<Response> {
  if (!o.apiKey) throw new AiError('No Lazybird key set', 'auth');
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(LAZYBIRD_BASE + path, {
      ...init,
      signal: o.signal,
      headers: { 'X-API-Key': o.apiKey, ...(init.headers ?? {}) },
    });
  } catch (err) {
    throw new AiError(`Network error: ${(err as Error).message}`, 'network');
  }
  if (!res.ok) {
    const kind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate' : 'http';
    throw new AiError(`Lazybird ${res.status}`, kind, res.status);
  }
  return res;
}

export async function listVoices(o: Opts): Promise<Voice[]> {
  const res = await call(VOICES_PATH, { method: 'GET' }, o);
  const data = (await res.json()) as unknown;
  const rows = Array.isArray(data) ? data : ((data as { voices?: unknown[] }).voices ?? []);
  return rows
    .map((r) => r as Record<string, unknown>)
    .map((r) => ({
      id: String(r.id ?? ''),
      name: String(r.displayName ?? r.name ?? r.id ?? ''),
      language: r.language ? String(r.language) : undefined,
    }))
    .filter((v) => v.id);
}

/** Returns MP3 audio for plain text, or SSML when `ssml` is true. */
export async function synthesize(text: string, voiceId: string, o: Opts & { ssml?: boolean }): Promise<Blob> {
  const body = { voiceId, [o.ssml ? 'ssml' : 'text']: text };
  const res = await call(
    SPEECH_PATH,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    o,
  );
  const blob = await res.blob();
  if (blob.size === 0) throw new AiError('Lazybird returned no audio', 'empty');
  return blob;
}
