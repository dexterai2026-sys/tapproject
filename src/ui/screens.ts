import { h, cardLabel, mount, SUIT_ICON } from './dom';
import { matchingGame } from '../games/matching';
import { applyAction, startGame } from '../engine/engine';
import { STANDARD_DECK, mulberry32, registerChip, resolveChip, simulatedChipId, simulatedChipMap, type ChipMap } from '../engine/deck';
import { currentPlayer } from '../engine/turns';
import type { Action, Cartridge, GameState, Player } from '../engine/types';
import type { CardInput } from '../input/cardInput';
import { SimulatedInput } from '../input/simulated';
import { WebNfcInput } from '../input/webnfc';
import { loadChipMap, saveChipMap } from '../storage';
import { loadSettings } from '../settings';
import { Commentator } from '../ai/commentator';
import { createLinePicker } from '../ai/lines';
import { createSpeaker } from '../ai/speech';
import { resolveCommand, type QueryType } from '../voice/command';
import { answerQuery, HELP_TEXT } from '../voice/answers';
import { VoiceListener } from '../voice/listener';
import { settingsScreen } from './settingsScreen';
import { createFeedback } from './feedback';
import { createTimingPanel, type TimingPanel } from './timing';
import { tracer, type TraceRef } from '../perf';
import { Onboarding } from './onboarding';
import { applyAccent } from './display';
import { setActive, setNavVisible, type Tab } from './nav';
import {
  cleanNames, clearGame, isOnboarded, loadGame, loadNames, loadTally, recordWin, resetTally, saveGame, saveNames, saveTally,
  setOnboarded,
} from '../save';

const GAMES: Cartridge[] = [matchingGame];
const rng = mulberry32(Date.now());

export function showTab(tab: Tab): void {
  if (tab === 'saved') return savedScreen();
  if (tab === 'tags') return tagsScreen();
  if (tab === 'settings') return settingsScreen(homeScreen);
  homeScreen();
}

function chrome(tab: Tab | null): void {
  setActive(tab);
  setNavVisible(true);
  applyAccent(null);
}

function tallyList(): HTMLElement | false {
  const t = loadTally();
  if (!t.games) return false;
  const rows = Object.entries(t.wins).sort((a, b) => b[1] - a[1]);
  return h('section', { class: 'night' },
    h('h2', {}, 'Game night'),
    h('ul', {}, rows.map(([name, wins]) => h('li', {}, `${name}: ${wins} win${wins === 1 ? '' : 's'}`))),
    h('small', {}, `${t.games} game${t.games === 1 ? '' : 's'} played`),
    h('button', { class: 'link', onclick: () => { resetTally(); homeScreen(); } }, 'New game night'),
  );
}

export function homeScreen(): void {
  chrome('games');
  const saved = loadGame();
  mount(
    h('h1', {}, 'Choose a game'),
    !!saved && h('button', { class: 'tile resume', onclick: () => resumeSaved() },
      h('strong', {}, 'Resume game'), h('span', {}, describeSave(saved.cartridgeId, saved.players.length))),
    ...GAMES.map((g) =>
      h('button', { class: 'tile', style: `--tile-accent:${g.accent}`, onclick: () => setupScreen(g) }, h('strong', {}, g.name), h('span', {}, g.description)),
    ),
    tallyList(),
  );
}

function describeSave(cartridgeId: string, players: number): string {
  const g = GAMES.find((x) => x.id === cartridgeId);
  return `${g?.name ?? cartridgeId}, ${players} players`;
}

function resumeSaved(): void {
  const saved = loadGame();
  const game = saved && GAMES.find((g) => g.id === saved.cartridgeId);
  if (!saved || !game) return savedScreen();
  gameScreen(game, saved.players, saved.realNfc, saved.state);
}

function savedScreen(): void {
  chrome('saved');
  const saved = loadGame();
  mount(
    h('h1', {}, 'Saved game'),
    saved
      ? h('section', { class: 'status' },
          h('strong', {}, describeSave(saved.cartridgeId, saved.players.length)),
          h('small', {}, `Paused ${new Date(saved.savedAt).toLocaleString()}. Leave the physical cards where they are.`),
          h('button', { class: 'primary', onclick: resumeSaved }, 'Resume'),
          h('button', { onclick: () => { clearGame(); savedScreen(); } }, 'Discard'),
        )
      : h('p', {}, 'No paused game. Pausing a game saves it here.'),
  );
}

