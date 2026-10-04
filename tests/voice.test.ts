import { describe, expect, it, vi } from 'vitest';
import { parseCommand, resolveCommand, stripWakeWord } from '../src/voice/command';
import { BASE_DELAY_MS, MAX_DELAY_MS, MAX_FAILURES, VoiceListener, backoffDelay, type RecognitionLike } from '../src/voice/listener';

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

describe('new commands', () => {
  it.each([
    ['whose turn', 'turn'], ["who's up", 'turn'], ['whose turn is it', 'turn'], ["who's next", 'turn'],
    ['score', 'score'], ["what's the score", 'score'], ["who's winning", 'score'],
    ['how many cards', 'cards'], ['card count', 'cards'], ['cards left', 'cards'],
    ['top card', 'top'], ["what's on top", 'top'],
    ['repeat', 'repeat'], ['say that again', 'repeat'],
    ['help', 'help'], ['what can I say', 'help'],
    ['pause', 'pause'], ['pause game', 'pause'],
    ['play again', 'again'], ['rematch', 'again'],
  ])('%s -> %s', (text, type) => expect(parseCommand(text).type).toBe(type));
  it('keeps last-card and draw ahead of look-alikes', () => {
    expect(parseCommand('one card left').type).toBe('callLast'); // not "cards left"
    expect(parseCommand('last card').type).toBe('callLast'); // not "top card"
    expect(parseCommand('I draw').type).toBe('draw');
  });
  it('fallback classifier understands the new labels and ignores junk', async () => {
    const via = (reply: string) => resolveCommand('what is the situation', { apiKey: 'k', model: 'm', chatImpl: async () => reply });
    expect((await via('score')).type).toBe('score');
    expect((await via('Turn.')).type).toBe('turn');
    expect((await via('none')).type).toBe('unknown');
    expect((await via('banana')).type).toBe('unknown');
  });
});

describe('stripWakeWord', () => {
  it('returns text after the wake word, null without it', () => {
    expect(stripWakeWord('Hey Deck, draw', 'hey deck')).toBe('draw');
    expect(stripWakeWord('just talking', 'hey deck')).toBeNull();
    expect(stripWakeWord('well hey deck whose turn is it', 'hey deck')).toBe('whose turn is it');
  });
  it('tolerates common mishearings of the default wake phrase', () => {
    for (const heard of ['hey dec draw', 'hay deck draw', 'hi tech draw', 'hey dek draw', 'Hey, Deck. Draw!']) {
      expect(stripWakeWord(heard, 'hey deck'), heard).toBe('draw');
    }
  });
  it('does not wake on unrelated speech; custom wake words get edit-distance-1 tolerance', () => {
    expect(stripWakeWord('hey there draw', 'hey deck')).toBeNull();
    expect(stripWakeWord('hey dog draw', 'hey deck')).toBeNull();
    expect(stripWakeWord('okay dealer draw', 'okay dealer')).toBe('draw');
    expect(stripWakeWord('okay dealr draw', 'okay dealer')).toBe('draw'); // 1 edit, 6+ letters
    expect(stripWakeWord('okay dancer draw', 'okay dealer')).toBeNull(); // 2 edits
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

describe('backoff and give-up', () => {
  it('doubles from 0.5s, caps at 30s, and resets to 0', () => {
    expect([0, 1, 2, 3, 4, 5].map(backoffDelay)).toEqual([0, 500, 1000, 2000, 4000, 8000]);
    expect(backoffDelay(12)).toBe(MAX_DELAY_MS);
    expect(BASE_DELAY_MS).toBe(500);
  });
  function harness() {
    const rec = new FakeRec(); const errs: string[] = []; const timers: { fn: () => void; ms: number }[] = [];
    let t = 0; let gaveUp = 0; const listening: boolean[] = [];
    const l = new VoiceListener({
      mode: 'wake', wakeWord: 'hey deck', onUtterance: () => {}, onError: (m) => errs.push(m),
      onGiveUp: () => gaveUp++, onListening: (on) => listening.push(on), factory: () => rec,
      schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, cancel: () => {}, now: () => t,
    });
    return { rec, l, errs, timers, tick: (ms: number) => (t += ms), gaveUp: () => gaveUp, listening };
  }
  it('network errors restart with growing delay, then give up after the limit', () => {
    const h = harness(); h.l.start();
    const delays: number[] = [];
    for (let i = 0; i < MAX_FAILURES; i++) {
      h.tick(3000);
      h.rec.onerror!({ error: 'network' });
      h.rec.onend!();
      if (h.timers.length > delays.length) { delays.push(h.timers[h.timers.length - 1]!.ms); h.timers[h.timers.length - 1]!.fn(); }
    }
    expect(delays).toEqual([500, 1000, 2000, 4000]);
    expect(h.gaveUp()).toBe(1);
    expect(h.errs.at(-1)).toContain('Tap to retry');
    expect(h.rec.start).toHaveBeenCalledTimes(MAX_FAILURES); // initial + 4 backoff restarts, none after giving up
    expect(h.listening.at(-1)).toBe(false);
  });
  it('quiet sessions (no-speech, slow end) restart immediately and never count as failures', () => {
    const h = harness(); h.l.start();
    for (let i = 0; i < 10; i++) { h.tick(8000); h.rec.onerror!({ error: 'no-speech' }); h.rec.onend!(); }
    expect(h.timers).toHaveLength(0);
    expect(h.rec.start).toHaveBeenCalledTimes(11);
    expect(h.l.consecutiveFailures).toBe(0);
    expect(h.gaveUp()).toBe(0);
  });
  it('sessions that die instantly with no result count as failures; a result resets the count', () => {
    const h = harness(); h.l.start();
    h.tick(100); h.rec.onend!(); // quick death
    expect(h.l.consecutiveFailures).toBe(1);
    h.timers[0]!.fn();
    h.rec.say('hey deck draw');
    expect(h.l.consecutiveFailures).toBe(0);
  });
  it('permission errors stop without retrying; manual start retries after giving up', () => {
    const h = harness(); h.l.start();
    h.rec.onerror!({ error: 'not-allowed' });
    h.rec.onend!();
    expect(h.timers).toHaveLength(0);
    expect(h.errs[0]).toContain('not-allowed');
    h.l.start();
    expect(h.rec.start).toHaveBeenCalledTimes(2);
    expect(h.l.consecutiveFailures).toBe(0);
  });
  it('stop() cancels a pending restart', () => {
    const h = harness(); h.l.start();
    h.tick(100); h.rec.onend!();
    const pending = h.timers[0]!;
    h.l.stop();
    pending.fn(); // late timer must be a no-op
    expect(h.rec.start).toHaveBeenCalledTimes(1);
  });
});

describe('undo command', () => {
  it.each(['undo', 'go back', 'take that back', 'take it back', 'my mistake', 'oops', 'hey undo that'])('%s -> undo', (t) => expect(parseCommand(t).type).toBe('undo'));
  it('does not steal other commands', () => {
    expect(parseCommand('draw').type).toBe('draw');
    expect(parseCommand('pause').type).toBe('pause');
    expect(parseCommand('whose turn').type).toBe('turn');
  });
  it('the fallback classifier can answer "undo"', async () => {
    expect((await resolveCommand('scratch that last move', { apiKey: 'k', model: 'm', chatImpl: async () => 'undo' })).type).toBe('undo');
  });
});
