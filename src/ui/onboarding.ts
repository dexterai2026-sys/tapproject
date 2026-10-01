export type OnboardStep = 'tap' | 'voice' | 'done';

/**
 * First-run guide inside the matching game (the tutorial game): a guided first
 * tap with clear confirmation, then a nudge to try the voice layer.
 */
export class Onboarding {
  step: OnboardStep;
  private notified = false;
  constructor(private voiceAvailable: boolean, active = true, private onDone: () => void = () => {}) {
    this.step = active ? 'tap' : 'done';
  }

  /** A card tap was applied. Only a legal tap counts as the guided first tap. */
  onTap(ok: boolean): void {
    if (this.step !== 'tap' || !ok) return;
    this.notify(); // the guided tap is the tutorial: never replay it, even if the voice hint is ignored
    this.advance(this.voiceAvailable ? 'voice' : 'done', false);
  }

  onVoiceCommand(): void {
    if (this.step === 'voice') this.advance('done');
  }

  skip(): void {
    this.advance('done');
  }

  get active(): boolean {
    return this.step !== 'done';
  }

  message(wakeWord: string, mic: 'push' | 'wake' | 'off'): string {
    if (this.step === 'tap') return 'Welcome! Start by tapping one of the cards you can play. Listen for the chime and feel the buzz.';
    if (this.step === 'voice') {
      return mic === 'wake'
        ? `That registered! Now try your voice: say "${wakeWord}, draw" when you can't play.`
        : 'That registered! Now try your voice: hold the mic button and say "draw" when you can\'t play.';
    }
    return '';
  }

  private advance(next: OnboardStep, notify = true): void {
    this.step = next;
    if (notify && next === 'done') this.notify();
  }

  private notify(): void {
    if (this.notified) return;
    this.notified = true;
    this.onDone();
  }
}
