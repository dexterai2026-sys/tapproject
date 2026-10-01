import { describe, expect, it, vi } from 'vitest';
import { parseCommand, resolveCommand, stripWakeWord } from '../src/voice/command';
import { VoiceListener, type RecognitionLike } from '../src/voice/listener';

describe('parseCommand', () => {
  it.each([
    ['draw', 'draw'], ['I draw', 'draw'], ["I can't play", 'draw'], ['pick up', 'draw'],
    ['last card', 'callLast'], ["I'm down to one", 'callLast'], ['one card left!', 'callLast'],
  ])('%s -> %s', (text, type) => expect(parseCommand(text).type).toBe(type));
  it('ignores chatter and long sentences', () => {
    expect(parseCommand('nice weather today').type).toBe('unknown');
    expect(parseCommand('I think she really should draw a card from the pile right now').type).toBe('unknown');
    expect(parseCommand('').type).toBe('unknown');
  });
});

describe('stripWakeWord', () => {
  it('returns text after the wake word, null without it', () => {
    expect(stripWakeWord('Hey Deck, draw', 'hey deck')).toBe(', draw');
    expect(stripWakeWord('just talking', 'hey deck')).toBeNull();
  });
});

describe('resolveCommand', () => {
  it('uses local grammar without calling the model', async () => {
    const chatImpl = vi.fn();
    expect((await resolveCommand('draw', { apiKey: 'k', model: 'm', chatImpl })).type).toBe('draw');
    expect(chatImpl).not.toHaveBeenCalled();
  });
  it('falls back to the cheap model for odd phrasing; failures mean unknown', async () => {
    expect((await resolveCommand('gimme another', { apiKey: 'k', model: 'm', chatImpl: async () => 'draw' })).type).toBe('draw');
    expect((await resolveCommand('gimme another', { apiKey: 'k', model: 'm', chatImpl: async () => 'last' })).type).toBe('callLast');
    expect((await resolveCommand('gimme another', { apiKey: 'k', model: 'm', chatImpl: async () => { throw new Error('x'); } })).type).toBe('unknown');
    expect((await resolveCommand('gimme another')).type).toBe('unknown'); // no key
  });
});

class FakeRec implements RecognitionLike {
  continuous = false; interimResults = false; lang = '';
  onresult: RecognitionLike['onresult'] = null; onend: RecognitionLike['onend'] = null; onerror: RecognitionLike['onerror'] = null;
  start = vi.fn(); stop = vi.fn();
  say(t: string, isFinal = true) { this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: t } }] }); }
}

describe('VoiceListener', () => {
  it('wake mode forwards only speech after the wake word, continuously', () => {
    const rec = new FakeRec(); const got: string[] = [];
    const l = new VoiceListener({ mode: 'wake', wakeWord: 'hey deck', onUtterance: (t) => got.push(t), factory: () => rec });
    l.start();
    expect(rec.continuous).toBe(true);
    rec.say('talking about lunch'); rec.say('hey deck draw');
    expect(got).toEqual(['draw']);
    rec.onend!(); expect(rec.start).toHaveBeenCalledTimes(2); // auto-restarts
  });
  it('push mode forwards everything, ignores interim, does not restart', () => {
    const rec = new FakeRec(); const got: string[] = [];
    const l = new VoiceListener({ mode: 'push', wakeWord: 'hey deck', onUtterance: (t) => got.push(t), factory: () => rec });
    l.start();
    rec.say('draw', false); rec.say('last card');
    expect(got).toEqual(['last card']);
    rec.onend!(); expect(rec.start).toHaveBeenCalledTimes(1);
  });
  it('muted (app speaking) drops results; permission errors are reported', () => {
    const rec = new FakeRec(); const got: string[] = []; const errs: string[] = [];
    const l = new VoiceListener({ mode: 'push', wakeWord: '', onUtterance: (t) => got.push(t), onError: (m) => errs.push(m), factory: () => rec });
    l.start(); l.muted = true; rec.say('draw'); expect(got).toEqual([]);
    rec.onerror!({ error: 'not-allowed' }); expect(errs[0]).toContain('not-allowed');
  });
});