function setupScreen(game: Cartridge): void {
  chrome('games');
  applyAccent(game.accent);
  const p = game.players;
  const [min, max] = p.kind === 'fixed' ? [p.count, p.count] : [p.min, p.max];
  let n = Math.min(4, max);
  let useNfc = false;
  const names = loadNames();
  const nfcOk = WebNfcInput.isSupported();

  function render(): void {
    const count = h('select', { id: 'count', onchange: (e: Event) => { n = Number((e.target as HTMLSelectElement).value); render(); } },
      ...Array.from({ length: max - min + 1 }, (_, i) => h('option', { value: min + i }, String(min + i)))) as HTMLSelectElement;
    count.value = String(n);
    mount(
      h('h1', {}, game.name),
      h('label', {}, 'Players ', count),
      h('div', { class: 'names' }, Array.from({ length: n }, (_, i) =>
        h('input', { id: `name-${i}`, placeholder: `Player ${i + 1}`, maxlength: 16, value: names[i] ?? '', 'aria-label': `Player ${i + 1} name`,
          oninput: (e: Event) => { names[i] = (e.target as HTMLInputElement).value; } }))),
      h('label', {}, h('input', { type: 'checkbox', id: 'nfc', checked: useNfc, disabled: !nfcOk, onchange: (e: Event) => { useNfc = (e.target as HTMLInputElement).checked; } }),
        ' Use real NFC taps ', h('small', {}, nfcOk ? '(uses registered tags)' : '(needs Chrome on Android; using simulated taps)')),
      h('button', { class: 'primary', onclick: () => {
        const clean = cleanNames(Array.from({ length: n }, (_, i) => names[i] ?? ''));
        saveNames([...clean.map((c, i) => (names[i]?.trim() ? c : '')), ...names.slice(n)]);
        gameScreen(game, clean.map((name, i) => ({ id: `p${i}`, name })), useNfc);
      } }, 'Start'),
      h('button', { class: 'link', onclick: homeScreen }, 'Back'),
    );
  }
  render();
}

