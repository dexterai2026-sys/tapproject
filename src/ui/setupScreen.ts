import { h, mount, SUIT_ICON } from './dom';
import { cleanNames, loadDealSetup, loadNames, saveDealSetup, saveNames, type DealChoice } from '../save';
import { STANDARD_DECK } from '../engine/deck';
import { ALL_CARD_IDS, deckForCount, deckFromExcluded, describeDeck, excludedFromDeck } from '../engine/deckConfig';
import type { Cartridge, Player, TableConfig } from '../engine/types';
import { WebNfcInput } from '../input/webnfc';
import { loadChipMap } from '../storage';
import { resolveChip } from '../engine/deck';

export interface GameStart {
  players: Player[];
  realNfc: boolean;
  table: TableConfig;
}

const DEAL_OPTIONS: { value: DealChoice; label: string; help: string }[] = [
  { value: 'counts', label: 'Real cards, count only', help: 'Fastest. Deal the cards yourselves; the app keeps count from the cards you tap and the draws you declare.' },
  { value: 'scanned', label: 'Real cards, scan hands', help: 'Stricter. Everyone also taps their cards when dealt and when they draw, so the app can check every play.' },
  { value: 'app', label: 'The app deals', help: 'Play on the screen, or for testing. The app knows every hand.' },
];

const SHAPES = ['circle', 'triangle', 'square', 'star'] as const;

