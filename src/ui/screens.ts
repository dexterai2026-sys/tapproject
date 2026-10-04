import { h, cardLabel, mount, SUIT_ICON } from './dom';
import { matchingGame } from '../games/matching';
import { applyAction, startGame } from '../engine/engine';
import { STANDARD_DECK, cardById, mulberry32, registerChip, resolveChip, simulatedChipId, simulatedChipMap, type ChipMap } from '../engine/deck';
import { currentPlayer } from '../engine/turns';
import type { Action, Card, Cartridge, GameState, Player, PlayerId, TableConfig } from '../engine/types';
import { deckCards, handCount, restockDue, unknownOf } from '../engine/table';
import { nextScanner } from '../games/matching';
import { SimTable, syncSim, type SimSnapshot } from './simTable';
import { setupScreen as showSetup, type GameStart } from './setupScreen';
import type { CardInput } from '../input/cardInput';
import { SimulatedInput } from '../input/simulated';
import { WebNfcInput } from '../input/webnfc';
import { loadChipMap, saveChipMap } from '../storage';
import { loadSettings } from '../settings';
import { Commentator } from '../ai/commentator';
import { createLinePicker } from '../ai/lines';
import { createSpeaker, unlockAudio } from '../ai/speech';
import { resolveDetailed, type QueryType } from '../voice/command';
import { addHeard, type HeardEntry } from '../voice/heard';
import { answerQuery, HELP_TEXT } from '../voice/answers';
import { VoiceListener } from '../voice/listener';
import { settingsScreen } from './settingsScreen';
import { createFeedback } from './feedback';
import { createTimingPanel, type TimingPanel } from './timing';
import { tracer, type TraceRef } from '../perf';
import { createLatencyProbe } from '../audioLatency';
import { Onboarding } from './onboarding';
import { applyAccent } from './display';
import { setActive, setNavVisible, type Tab } from './nav';
import {
  clearGame, isOnboarded, loadGame, loadTally, recordWin, resetTally, saveGame, saveTally,
  setOnboarded,
} from '../save';

const GAMES: Cartridge[] = [matchingGame];
const RESTOCK_TEXT = 'The draw pile is empty. Shuffle the discard pile, keeping the top card, to make a new draw pile.';
// `?seed=123` makes shuffles repeatable, so browser tests are deterministic. Normal play is random.
const seedParam = (() => {
  try {
    return Number(new URLSearchParams(globalThis.location?.search ?? '').get('seed'));
  } catch {
    return NaN;
  }
})();
const rng = mulberry32(Number.isFinite(seedParam) && seedParam > 0 ? seedParam : Date.now());

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
      h('button', { class: 'tile', style: `--tile-accent:${g.accent}`, onclick: () => setupFlow(g) }, h('strong', {}, g.name), h('span', {}, g.description)),
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
  gameScreen(game, { players: saved.players, realNfc: saved.realNfc, table: saved.state.table, resume: { state: saved.state, sim: saved.sim } });
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

function setupFlow(game: Cartridge): void {
  chrome('games');
  applyAccent(game.accent);
  showSetup(game, (cfg) => gameScreen(game, cfg), homeScreen);
}

interface GameStartOptions extends Partial<GameStart> {
  players: Player[];
  realNfc: boolean;
  resume?: { state: GameState; sim?: SimSnapshot };
}

