import { h, cardLabel, feedback, SUIT_ICON } from './dom';
import { matchingGame } from '../games/matching';
import { applyAction, handleTap, startGame } from '../engine/engine';
import { STANDARD_DECK, mulberry32, registerChip, resolveChip, simulatedChipId, simulatedChipMap, type ChipMap } from '../engine/deck';
import { currentPlayer } from '../engine/turns';
import type { Cartridge, GameState, Player } from '../engine/types';
import type { CardInput } from '../input/cardInput';
import { SimulatedInput } from '../input/simulated';
import { WebNfcInput } from '../input/webnfc';
import { loadChipMap, saveChipMap } from '../storage';

const root = () => document.getElementById('app') as HTMLElement;
const GAMES: Cartridge[] = [matchingGame];
const rng = mulberry32(Date.now());

function mount(...nodes: (Node | false)[]): void {
  root().replaceChildren(...nodes.filter((n): n is Node => !!n));
}

export function homeScreen(): void {
  mount(
    h('h1', {}, 'Choose a game'),
    ...GAMES.map((g) =>
      h('button', { class: 'tile', onclick: () => setupScreen(g) }, h('strong', {}, g.name), h('span', {}, g.description)),
    ),
    h('button', { class: 'link', onclick: tagsScreen }, 'Register NFC tags'),
  );
}

