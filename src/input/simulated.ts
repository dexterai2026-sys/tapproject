import { TapEmitter, type CardInput } from './cardInput';

/** Stand-in for NFC: the UI calls tap() from clicks and keyboard input. */
export class SimulatedInput extends TapEmitter implements CardInput {
  start(): void {}
  stop(): void {}
  tap(chipId: string): void {
    this.emit(chipId);
  }
}
