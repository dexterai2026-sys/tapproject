import { describe, expect, it, vi } from 'vitest';
import { AiError, OPENROUTER_URL, chat } from '../src/ai/openrouter';
import { LAZYBIRD_BASE, listVoices, synthesize } from '../src/ai/lazybird';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('openrouter chat', () => {
  const base = { apiKey: 'sk-test', model: 'm/x', messages: [{ role: 'user' as const, content: 'hi' }] };
  it('posts to openrouter with bearer auth and returns trimmed text', async () => {
    const f = vi.fn(async () => json({ choices: [{ message: { content: '  Hello there  ' } }] }));
    expect(await chat({ ...base, fetchImpl: f as unknown as typeof fetch })).toBe('Hello there');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPENROUTER_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'm/x', messages: base.messages });
  });
  it('maps failures to typed errors', async () => {
    const mk = (status: number) => chat({ ...base, fetchImpl: (async () => json({}, status)) as unknown as typeof fetch });
    await expect(mk(401)).rejects.toMatchObject({ kind: 'auth' });
    await expect(mk(429)).rejects.toMatchObject({ kind: 'rate' });
    await expect(mk(500)).rejects.toMatchObject({ kind: 'http', status: 500 });
    await expect(chat({ ...base, fetchImpl: (async () => json({ choices: [] })) as unknown as typeof fetch })).rejects.toMatchObject({ kind: 'empty' });
    await expect(chat({ ...base, fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch })).rejects.toMatchObject({ kind: 'network' });
  });
  it('refuses to call without a key, and times out', async () => {
    const f = vi.fn();
    await expect(chat({ ...base, apiKey: '', fetchImpl: f as unknown as typeof fetch })).rejects.toBeInstanceOf(AiError);
    expect(f).not.toHaveBeenCalled();
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
    await expect(chat({ ...base, timeoutMs: 20, fetchImpl: hang })).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('lazybird', () => {
  it('lists voices (documented array shape) with X-API-Key', async () => {
    const f = vi.fn(async () => json([{ id: 'msa.en-US.Jenny', displayName: 'Jenny', language: 'English (United States)', gender: 'Female' }, { displayName: 'no id' }]));
    const v = await listVoices({ apiKey: 'lb', fetchImpl: f as unknown as typeof fetch });
    expect(v).toEqual([{ id: 'msa.en-US.Jenny', name: 'Jenny', language: 'English (United States)' }]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith(LAZYBIRD_BASE)).toBe(true);
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('lb');
  });
  it('synthesize sends text or ssml and returns audio', async () => {
    const f = vi.fn(async () => new Response(new Blob(['mp3'])));
    const fx = f as unknown as typeof fetch;
    const blob = await synthesize('hi', 'v1', { apiKey: 'lb', fetchImpl: fx });
    expect(blob.size).toBe(3);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(`${LAZYBIRD_BASE}/generate-speech`);
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ voiceId: 'v1', text: 'hi' });
    await synthesize('<speak>x</speak>', 'v1', { apiKey: 'lb', fetchImpl: fx, ssml: true });
    expect(JSON.parse((f.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).ssml).toBe('<speak>x</speak>');
  });
  it('typed errors for auth, empty audio and missing key', async () => {
    await expect(synthesize('x', 'v', { apiKey: 'k', fetchImpl: (async () => json({}, 401)) as unknown as typeof fetch })).rejects.toMatchObject({ kind: 'auth' });
    await expect(synthesize('x', 'v', { apiKey: 'k', fetchImpl: (async () => new Response(new Blob([]))) as unknown as typeof fetch })).rejects.toMatchObject({ kind: 'empty' });
    await expect(listVoices({ apiKey: '' })).rejects.toMatchObject({ kind: 'auth' });
  });
});