function setupScreen(game: Cartridge): void {
  const p = game.players;
  const [min, max] = p.kind === 'fixed' ? [p.count, p.count] : [p.min, p.max];
  const count = h('select', { id: 'count' }, ...Array.from({ length: max - min + 1 }, (_, i) => h('option', { value: min + i }, String(min + i))));
  (count as HTMLSelectElement).value = String(Math.min(4, max));
  const nfcOk = WebNfcInput.isSupported();
  const nfc = h('input', { type: 'checkbox', id: 'nfc', disabled: !nfcOk });
  mount(
    h('h1', {}, game.name),
    h('label', {}, 'Players ', count),
    h('label', {}, nfc, ' Use real NFC taps ', h('small', {}, nfcOk ? '(uses registered tags)' : '(needs Chrome on Android; using simulated taps)')),
    h(
      'button',
      {
        class: 'primary',
        onclick: () => {
          const n = Number((count as HTMLSelectElement).value);
          const players: Player[] = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player ${i + 1}` }));
          gameScreen(game, players, (nfc as HTMLInputElement).checked);
        },
      },
      'Start',
    ),
    h('button', { class: 'link', onclick: homeScreen }, 'Back'),
  );
}

function gameScreen(game: Cartridge, players: Player[], realNfc: boolean): void {
  let state: GameState = startGame(game, players, rng);
  const sim = new SimulatedInput();
  const chipMap: ChipMap = realNfc ? loadChipMap() : simulatedChipMap();
  const nfcInput: CardInput | null = realNfc ? new WebNfcInput() : null;
  let flash = '';
  let flashOk = true;

  const onTap = (chipId: string) => {
    const card = resolveChip(chipMap, chipId);
    if (!card) {
      flash = `Unknown tag ${chipId} (register it first)`;
      flashOk = false;
      feedback('error');
      return render();
    }
    const r = handleTap(game, state, card.id, rng);
    state = r.state;
    flash = r.message;
    flashOk = r.ok;
    feedback(r.ok ? 'success' : 'error');
    render();
  };
  const act = (a: Parameters<typeof applyAction>[2]) => {
    const r = applyAction(game, state, a, rng);
    state = r.state;
    flash = r.message;
    flashOk = r.ok;
    feedback(r.ok ? 'success' : 'error');
    render();
  };
  sim.subscribe(onTap);
  nfcInput?.subscribe(onTap);
  nfcInput?.start()?.catch((e: Error) => {
    flash = e.message;
    render();
  });

  const keys = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    const cur = currentPlayer(state.public.turn);
    if (e.key === 'd' || e.key === 'D') act({ type: 'draw', player: cur });
    if (e.key === 'l' || e.key === 'L') act({ type: 'callLast', player: state.public.lastCardPending ?? cur });
  };
  document.addEventListener('keydown', keys);
  const leave = () => {
    document.removeEventListener('keydown', keys);
    nfcInput?.stop();
    homeScreen();
  };

  function render(): void {
    const pub = state.public;
    const cur = currentPlayer(pub.turn);
    const top = pub.discard[pub.discard.length - 1]!;
    const nameOf = (id: string) => players.find((p) => p.id === id)!.name;
    const hand = state.private[cur]!.hand;
    mount(
      h('div', { class: 'status' },
        h('div', { class: 'top' }, h('small', {}, 'Top card'), h('b', { 'aria-label': `${top.suit} ${top.number}` }, cardLabel(top))),
        pub.status === 'finished'
          ? h('h2', {}, `${nameOf(pub.winner!)} wins!`)
          : h('h2', {}, `${nameOf(cur)}'s turn`, pub.pendingDraw ? ` — play a +2 or draw ${pub.pendingDraw}` : ''),
        pub.lastCardPending && h('p', { class: 'warn' }, `${nameOf(pub.lastCardPending)} is on one card — call it (L)!`),
        h('p', { class: flashOk ? 'ok' : 'err', role: 'status' }, flash || ' '),
        h('ul', { class: 'scores' }, players.map((p) => h('li', {}, `${p.name}: ${pub.handCounts[p.id]} cards · ${pub.scores[p.id]} pts`))),
        h('small', {}, `Draw pile: ${pub.drawPileCount}`),
      ),
      h('ul', { class: 'log' }, [...pub.log].reverse().slice(0, 12).map((l) => h('li', {}, l))),
      pub.status === 'playing' &&
        h('section', { class: 'sim' },
          h('h3', {}, `Simulated taps — ${nameOf(cur)}'s hand`),
          h('div', { class: 'hand' }, hand.map((c) => h('button', { onclick: () => sim.tap(simulatedChipId(c.id)) }, cardLabel(c)))),
          h('button', { onclick: () => act({ type: 'draw', player: cur }) }, 'Draw (D)'),
          h('button', { onclick: () => act({ type: 'callLast', player: pub.lastCardPending ?? cur }) }, 'Call last card (L)'),
          h('details', {}, h('summary', {}, 'Tap any card'),
            h('div', { class: 'hand' }, STANDARD_DECK.map((c) => h('button', { onclick: () => sim.tap(simulatedChipId(c.id)) }, cardLabel(c)))),
          ),
        ),
      h('button', { class: 'primary', onclick: pub.status === 'finished' ? () => gameScreen(game, players, realNfc) : leave }, pub.status === 'finished' ? 'Play again' : 'Quit'),
      pub.status === 'finished' && h('button', { class: 'link', onclick: leave }, 'Home'),
    );
  }
  render();
}

function tagsScreen(): void {
  let map = loadChipMap();
  let status = '';
  let input: WebNfcInput | null = null;
  const supported = WebNfcInput.isSupported();
  const select = h('select', {}, ...STANDARD_DECK.map((c) => h('option', { value: c.id }, `${c.id} (${SUIT_ICON[c.suit]} ${c.number})`))) as HTMLSelectElement;
  const manual = h('input', { placeholder: 'chip ID (no NFC? type one)' }) as HTMLInputElement;

  const bind = (chipId: string) => {
    map = registerChip(map, chipId, select.value);
    saveChipMap(map);
    status = `Bound ${chipId} → ${select.value}`;
    const i = select.selectedIndex;
    if (i < select.options.length - 1) select.selectedIndex = i + 1; // advance for fast sequential registration
    render();
  };
  const leave = () => {
    input?.stop();
    homeScreen();
  };
  function render(): void {
    mount(
      h('h1', {}, 'Register NFC tags'),
      h('p', {}, `${Object.keys(map).length} / ${STANDARD_DECK.length} tags registered.`),
      h('label', {}, 'Card ', select),
      supported
        ? h('button', { class: 'primary', onclick: async () => {
            input?.stop();
            input = new WebNfcInput();
            input.subscribe(bind);
            try { await input.start(); status = 'Scanning — tap the tag to the back of the phone…'; } catch (e) { status = (e as Error).message; }
            render();
          } }, 'Scan next tag')
        : h('p', { class: 'warn' }, 'Web NFC needs Chrome on Android. Use the manual field below to try the flow.'),
      h('div', {}, manual, h('button', { onclick: () => manual.value.trim() && bind(manual.value.trim().toUpperCase()) }, 'Bind typed ID')),
      h('p', { role: 'status' }, status || ' '),
      h('button', { onclick: () => { map = {}; saveChipMap(map); status = 'Cleared.'; render(); } }, 'Clear all'),
      h('button', { class: 'link', onclick: leave }, 'Back'),
    );
  }
  render();
}