function gameScreen(game: Cartridge, players: Player[], realNfc: boolean, resume?: GameState): void {
  setActive(null);
  setNavVisible(false);
  applyAccent(game.accent);
  let state: GameState = resume ?? startGame(game, players, rng);
  const sim = new SimulatedInput();
  const chipMap: ChipMap = realNfc ? loadChipMap() : simulatedChipMap();
  const nfcInput: CardInput | null = realNfc ? new WebNfcInput() : null;
  const settings = loadSettings();
  let flash = resume ? 'Game resumed.' : '';
  let flashOk = true;
  const fx = createFeedback({ sound: settings.sound, style: game.feedbackStyle });
  const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? id;
  const micAvailable = settings.mic !== 'off' && VoiceListener.isSupported();
  const onboarding = new Onboarding(micAvailable, !resume && game.id === 'matching' && !isOnboarded(), () => setOnboarded(true));
  const persist = () => saveGame({ cartridgeId: game.id, players, realNfc, state });
  let caption = '';
  let notice = '';
  let alive = true;
  let listener: VoiceListener | null = null;

  let pttHeld = false;
  let lastSpoken = '';
  let listening = false;
  let voiceDown = false;
  let micBtn: HTMLButtonElement | null = null;
  let timingPanel: TimingPanel | null = null;
  // Voice latency tracing: a trace opens at press / speech start, and is consumed by the next utterance.
  let openTrace: number | null = null;
  const traceFor = (label: string): number => {
    if (openTrace === null) openTrace = tracer.start(label);
    return openTrace;
  };
  const unsubTiming = tracer.subscribe(() => timingPanel?.update());
  const timingContext = () => ({
    userAgent: navigator.userAgent, mic: settings.mic, commentary: settings.commentary,
    voice: (settings.lazybirdKey && settings.voiceId ? 'lazybird' : 'browser') as 'lazybird' | 'browser', speak: settings.speak,
  });
  const speaker = createSpeaker(settings, (busy) => {
    if (listener) listener.muted = busy && !pttHeld; // don't hear our own voice, unless the user is holding to talk
  });
  const say = (text: string, opts?: { ssml?: boolean; plain?: string; trace?: TraceRef }) => {
    lastSpoken = opts?.plain ?? text;
    speaker.speak(text, opts);
  };
  const commentator = new Commentator({
    settings: () => settings,
    speak: (text, opts) => say(text, opts),
    pick: createLinePicker(),
    caption: (t) => {
      caption = t;
      render();
    },
    notice: (m) => {
      notice = m;
      render();
    },
  });

  // Every input (tap, key, button, voice) funnels through here.
  const act = (a: Action, via: { tap?: boolean; voice?: boolean; trace?: number } = {}) => {
    const traceId = via.trace ?? tracer.start(via.tap ? 'tap' : 'action');
    if (!via.trace) tracer.mark(traceId, 'input');
    const tr = tracer.ref(traceId);
    const prev = state;
    const r = applyAction(game, state, a, rng);
    state = r.state;
    flash = r.message;
    flashOk = r.ok;
    fx(r.ok ? 'success' : 'error');
    if (r.ok) {
      if (state.public.status === 'finished') {
        setTimeout(() => fx('win'), 200);
        saveTally(recordWin(loadTally(), nameOf(state.public.winner as string)));
        clearGame();
      } else {
        if (currentPlayer(state.public.turn) !== currentPlayer(prev.public.turn)) setTimeout(() => fx('turn'), 200);
        persist();
      }
    }
    if (via.tap) onboarding.onTap(r.ok);
    if (via.voice && r.ok) onboarding.onVoiceCommand();
    tr.mark('acted');
    tr.meta('ok', r.ok);
    commentator.onResult(prev, a, r, tr); // side-channel: can never affect the game
    if (via.voice) say(r.message, { trace: tr }); // confirm aloud anything a voice command changed
    render();
    tr.markOnce('screenUpdated');
  };
  const onTap = (chipId: string) => {
    const card = resolveChip(chipMap, chipId);
    if (!card) {
      flash = `Unknown tag ${chipId} (register it first)`;
      flashOk = false;
      fx('error');
      return render();
    }
    act(game.tapToAction(state, card), { tap: true });
  };
  sim.subscribe(onTap);
  nfcInput?.subscribe(onTap);
  nfcInput?.start()?.catch((e: Error) => {
    flash = e.message;
    render();
  });

  const answer = (type: QueryType, traceId: number) => {
    const tr = tracer.ref(traceId);
    tr.mark('acted');
    tr.meta('command', type);
    const text = answerQuery(type, { state, tally: loadTally(), lastSpoken });
    caption = text;
    flash = text;
    flashOk = true;
    onboarding.onVoiceCommand();
    tr.mark('textReady');
    if (type !== 'repeat') say(text, { trace: tr });
    else speaker.speak(text, { trace: tr }); // a repeat shouldn't overwrite what "repeat" repeats
    render();
    tr.markOnce('screenUpdated');
  };
  const onUtterance = async (text: string) => {
    const traceId = traceFor('voice');
    openTrace = null; // the next utterance gets its own trace
    const tr = tracer.ref(traceId);
    tr.mark('final');
    tr.meta('mode', settings.mic);
    const cmd = await resolveCommand(text, {
      apiKey: settings.openrouterKey,
      model: settings.fastModel,
      onFallbackTiming: (ms) => tr.meta('llmParseMs', ms),
    });
    tr.mark('parsed');
    tr.meta('command', cmd.type);
    if (!alive) return;
    const cur = currentPlayer(state.public.turn);
    switch (cmd.type) {
      case 'draw': return act({ type: 'draw', player: cur }, { voice: true, trace: traceId });
      case 'callLast': return act({ type: 'callLast', player: state.public.lastCardPending ?? cur }, { voice: true, trace: traceId });
      case 'pause': return leave(); // every move is already saved
      case 'again':
        if (state.public.status === 'finished') return again();
        flash = "The game isn't finished yet.";
        flashOk = false;
        render();
        return tr.markOnce('screenUpdated');
      case 'unknown':
        flash = `Didn't catch that: "${text}". Say "help" for commands.`;
        flashOk = false;
        render();
        return tr.markOnce('screenUpdated');
      default:
        return answer(cmd.type, traceId);
    }
  };
  if (settings.mic !== 'off' && VoiceListener.isSupported()) {
    listener = new VoiceListener({
      mode: settings.mic,
      wakeWord: settings.wakeWord,
      onUtterance: (t) => void onUtterance(t),
      onError: (m) => {
        notice = m;
        render();
      },
      onTiming: (event) => {
        if (event === 'speechEnd') tracer.mark(traceFor('voice'), 'speechEnd');
        else tracer.mark(traceFor('voice'), event);
      },
      onListening: (on) => {
        listening = on;
        if (micBtn) micBtn.textContent = on ? 'Listening…' : 'Hold to talk'; // update in place: re-rendering mid-press would drop the button
      },
      onGiveUp: () => {
        voiceDown = true;
        render();
      },
    });
    if (settings.mic === 'wake') listener.start();
  }

  const keys = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    const cur = currentPlayer(state.public.turn);
    if (e.key === 'd' || e.key === 'D') act({ type: 'draw', player: cur });
    if (e.key === 'l' || e.key === 'L') act({ type: 'callLast', player: state.public.lastCardPending ?? cur });
  };
  document.addEventListener('keydown', keys);
  const cleanup = () => {
    alive = false;
    document.removeEventListener('keydown', keys);
    nfcInput?.stop();
    listener?.stop();
    speaker.stop();
    unsubTiming();
  };
  const leave = () => {
    cleanup();
    homeScreen();
  };
  const again = () => {
    cleanup();
    gameScreen(game, players, realNfc);
  };
  if (!resume) persist(); // a game paused before the first move still resumes

  function render(): void {
    if (!alive) return;
    const pub = state.public;
    const cur = currentPlayer(pub.turn);
    const top = pub.discard[pub.discard.length - 1]!;
    const hand = state.private[cur]!.hand;
    mount(
      onboarding.active && h('div', { class: 'coach', role: 'status' },
        h('p', {}, onboarding.message(settings.wakeWord, settings.mic)),
        h('button', { class: 'link', onclick: () => { onboarding.skip(); render(); } }, 'Skip tutorial')),
      h('div', { class: 'status' },
        h('div', { class: 'top' }, h('small', {}, 'Top card'), h('b', { 'aria-label': `${top.suit} ${top.number}` }, cardLabel(top))),
        pub.status === 'finished'
          ? h('h2', {}, `${nameOf(pub.winner!)} wins!`)
          : h('h2', {}, `${nameOf(cur)}'s turn`, pub.pendingDraw ? ` — play a +2 or draw ${pub.pendingDraw}` : ''),
        pub.lastCardPending && h('p', { class: 'warn' }, `${nameOf(pub.lastCardPending)} is on one card — call it (L)!`),
        h('p', { class: flashOk ? 'ok' : 'err', role: 'status' }, flash || ' '),
        h('ul', { class: 'scores' }, players.map((p) => h('li', {}, `${p.name}: ${pub.handCounts[p.id]} cards · ${pub.scores[p.id]} pts`))),
        h('small', {}, `Draw pile: ${pub.drawPileCount}`),
        pub.status === 'finished' && tallyList(),
        caption && h('p', { class: 'caption', 'aria-live': 'polite' }, `🎙 ${caption}`),
        notice && h('small', { class: 'warn' }, notice),
      ),
      settings.mic === 'push' && !!listener &&
        (micBtn = h('button', {
          class: 'mic',
          onpointerdown: () => {
            pttHeld = true;
            tracer.mark(traceFor('voice'), 'pressed');
            speaker.stop(); // talking over the app interrupts it
            if (listener) listener.muted = false;
            listener?.start();
          },
          onpointerup: () => {
            pttHeld = false;
            listener?.stop();
          },
          onpointerleave: () => {
            pttHeld = false;
            listener?.stop();
          },
        }, listening ? 'Listening…' : 'Hold to talk')),
      settings.mic === 'wake' && !!listener && !voiceDown && h('small', {}, `Listening for "${settings.wakeWord}". Try "${settings.wakeWord}, whose turn" or "${settings.wakeWord}, help".`),
      voiceDown && h('button', { onclick: () => { voiceDown = false; notice = ''; listener?.start(); render(); } }, 'Voice stopped. Tap to retry'),
      !!listener && h('small', {}, HELP_TEXT),
      settings.showTiming && (timingPanel = createTimingPanel(tracer, timingContext)).el,
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
      h('button', { class: 'primary', onclick: pub.status === 'finished' ? again : leave }, pub.status === 'finished' ? 'Play again' : 'Pause & exit'),
      pub.status === 'finished' && h('button', { class: 'link', onclick: leave }, 'Home'),
    );
  }
  render();
}

function tagsScreen(): void {
  chrome('tags');
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
