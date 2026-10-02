import { h } from './dom';
import { exportResults, headlineOf, lineInfoOf, slowest, stagesOf, summarize, type ExportContext, type Tracer } from '../perf';
import type { HeardEntry } from '../voice/heard';

let panelOpen = true; // remembered across re-renders of the game screen
let includeSpeech = false; // opt-in, never persisted: transcripts stay on screen unless ticked

const ms = (n: number | undefined): string => (n === undefined ? '–' : `${n.toLocaleString('en-US')} ms`);

export interface TimingPanel {
  el: HTMLElement;
  update(): void;
}

/** Live latency readout for the voice pipeline, plus a button that copies the raw results. */
export function createTimingPanel(tracer: Tracer, context: () => ExportContext, heard: () => HeardEntry[] = () => []): TimingPanel {
  const body = h('div', { class: 'timing-body' });
  const el = h('details', { class: 'timing', open: panelOpen, ontoggle: (e: Event) => (panelOpen = (e.target as HTMLDetailsElement).open) },
    h('summary', {}, 'Timing'),
    body,
  );

  function update(): void {
    // Voice is what we are tuning: focus on voice traces, and fall back to taps until there is one.
    const hasVoice = tracer.all().some((t) => t.label === 'voice');
    const last = tracer.lastMeasured(hasVoice ? 'voice' : undefined);
    const parts: (Node | false)[] = [];
    if (!last) {
      parts.push(h('p', { class: 'timing-empty' }, 'No measurements yet. Say a command or tap a card.'));
    } else {
      const head = headlineOf(last);
      const lines = lineInfoOf(last);
      const parentStages = stagesOf(last).filter((s) => !lines.some((l) => l.stages.some((x) => x.key === s.key)));
      const all = stagesOf(last);
      const slow = slowest(all);
      const max = Math.max(1, ...all.map((s) => s.ms));
      const bars = (stages: typeof all) =>
        h('ul', { class: 'bars' }, stages.map((s) =>
          h('li', { class: s.key === slow?.key ? 'slowest' : '' },
            h('span', { class: 'bar-label' }, s.label),
            h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: `width:${Math.max(2, (s.ms / max) * 100)}%` })),
            h('span', { class: 'bar-ms' }, ms(s.ms)),
          ),
        ));
      parts.push(
        h('p', { class: 'timing-head' },
          h('b', {}, 'Last: '),
          `end of speech → first sound ${ms(head.toFirstSoundMs)}`,
          head.toEarMs !== undefined && ` (≈ ${ms(head.toEarMs)} at the ear)`,
          ` · → screen ${ms(head.toScreenMs)}`,
          head.allLinesDoneMs !== undefined && ` · all spoken lines done ${ms(head.allLinesDoneMs)}`,
        ),
        parentStages.length > 0 && bars(parentStages),
      );
      for (const l of lines) {
        parts.push(
          h('div', { class: 'timing-line' },
            h('b', {}, `Line ${l.index + 1}: ${l.kind}`),
            h('small', {}, ` ${l.chars ?? '?'} chars${l.audioBytes ? `, ${l.audioBytes} bytes` : ''} · voice ${l.voicePath ?? 'unknown'}${l.cache && l.cache !== 'off' ? ` · cache ${l.cache}` : ''}${l.route ? ` · ${l.route}` : ''}`),
            l.stages.length > 0 && bars(l.stages),
            h('small', {}, [
              l.soundAtMs !== undefined ? `Audible ${ms(l.soundAtMs)} after speech end` : l.skipped ? `Skipped (${l.skipped})` : 'Never became audible',
              l.lastedMs !== undefined && `, lasted ${ms(l.lastedMs)}`,
              l.gapMs !== undefined && `, ${ms(l.gapMs)} after the previous line ended`,
            ].filter(Boolean).join('')),
          ),
        );
      }
      const withLatency = lines.find((l) => l.outputLatencyMs !== undefined);
      parts.push(
        h('small', { class: 'timing-output' },
          withLatency
            ? `Output device latency: ${ms(withLatency.outputLatencyMs)} (reported by the browser; Bluetooth speakers are usually much higher).`
            : 'Output device latency: not reported by this browser, so "first sound" is when the browser started playing, not when it reaches the ear.',
        ),
        !!slow && all.length > 1 && h('small', {}, `Slowest stage: ${slow.label}`),
      );
    }
    const sum = summarize(hasVoice ? tracer.all().filter((t) => t.label === 'voice') : tracer.all());
    const rows = [sum.toFirstSound, sum.toEar, sum.allLinesDone, sum.toScreen, ...sum.stages].filter((r): r is NonNullable<typeof r> => !!r);
    if (rows.length) {
      parts.push(
        h('table', { class: 'timing-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Stage'), h('th', {}, 'n'), h('th', {}, 'median'), h('th', {}, 'p90'))),
          h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.label), h('td', {}, String(r.n)), h('td', {}, ms(r.median)), h('td', {}, ms(r.p90))))),
        ),
      );
    }
    const heardList = heard();
    if (heardList.length) {
      parts.push(
        h('div', { class: 'timing-heard' },
          h('b', {}, 'What it heard'),
          h('ul', {}, [...heardList].reverse().map((e) =>
            h('li', { class: e.via === 'none' ? 'err' : '' },
              `"${e.text}" → ${e.command} `,
              h('small', {}, e.via === 'grammar' ? '(grammar)' : e.via === 'model' ? `(model, ${ms(e.modelMs)})` : '(no match)'),
            ),
          )),
        ),
      );
    }
    parts.push(
      h('label', {}, h('input', { type: 'checkbox', checked: includeSpeech, onchange: (e: Event) => (includeSpeech = (e.target as HTMLInputElement).checked) }), ' Include what I said in Copy results'),
      h('button', { onclick: () => void copy(body) }, 'Copy results'),
      h('button', { class: 'link', onclick: () => tracer.clear() }, 'Clear'),
    );
    body.replaceChildren(...parts.filter((p): p is Node => !!p));
  }

  async function copy(container: HTMLElement): Promise<void> {
    const json = JSON.stringify(exportResults(tracer.all(), context(), { heard: heard(), includeHeardText: includeSpeech }), null, 2);
    container.querySelector('.timing-copy')?.remove();
    try {
      await navigator.clipboard.writeText(json);
      container.append(h('small', { class: 'timing-copy ok' }, 'Copied. Paste it into the chat.'));
    } catch {
      // Clipboard blocked: show the text so it can be selected by hand.
      const ta = h('textarea', { class: 'timing-copy', readonly: true, rows: 6 }, json);
      container.append(ta);
      ta.select();
    }
  }

  update();
  return { el, update };
}
