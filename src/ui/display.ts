import type { Settings, TextSize } from '../settings';

export const TEXT_SIZE_PX: Record<TextSize, number> = { S: 16, M: 18, L: 22, XL: 26 };

/** Pure description of what the root element should look like (testable without a DOM). */
export function displayAttrs(s: Pick<Settings, 'textSize' | 'highContrast'>): { size: TextSize; contrast: 'high' | 'normal' } {
  return { size: TEXT_SIZE_PX[s.textSize] ? s.textSize : 'M', contrast: s.highContrast ? 'high' : 'normal' };
}

export function applyDisplay(s: Pick<Settings, 'textSize' | 'highContrast'>, root: HTMLElement = document.documentElement): void {
  const a = displayAttrs(s);
  root.dataset.size = a.size;
  root.dataset.contrast = a.contrast;
}

export function applyAccent(accent: string | null, root: HTMLElement = document.documentElement): void {
  if (accent) root.style.setProperty('--game-accent', accent);
  else root.style.removeProperty('--game-accent');
}
