type Child = Node | string | null | false | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}

export const SUIT_ICON: Record<string, string> = { circle: '●', triangle: '▲', square: '■', star: '★' };

export function cardLabel(c: { number: number; suit: string }): string {
  const special = ({ 11: 'Skip', 12: 'Rev', 13: '+2' } as Record<number, string>)[c.number];
  return `${special ?? c.number} ${SUIT_ICON[c.suit]}`;
}

export function mount(...nodes: (Node | false)[]): void {
  ((document.getElementById('screen') ?? document.getElementById('app')) as HTMLElement).replaceChildren(...nodes.filter((n): n is Node => !!n));
}