function gameScreen(game: Cartridge, start: GameStartOptions): void {
  const { players, realNfc, resume } = start;
  setActive(null);
  setNavVisible(false);
  applyAccent(game.accent);
  unlockAudio(); // we're inside a tap: keeps later asynchronous speech allowed on iOS
  let state: GameState = resume?.state ?? startGame(game, players, rng, start.table);
  const sim = new SimulatedInput();
  // Real cards without NFC: the simulator plays the people holding them. The engine never sees these hands.
  let simTable: SimTable | null =
    !realNfc && state.table.mode === 'physical'
      ? resume?.sim ? SimTable.restore(resume.sim, rng) : new SimTable(deckCards(state.table), players.map((p) => p.id), state.table.handSize, rng)
      : null;
  let justDrawn: Record<PlayerId, Card[]> = {};
  let correctionsOpen = false; // stays open while correcting several counts
  let anyCardOpen = false; // the simulator's debug grid stays open between taps
  const history: { state: GameState; sim?: SimSnapshot }[] = [];
  const chipMap: ChipMap = realNfc ? loadChipMap() : simulatedChipMap();
  const nfcInput: CardInput | null = realNfc ? new WebNfcInput() : null;
  const settings = loadSettings();
  let flash = resume ? 'Game resumed.' : '';
  let flashOk = true;
  let leftOut: string | null = null; // a tapped card this game was set up without: offer to add it back
  const fx = createFeedback({ sound: settings.sound, style: game.feedbackStyle });
  const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? id;
  const micAvailable = settings.mic !== 'off' && VoiceListener.isSupported();
  const onboarding = new Onboarding(micAvailable, !resume && game.id === 'matching' && !isOnboarded(), () => setOnboarded(true));
  const persist = () => saveGame({ cartridgeId: game.id, players, realNfc, state, sim: simTable?.snapshot() });
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
  let heard: HeardEntry[] = [];
  let lastLatencySource = 'unknown';
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
    outputLatency: lastLatencySource,
  });
  const latencyProbe = createLatencyProbe();
  latencyProbe.prime(); // we're inside the Start click, so the audio clock is allowed to run
  const speaker = createSpeaker(
    settings,
    (busy) => {
      if (!listener) return;
      listener.muted = busy && !pttHeld; // safety net: never act on our own voice
      if (busy && !pttHeld) listener.pause(); // and close the mic while we talk, or the phone cuts our audio
      else listener.resume();
    },
    (line) => {
      // Sample the device's output latency at the moment this line became audible.
      const r = latencyProbe.read();
      line?.meta('outputLatencySource', r.source);
      if (r.outputMs !== undefined) line?.meta('outputLatencyMs', r.outputMs);
      if (r.baseMs !== undefined) line?.meta('baseLatencyMs', r.baseMs);
      lastLatencySource = r.source;
    },
  );
  const say = (text: string, opts?: { ssml?: boolean; plain?: string; trace?: TraceRef; kind?: string }) => {
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
    speaker.newInteraction(); // flavor lines still synthesizing for an older interaction are stale now
    const traceId = via.trace ?? tracer.start(via.tap ? 'tap' : 'action');
    if (!via.trace) tracer.mark(traceId, 'input');
    const tr = tracer.ref(traceId);
    const prev = state;
    const before = { state, sim: simTable?.snapshot() };
    const r = applyAction(game, state, a, rng);
    state = r.state;
    flash = r.message;
    flashOk = r.ok;
    const tapped = 'cardId' in a ? a.cardId : null;
    leftOut = !r.ok && tapped && cardById(tapped) && !state.table.deck.includes(tapped) ? tapped : null;
    fx(r.ok ? 'success' : 'error');
    if (r.ok) {
      if (simTable) {
        const picked = syncSim(simTable, prev, state, a); // the pretend people pick up whatever the table says was drawn
        if (Object.keys(picked).length) justDrawn = picked;
        if (state.public.status !== 'scanning') justDrawn = {}; // kept only while someone is still tapping what they drew
      }
      history.push(before);
      if (history.length > 25) history.shift();
      if (state.public.status === 'finished') {
        history.length = 0; // a finished round is final: the tally has been recorded
        setTimeout(() => fx('win'), 200);
        saveTally(recordWin(loadTally(), nameOf(state.public.winner as string)));
        clearGame();
      } else {
        if (currentPlayer(state.public.turn) !== currentPlayer(prev.public.turn)) setTimeout(() => fx('turn'), 200);
        persist();
      }
    }
    if (via.tap && a.type === 'play') onboarding.onTap(r.ok); // the guided first tap is a real play, not dealing
    if (via.voice && r.ok) onboarding.onVoiceCommand();
    if (r.ok && restockDue(state) && !restockDue(prev)) say(RESTOCK_TEXT, { trace: tr, kind: 'answer' }); // announce once, the moment the pile runs out
    tr.mark('acted');
    tr.meta('ok', r.ok);
    if (via.voice) say(r.message, { trace: tr, kind: 'confirmation' }); // confirm aloud first: short, instant, and what the player is waiting for
    commentator.onResult(prev, a, r, tr); // side-channel: can never affect the game
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

  const undo = (): boolean => {
    const last = history.pop();
    if (!last) return false;
    state = last.state;
    if (simTable && last.sim) simTable = SimTable.restore(last.sim, rng);
    justDrawn = {};
    persist();
    flash = 'Last move undone.';
    flashOk = true;
    fx('success');
    render();
    return true;
  };

  const answer = (type: QueryType, traceId: number) => {
    speaker.newInteraction();
    const tr = tracer.ref(traceId);
    tr.mark('acted');
    tr.meta('command', type);
    const text = answerQuery(type, { state, tally: loadTally(), lastSpoken });
    caption = text;
    flash = text;
    flashOk = true;
    onboarding.onVoiceCommand();
    tr.mark('textReady');
    if (type !== 'repeat') say(text, { trace: tr, kind: 'answer' });
    else speaker.speak(text, { trace: tr, kind: 'answer' }); // a repeat shouldn't overwrite what "repeat" repeats
    render();
    tr.markOnce('screenUpdated');
  };
  const onUtterance = async (text: string) => {
    const traceId = traceFor('voice');
    openTrace = null; // the next utterance gets its own trace
    const tr = tracer.ref(traceId);
    tr.mark('final');
    tr.meta('mode', settings.mic);
    const { cmd, via: how, modelMs } = await resolveDetailed(text, {
      apiKey: settings.openrouterKey,
      model: settings.fastModel,
      onFallbackTiming: (ms) => tr.meta('llmParseMs', ms),
    });
    tr.mark('parsed');
    tr.meta('command', cmd.type);
    tr.meta('resolvedVia', how);
    heard = addHeard(heard, { text, via: how, command: cmd.type, modelMs });
    timingPanel?.update();
    if (!alive) return;
    const cur = currentPlayer(state.public.turn);
    switch (cmd.type) {
      case 'draw': return act({ type: 'draw', player: cur }, { voice: true, trace: traceId });
      case 'callLast': return act({ type: 'callLast', player: state.public.lastCardPending ?? cur }, { voice: true, trace: traceId });
      case 'pause': return leave(); // every move is already saved
      case 'undo': {
        const ok = undo();
        if (!ok) {
          flash = 'Nothing to undo.';
          flashOk = false;
          render();
        }
        say(ok ? 'Last move undone.' : 'Nothing to undo.', { trace: tr, kind: 'confirmation' });
        return tr.markOnce('screenUpdated');
      }
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
        const id = traceFor('voice');
        if (event === 'interim') {
          tracer.markOnce(id, 'firstInterim');
          tracer.setMark(id, 'lastInterim'); // the latest partial result: start point when Chrome sends no speechend
        } else tracer.mark(id, event);
      },
      onDiscard: () => {
        openTrace = null; // chatter without a wake word: don't let its marks leak into the next real command
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
    latencyProbe.close();
  };
  const leave = () => {
    cleanup();
    homeScreen();
  };
  const again = () => {
    cleanup();
    gameScreen(game, { players, realNfc, table: state.table });
  };
  if (!resume) persist(); // a game paused before the first move still resumes

  // ---- table phases (physical play) --------------------------------------
  const tap = (c: Card) => sim.tap(simulatedChipId(c.id));
  const hasCards = (list: Card[] | undefined): list is Card[] => !!list && list.length > 0;

  function tablePanel(): Node | false {
    const pub = state.public;
    const t = state.table;
    const n = players.length;
    if (pub.status === 'setup') {
      const scanner = t.knowledge === 'scanned' ? nextScanner(state) : null;
      const pileAfter = t.deck.length - n * t.handSize - 1;
      return h('section', { class: 'table-panel', id: 'panel-setup' },
        h('h3', {}, 'Set up the table'),
        h('p', {}, `Deal ${t.handSize} cards to each of the ${n} players. After the first card is flipped the draw pile will have ${pileAfter} cards.`),
        t.knowledge === 'scanned' && h('ul', { class: 'scan-progress' }, players.map((p) =>
          h('li', { class: p.id === scanner ? 'now' : '' }, `${p.name}: ${state.private[p.id]?.hand.length ?? 0} of ${t.handSize} scanned${pub.scanDone.includes(p.id) && unknownOf(state.private[p.id]) > 0 ? ' (skipped)' : ''}`))),
        !!scanner && h('p', {}, `${nameOf(scanner)}: tap the cards in your hand.`),
        !scanner && h('p', {}, 'Now flip the top card of the pile and tap it.'),
        !!scanner && h('button', { class: 'link', onclick: () => players.forEach((p) => act({ type: 'skipScan', player: p.id })) }, 'Skip scanning for everyone (just count)'),
        !!simTable && !!scanner && h('button', { id: 'sim-scan', onclick: () => [...(simTable?.hands[scanner] ?? [])].forEach(tap) }, `Scan ${nameOf(scanner)}'s hand (simulated)`),
        !!simTable && !scanner && h('button', { id: 'sim-flip', class: 'primary', onclick: () => { const c = simTable?.flip(); if (c) tap(c); } }, 'Flip the top card (simulated)'),
      );
    }
    if (pub.status === 'scanning' && pub.scanning) {
      const sp = pub.scanning;
      const mine = (justDrawn[sp.player] ?? []).filter((c) => !state.private[sp.player]?.hand.some((k) => k.id === c.id));
      return h('section', { class: 'table-panel', id: 'panel-scanning' },
        h('h3', {}, `${nameOf(sp.player)}: tap the ${sp.remaining} card${sp.remaining === 1 ? '' : 's'} you drew`),
        h('p', {}, 'Tap each card you picked up so the app knows your hand, or skip and it will just count them.'),
        h('button', { class: 'link', onclick: () => act({ type: 'skipScan', player: sp.player }) }, 'Skip'),
        !!simTable && hasCards(mine) && h('div', { class: 'hand' }, mine.map((c) => h('button', { onclick: () => tap(c) }, `Tap drawn: ${cardLabel(c)}`))),
      );
    }
    if (pub.status === 'confirming' && pub.pendingWin) {
      const w = nameOf(pub.pendingWin);
      return h('section', { class: 'table-panel', id: 'panel-confirm' },
        h('h3', {}, `${w} played their last card`),
        h('p', {}, 'The app counts cards from your taps and draws. Is that really everything?'),
        h('button', { class: 'primary', id: 'confirm-yes', onclick: () => act({ type: 'confirm', ok: true }) }, `Yes, ${w} is out`),
        h('button', { id: 'confirm-no', onclick: () => act({ type: 'confirm', ok: false }) }, `No, ${w} still has a card`),
      );
    }
    if (pub.status === 'scoring' && pub.winner) {
      const w = nameOf(pub.winner);
      const left = simTable ? simTable.leftover(pub.winner).filter((c) => !pub.scoredCards.includes(c.id)) : [];
      return h('section', { class: 'table-panel', id: 'panel-scoring' },
        h('h3', {}, `${w} is out!`),
        h('p', {}, `Tap each card still held by the others to add its points (${w}: ${pub.scores[pub.winner]} pts so far), or finish.`),
        h('button', { class: 'primary', id: 'finish-scoring', onclick: () => act({ type: 'finishScoring' }) }, 'Done'),
        !!simTable && hasCards(left) && h('button', { id: 'sim-score-all', onclick: () => left.forEach(tap) }, 'Score all leftover cards (simulated)'),
        !!simTable && hasCards(left) && h('div', { class: 'hand' }, left.map((c) => h('button', { onclick: () => tap(c) }, `Score ${cardLabel(c)}`))),
      );
    }
    return false;
  }

  function controls(): Node | false {
    const pub = state.public;
    if (pub.status !== 'playing' && pub.status !== 'setup') return false;
    const cur = currentPlayer(pub.turn);
    const physical = state.table.mode === 'physical';
    return h('section', { class: 'controls' },
      pub.status === 'playing' && h('button', { onclick: () => act({ type: 'draw', player: cur }) }, 'Draw (D)'),
      pub.status === 'playing' && h('button', { onclick: () => act({ type: 'callLast', player: pub.lastCardPending ?? cur }) }, 'Call last card (L)'),
      history.length > 0 && h('button', { id: 'undo', onclick: () => undo() }, 'Undo last move'),
      physical && h('details', { class: 'corrections', open: correctionsOpen, ontoggle: (e: Event) => (correctionsOpen = (e.target as HTMLDetailsElement).open) },
        h('summary', {}, 'Fix a card count'),
        h('small', {}, 'Forgot to say "draw", or miscounted? Correct it here.'),
        h('ul', {}, players.map((p) =>
          h('li', {}, `${p.name}: ${handCount(state, p.id)} `,
            h('button', { 'aria-label': `One fewer card for ${p.name}`, onclick: () => act({ type: 'adjust', player: p.id, delta: -1 }) }, '−'),
            h('button', { 'aria-label': `One more card for ${p.name}`, onclick: () => act({ type: 'adjust', player: p.id, delta: 1 }) }, '+'))))),
    );
  }

  function render(): void {
    if (!alive) return;
    const pub = state.public;
    const cur = currentPlayer(pub.turn);
    const top = pub.discard[pub.discard.length - 1];
    const physical = state.table.mode === 'physical';
    const simHand: Card[] = simTable ? (simTable.hands[cur] ?? []) : (state.private[cur]?.hand ?? []);
    const heading =
      pub.status === 'finished' ? `${nameOf(pub.winner as string)} wins!${pub.loser ? ` ${nameOf(pub.loser)} is left holding cards.` : ''}`
      : pub.status === 'setup' ? 'Setting up the table'
      : pub.status === 'scanning' ? `${nameOf(pub.scanning?.player ?? '')}: tap your drawn cards`
      : pub.status === 'confirming' ? `Is ${nameOf(pub.pendingWin ?? '')} out?`
      : pub.status === 'scoring' ? `${nameOf(pub.winner ?? '')} is out! Adding up points`
      : `${nameOf(cur)}'s turn`;
    mount(
      onboarding.active && pub.status === 'playing' && h('div', { class: 'coach', role: 'status' },
        h('p', {}, onboarding.message(settings.wakeWord, settings.mic)),
        h('button', { class: 'link', onclick: () => { onboarding.skip(); render(); } }, 'Skip tutorial')),
      h('div', { class: 'status' },
        h('div', { class: 'top' }, h('small', {}, 'Top card'), top ? h('b', { 'aria-label': `${top.suit} ${top.number}` }, cardLabel(top)) : h('b', {}, '—')),
        h('h2', {}, heading, pub.status === 'playing' && pub.pendingDraw ? ` — play a +2 or draw ${pub.pendingDraw}` : ''),
        pub.lastCardPending && h('p', { class: 'warn' }, `${nameOf(pub.lastCardPending)} is on one card — call it (L)!`),
        h('p', { class: flashOk ? 'ok' : 'err', role: 'status' }, flash || ' '),
        leftOut && h('button', { id: 'add-card', onclick: () => { const id = leftOut as string; act({ type: 'addCard', cardId: id }); } }, `Add ${leftOut} to the deck`),
        h('ul', { class: 'scores' }, players.map((p) => { const place = (pub.placings ?? []).indexOf(p.id) + 1; return h('li', {}, `${p.name}: ${place ? `out (${['1st', '2nd', '3rd'][place - 1] ?? `${place}th`})` : `${pub.handCounts[p.id]} cards`} · ${pub.scores[p.id]} pts${pub.loser === p.id ? ' · last holding cards' : ''}`); })),
        h('small', {}, `Draw pile: ${pub.drawPileCount}${physical ? ' (counted from your taps)' : ''}${pub.reshuffles ? ` · restocked ${pub.reshuffles}×` : ''}`),
        restockDue(state) && h('p', { id: 'restock', class: 'warn', role: 'status' }, RESTOCK_TEXT),
        pub.status === 'finished' && tallyList(),
        caption && h('p', { class: 'caption', 'aria-live': 'polite' }, `🎙 ${caption}`),
        notice && h('small', { class: 'warn' }, notice),
      ),
      tablePanel(),
      settings.mic === 'push' && !!listener &&
        (micBtn = h('button', {
          class: 'mic',
          onpointerdown: () => {
            pttHeld = true;
            latencyProbe.prime();
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
      settings.showTiming && (timingPanel = createTimingPanel(tracer, timingContext, () => heard)).el,
      h('ul', { class: 'log' }, [...pub.log].reverse().slice(0, 12).map((l) => h('li', {}, l))),
      pub.status === 'playing' && !realNfc &&
        h('section', { class: 'sim' },
          h('h3', {}, `Simulated taps — ${nameOf(cur)}'s hand`, physical && h('small', {}, ' (real cards: the app can’t see these)')),
          h('div', { class: 'hand' }, simHand.map((c) => h('button', { onclick: () => tap(c) }, cardLabel(c)))),
          h('details', { open: anyCardOpen, ontoggle: (e: Event) => (anyCardOpen = (e.target as HTMLDetailsElement).open) }, h('summary', {}, 'Tap any card'),
            h('div', { class: 'hand' }, STANDARD_DECK.map((c) => h('button', { onclick: () => tap(c) }, cardLabel(c)))),
          ),
        ),
      controls(),
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
