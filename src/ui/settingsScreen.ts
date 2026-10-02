import { h, mount } from './dom';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '../settings';
import { listVoices } from '../ai/lazybird';
import { checkModel } from '../ai/openrouter';
import { VoiceListener } from '../voice/listener';
import { applyDisplay } from './display';
import { setActive, setNavVisible } from './nav';
import { setOnboarded } from '../save';
import { pickBrowserVoice } from '../ai/voiceRouter';
import { browserSpeak } from '../ai/speech';

const CURATED_VOICES = 6;

export function settingsScreen(onBack: () => void): void {
  setActive('settings');
  setNavVisible(true);
  const s: Settings = loadSettings();
  let status = '';
  let voices: { id: string; name: string }[] = s.voiceId ? [{ id: s.voiceId, name: s.voiceId }] : [];

  const text = (key: keyof Settings, type = 'text') =>
    h('input', { type, value: String(s[key]), autocomplete: 'off', oninput: (e: Event) => ((s as unknown as Record<string, unknown>)[key] = (e.target as HTMLInputElement).value) });
  const select = (key: keyof Settings, options: [string, string][], disabled = false) => {
    const el = h('select', { disabled, onchange: (e: Event) => ((s as unknown as Record<string, unknown>)[key] = (e.target as HTMLSelectElement).value) },
      ...options.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    el.value = String(s[key]);
    return el;
  };

  const deviceVoices = (): SpeechSynthesisVoice[] => {
    try {
      return typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en'));
    } catch {
      return [];
    }
  };
  try {
    // Voices load asynchronously on some browsers: refresh the picker when they arrive.
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.onvoiceschanged = () => render();
  } catch {
    /* unsupported */
  }

  function render(): void {
    const micOk = VoiceListener.isSupported();
    mount(
      h('h1', {}, 'Voice & AI'),
      h('p', { class: 'warn' }, 'Keys are stored only in this browser and sent only to their own service. Use this for local testing: a shipped app needs server-side keys. Give your OpenRouter key a credit limit, and delete it if you think it leaked.'),
      h('fieldset', {}, h('legend', {}, 'Display & sound'),
        h('label', {}, 'Text size', (() => {
          const el = select('textSize', [['S', 'Small'], ['M', 'Medium'], ['L', 'Large'], ['XL', 'Extra large']]);
          el.addEventListener('change', () => applyDisplay(s));
          return el;
        })()),
        h('label', {}, h('input', { type: 'checkbox', checked: s.highContrast, onchange: (e: Event) => { s.highContrast = (e.target as HTMLInputElement).checked; applyDisplay(s); } }), ' High contrast'),
        h('label', {}, h('input', { type: 'checkbox', checked: s.sound, onchange: (e: Event) => (s.sound = (e.target as HTMLInputElement).checked) }), ' Sound effects (vibration stays on where supported)'),
        h('label', {}, h('input', { type: 'checkbox', checked: s.showTiming, onchange: (e: Event) => (s.showTiming = (e.target as HTMLInputElement).checked) }), ' Show voice timing panel in games'),
        h('button', { onclick: () => { setOnboarded(false); status = 'The tutorial will show at the start of your next Match Up game.'; render(); } }, 'Replay tutorial'),
      ),
      h('fieldset', {}, h('legend', {}, 'OpenRouter (commentary)'),
        h('label', {}, 'API key', text('openrouterKey', 'password')),
        h('label', {}, 'Fast model (parsing)', text('fastModel')),
        h('label', {}, 'Premium model (live trash talk)', text('premiumModel')),
        h('button', { onclick: async () => {
          const [fast, prem] = await Promise.all([checkModel(s.openrouterKey, s.fastModel), checkModel(s.openrouterKey, s.premiumModel)]);
          const show = (label: string, r: Awaited<ReturnType<typeof checkModel>>) => `${label}: ${r.ok ? `OK (${r.name})` : r.reason}`;
          status = `${show('Fast', fast)} · ${show('Premium', prem)}`;
          render();
        } }, 'Check models'),
        h('label', {}, 'Commentary', select('commentary', [['off', 'Off'], ['canned', 'Built-in lines only (free)'], ['live', 'Live AI for big moments']])),
        h('label', {}, 'Live lines per game', text('liveCap', 'number')),
      ),
      h('fieldset', {}, h('legend', {}, 'Lazybird (voice)'),
        h('label', {}, 'API key', text('lazybirdKey', 'password')),
        h('button', { onclick: async () => {
          try {
            voices = (await listVoices({ apiKey: s.lazybirdKey })).slice(0, CURATED_VOICES);
            if (voices[0] && !voices.some((v) => v.id === s.voiceId)) s.voiceId = voices[0].id;
            status = `Loaded ${voices.length} voices.`;
          } catch (e) { status = `Couldn't load voices: ${(e as Error).message}`; }
          render();
        } }, 'Load voices'),
        h('label', {}, 'Voice', select('voiceId', voices.length ? voices.map((v): [string, string] => [v.id, v.name]) : [['', 'Browser voice (no Lazybird voice chosen)']])),
        h('label', {}, 'Voice mode', select('voiceMode', [
          ['hybrid', 'Hybrid: quick lines on this device, personality via Lazybird (fastest)'],
          ['lazybird', 'Lazybird for everything (slower, one consistent voice)'],
          ['browser', 'This device\'s voice only (works offline, no Lazybird needed)'],
        ])),
        h('label', {}, 'Device voice', (() => {
          const voices = deviceVoices();
          const el = h('select', { onchange: (e: Event) => (s.browserVoice = (e.target as HTMLSelectElement).value) },
            h('option', { value: '' }, voices.length ? 'Best English voice (automatic)' : 'Automatic (no voices listed yet)'),
            ...voices.map((v) => h('option', { value: v.voiceURI }, `${v.name} (${v.lang}${v.localService ? ', on-device' : ', online'})`))) as HTMLSelectElement;
          el.value = s.browserVoice;
          return el;
        })()),
        h('label', {}, 'Device voice speed ', h('input', { type: 'number', min: 0.7, max: 1.6, step: 0.05, value: s.browserRate, oninput: (e: Event) => (s.browserRate = Number((e.target as HTMLInputElement).value) || 1) })),
        h('button', { onclick: () => {
          const voice = pickBrowserVoice(deviceVoices(), s.browserVoice);
          status = voice ? `Speaking with ${voice.name}.` : 'No English voice found on this device.';
          void browserSpeak('Whose turn is it? Player one, you are up.', new AbortController().signal, undefined, { voiceURI: s.browserVoice, rate: s.browserRate });
          render();
        } }, 'Test device voice'),
        h('label', {}, h('input', { type: 'checkbox', checked: s.speak, onchange: (e: Event) => (s.speak = (e.target as HTMLInputElement).checked) }), ' Read lines aloud'),
      ),
      h('fieldset', {}, h('legend', {}, 'Microphone'),
        h('label', {}, 'Mode', select('mic', [['off', 'Off'], ['push', 'Push to talk'], ['wake', 'Wake word']], !micOk)),
        !micOk && h('small', {}, 'Speech recognition needs Chrome.'),
        h('label', {}, 'Wake word', text('wakeWord')),
      ),
      h('p', { role: 'status' }, status || ' '),
      h('button', { class: 'primary', onclick: () => { s.liveCap = Math.max(0, Number(s.liveCap) || 0); saveSettings(s); onBack(); } }, 'Save'),
      h('button', { onclick: () => { Object.assign(s, DEFAULT_SETTINGS); applyDisplay(s); status = 'Reset (not saved yet).'; render(); } }, 'Reset to defaults'),
      h('button', { class: 'link', onclick: () => { applyDisplay(loadSettings()); onBack(); } }, 'Cancel'),
    );
  }
  render();
}
