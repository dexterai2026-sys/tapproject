import { describe, expect, it, vi } from 'vitest';
import { WebNfcInput, normalizeSerial } from '../src/input/webnfc';

class FakeReader extends EventTarget {
  scan = vi.fn(async (_o?: { signal?: AbortSignal }) => {});
  fire(serialNumber: string) {
    this.dispatchEvent(Object.assign(new Event('reading'), { serialNumber }));
  }
}

describe('WebNfcInput', () => {
  it('feature-detects', () => {
    expect(WebNfcInput.isSupported({})).toBe(false);
    expect(WebNfcInput.isSupported({ NDEFReader: class {} })).toBe(true);
  });
  it('emits normalized serials from reading events', async () => {
    const reader = new FakeReader();
    const input = new WebNfcInput(() => reader);
    const seen: string[] = [];
    input.subscribe((c) => seen.push(c));
    await input.start();
    reader.fire('04:a2:3b:ff');
    expect(seen).toEqual(['04:A2:3B:FF']);
    expect(reader.scan).toHaveBeenCalledOnce();
  });
  it('stop aborts the scan and unsubscribe works', async () => {
    const reader = new FakeReader();
    const input = new WebNfcInput(() => reader);
    const seen: string[] = [];
    const off = input.subscribe((c) => seen.push(c));
    await input.start();
    const signal = reader.scan.mock.calls[0]![0]!.signal!;
    input.stop();
    expect(signal.aborted).toBe(true);
    off();
    reader.fire('AA');
    expect(seen).toEqual([]);
  });
  it('surfaces scan failures and allows retry', async () => {
    const reader = new FakeReader();
    reader.scan.mockRejectedValueOnce(new Error('denied'));
    const input = new WebNfcInput(() => reader);
    await expect(input.start()).rejects.toThrow('denied');
    await expect(input.start()).resolves.toBeUndefined();
  });
  it('normalizeSerial trims and uppercases', () => {
    expect(normalizeSerial(' ab:cd ')).toBe('AB:CD');
  });
});
