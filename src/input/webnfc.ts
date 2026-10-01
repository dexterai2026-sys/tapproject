import { TapEmitter, type CardInput } from './cardInput';

interface NdefReaderLike {
  addEventListener(type: 'reading' | 'readingerror', listener: (event: Event) => void): void;
  scan(options?: { signal?: AbortSignal }): Promise<void>;
}

/** Chrome on Android only. Uses each tag's factory serial number as its chip ID. */
export class WebNfcInput extends TapEmitter implements CardInput {
  private abort: AbortController | null = null;

  constructor(private readonly factory: () => NdefReaderLike = defaultFactory) {
    super();
  }

  static isSupported(scope: object = globalThis): boolean {
    return 'NDEFReader' in scope;
  }

  async start(): Promise<void> {
    if (this.abort) return;
    const abort = new AbortController();
    this.abort = abort;
    try {
      const reader = this.factory();
      reader.addEventListener('reading', (event) => {
        const serial = (event as Event & { serialNumber?: string }).serialNumber;
        if (serial) this.emit(normalizeSerial(serial));
      });
      await reader.scan({ signal: abort.signal });
    } catch (err) {
      this.abort = null;
      throw err;
    }
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
  }
}

export function normalizeSerial(serial: string): string {
  return serial.trim().toUpperCase();
}

function defaultFactory(): NdefReaderLike {
  const Ctor = (globalThis as { NDEFReader?: new () => NdefReaderLike }).NDEFReader;
  if (!Ctor) throw new Error('Web NFC is not supported in this browser (needs Chrome on Android).');
  return new Ctor();
}
