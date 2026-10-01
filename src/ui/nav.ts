import { h } from './dom';

export type Tab = 'games' | 'saved' | 'tags' | 'settings';

const TABS: [Tab, string, string][] = [
  ['games', 'Games', '🂠'],
  ['saved', 'Saved', '💾'],
  ['tags', 'Tags', '📡'],
  ['settings', 'Settings', '⚙'],
];

let nav: HTMLElement | null = null;

/** Builds the persistent shell: a screen area plus a bottom navigation bar. */
export function initShell(go: (tab: Tab) => void): void {
  const app = document.getElementById('app') as HTMLElement;
  nav = h('nav', { id: 'nav', 'aria-label': 'Main' },
    TABS.map(([tab, label, icon]) =>
      h('button', { 'data-tab': tab, onclick: () => go(tab) }, h('span', { 'aria-hidden': 'true' }, icon), h('small', {}, label)),
    ),
  );
  app.replaceChildren(h('main', { id: 'screen' }), nav);
}

export function setActive(tab: Tab | null): void {
  nav?.querySelectorAll('button').forEach((b) => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

/** Hidden during a game so a stray tap can't walk away from it. */
export function setNavVisible(visible: boolean): void {
  if (nav) nav.hidden = !visible;
}