/** Players, how to deal, and which cards are in play (any number, or pick the exact cards). */
export function setupScreen(game: Cartridge, onStart: (cfg: GameStart) => void, onBack: () => void): void {
  const p = game.players;
  const [min, max] = p.kind === 'fixed' ? [p.count, p.count] : [p.min, p.max];
  const names = loadNames();
  const saved = loadDealSetup();
  let n = Math.max(min, Math.min(saved.players, max));
  let deal: DealChoice = saved.deal;
  let deck = deckFromExcluded(saved.excluded);
  let playOn = saved.playOn === true;
  const nfcOk = WebNfcInput.isSupported();
  const tagged = new Set(Object.values(loadChipMap()));
  // Never chosen before: default on only when this phone can read tags and some are registered.
  let nfcChoice: boolean | undefined = saved.nfc;
  const wantNfc = () => nfcChoice ?? (nfcOk && tagged.size > 0);
  const persist = () => saveDealSetup({ deal, excluded: excludedFromDeck(deck), players: n, ...(playOn ? { playOn } : {}), ...(nfcChoice === undefined ? {} : { nfc: nfcChoice }) });

  // The deck controls update in place. Rebuilding the page when the number box loses focus would swallow
  // the tap that caused the blur (e.g. on Start), so only structural changes (players, dealing) re-render.
  let countInput: HTMLInputElement;
  let summaryEl: HTMLElement;
  let planEl: HTMLElement;
  let startBtn: HTMLButtonElement;
  let hintEl: HTMLElement | undefined;

  // "Tap the cards I'm using": tap each real card once and the deck becomes exactly those cards.
  let capture: WebNfcInput | null = null;
  let capturing = false;
  let tapped: string[] = [];
  let captureMsg = '';
  let captureEl: HTMLElement | undefined;
  const chips = loadChipMap();
  function paintCapture(): void {
    if (!captureEl) return;
    captureEl.hidden = !capturing;
    captureEl.querySelector('#tap-status')!.textContent = captureMsg || (tapped.length ? `${tapped.length} cards tapped: ${tapped.join(', ')}` : 'Tap each card you are playing with, once.');
    (captureEl.querySelector('#tap-use') as HTMLButtonElement).disabled = tapped.length === 0;
  }
  function stopCapture(): void {
    capture?.stop();
    capture = null;
    capturing = false;
    paintCapture();
  }
  function startCapture(): void {
    tapped = [];
    captureMsg = '';
    capturing = true;
    capture = new WebNfcInput();
    capture.subscribe((chipId) => {
      const card = resolveChip(chips, chipId);
      if (!card) captureMsg = 'That tag is not registered yet. Register it under Tags first.';
      else if (tapped.includes(card.id)) captureMsg = `${card.id} was already tapped.`;
      else { tapped = [...tapped, card.id]; captureMsg = ''; }
      paintCapture();
    });
    capture.start()?.catch((e: Error) => { captureMsg = e.message; paintCapture(); });
    paintCapture();
  }
  let cardBtns: HTMLButtonElement[] = [];
  function updateDeckViews(): void {
    const plan = game.planDeal(n, deck.length);
    countInput.value = String(deck.length);
    summaryEl.textContent = describeDeck(deck);
    planEl.className = 'error' in plan ? 'err' : 'ok';
    planEl.textContent = 'error' in plan ? plan.error : `${n} players: deal ${plan.handSize} cards each, leaving ${plan.pile} in the draw pile.`;
    startBtn.disabled = 'error' in plan;
    if (hintEl) {
      const have = deck.filter((id) => tagged.has(id)).length;
      hintEl.className = have < deck.length || [...tagged].some((id) => !deck.includes(id)) ? 'warn' : 'ok';
      const outside = [...tagged].filter((id) => !deck.includes(id)).length;
      hintEl.textContent = `${have} of ${deck.length} cards in play have tags registered` + (outside ? `. ${outside} registered ${outside === 1 ? 'card is' : 'cards are'} not in play.` : '');
    }
    for (const b of cardBtns) b.setAttribute('aria-pressed', String(deck.includes(b.dataset.card as string)));
  }

  function render(): void {
    const plan = game.planDeal(n, deck.length);
    const count = h('select', { id: 'count', onchange: (e: Event) => { n = Number((e.target as HTMLSelectElement).value); persist(); render(); } },
      ...Array.from({ length: max - min + 1 }, (_, i) => h('option', { value: min + i }, String(min + i)))) as HTMLSelectElement;
    count.value = String(n);

    mount(
      h('h1', {}, game.name),
      h('label', {}, 'Players ', count),
      h('div', { class: 'names' }, Array.from({ length: n }, (_, i) =>
        h('input', { id: `name-${i}`, placeholder: `Player ${i + 1}`, maxlength: 16, value: names[i] ?? '', 'aria-label': `Player ${i + 1} name`,
          oninput: (e: Event) => { names[i] = (e.target as HTMLInputElement).value; } }))),

      n >= 3 && h('label', { class: 'choice' },
        h('input', { type: 'checkbox', id: 'playon', checked: playOn, onchange: (e: Event) => { playOn = (e.target as HTMLInputElement).checked; persist(); } }),
        h('span', {}, h('b', {}, 'Play on until one player is left'), h('small', {}, 'Players who go out sit down and the rest keep playing. The last one holding cards loses, and the first one out wins the points from that hand. Off: the first one out ends the round.'))),

      h('fieldset', {}, h('legend', {}, 'How are you dealing?'),
        DEAL_OPTIONS.map((o) =>
          h('label', { class: 'choice' },
            h('input', { type: 'radio', name: 'deal', id: `deal-${o.value}`, checked: deal === o.value, onchange: () => { deal = o.value; persist(); render(); } }),
            h('span', {}, h('b', {}, o.label), h('small', {}, o.help)),
          ))),

      h('fieldset', {}, h('legend', {}, 'Cards in play'),
        h('label', {}, 'Number of cards ',
          (countInput = h('input', { type: 'number', id: 'cardcount', min: 1, max: ALL_CARD_IDS.length, value: deck.length,
            onchange: (e: Event) => {
              const v = Math.round(Number((e.target as HTMLInputElement).value));
              if (Number.isFinite(v)) { deck = deckForCount(v); persist(); }
              updateDeckViews();
            } })),
          h('small', {}, `any number up to ${ALL_CARD_IDS.length}`)),
        (summaryEl = h('p', { class: 'deck-summary' }, describeDeck(deck))),
        (planEl = h('p', { role: 'status', class: 'error' in plan ? 'err' : 'ok' },
          'error' in plan ? plan.error : `${n} players: deal ${plan.handSize} cards each, leaving ${plan.pile} in the draw pile.`)),
        nfcOk && h('button', { id: 'tap-deck', onclick: () => (capturing ? stopCapture() : startCapture()) }, 'Tap the cards I\'m using'),
        (captureEl = h('div', { class: 'deck-picker', hidden: true },
          h('p', { id: 'tap-status', role: 'status' }, ''),
          h('button', { id: 'tap-use', class: 'primary', onclick: () => {
            if (!tapped.length) return;
            deck = ALL_CARD_IDS.filter((id) => tapped.includes(id));
            persist();
            stopCapture();
            updateDeckViews();
          } }, 'Use these cards'),
          h('button', { id: 'tap-cancel', class: 'link', onclick: stopCapture }, 'Cancel'))),
        (cardBtns = []) && h('details', { class: 'deck-picker' },
          h('summary', {}, 'Choose the exact cards (e.g. a card is missing)'),
          h('div', { class: 'deck-grid' }, SHAPES.map((shape) =>
            h('div', { class: 'deck-row' },
              h('span', { class: 'deck-shape', 'aria-label': shape }, SUIT_ICON[shape] ?? shape),
              STANDARD_DECK.filter((c) => c.suit === shape).map((c) =>
                (() => {
                  const btn = h('button', { class: 'deck-card', 'data-card': c.id, 'aria-pressed': String(deck.includes(c.id)), title: c.id,
                    onclick: () => {
                      deck = deck.includes(c.id) ? deck.filter((id) => id !== c.id) : ALL_CARD_IDS.filter((id) => deck.includes(id) || id === c.id);
                      persist();
                      updateDeckViews();
                    } }, String(c.number));
                  cardBtns.push(btn);
                  return btn;
                })()),
            ))),
          h('button', { class: 'link', onclick: () => { deck = [...ALL_CARD_IDS]; persist(); updateDeckViews(); } }, 'Reset to all 52')),
      ),

      h('label', {}, h('input', { type: 'checkbox', id: 'nfc', checked: nfcOk && wantNfc(), disabled: !nfcOk, onchange: (e: Event) => { nfcChoice = (e.target as HTMLInputElement).checked; persist(); } }),
        ' Use real NFC taps ', h('small', {}, nfcOk ? '(uses registered tags)' : '(needs Chrome on Android; using simulated taps)')),
      nfcOk && (hintEl = h('small', { id: 'nfc-hint' })),
      (startBtn = h('button', { class: 'primary', id: 'start', disabled: 'error' in plan, onclick: () => {
        const plan = game.planDeal(n, deck.length);
        if ('error' in plan) return;
        const clean = cleanNames(Array.from({ length: n }, (_, i) => names[i] ?? ''));
        saveNames([...clean.map((c, i) => (names[i]?.trim() ? c : '')), ...names.slice(n)]);
        persist();
        stopCapture();
        onStart({
          players: clean.map((name, i) => ({ id: `p${i}`, name })),
          realNfc: nfcOk && wantNfc(),
          table: { mode: deal === 'app' ? 'virtual' : 'physical', knowledge: deal === 'scanned' ? 'scanned' : 'counts', deck: [...deck], handSize: plan.handSize, ...(playOn && n >= 3 ? { playOn: true } : {}) },
        });
      } }, 'Start')),
      h('button', { class: 'link', onclick: () => { stopCapture(); onBack(); } }, 'Back'),
    );
    updateDeckViews();
    paintCapture();
  }
  render();
}
