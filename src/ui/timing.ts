import { h } from './dom';
import { STAGE_LABELS, exportResults, headlineOf, slowest, stagesOf, summarize, type ExportContext, type Tracer } from '../perf';

let panelOpen = true; // remembered across re-renders of the game screen

const ms = (n: number | undefined): string => (n === undefined ? '–' : `${n.toLocaleString('en-US')} ms`);

export interface TimingPanel {
  el: HTMLElement;
  update(): void;
}

/** Live latency readout for the voice pipeline, plus a button that copies the raw results. */
export function createTimingPanel(tracer: Tracer, context: () => ExportContext): TimingPanel {
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
      const stages = stagesOf(last);
      const slow = slowest(stages);
      const max = Math.max(1, ...stages.map((s) => s.ms));
      parts.push(
        h('p', { class: 'timing-head' },
          h('b', {}, 'Last: '),
          `end of speech → first sound ${ms(head.toFirstSoundMs)} · → screen ${ms(head.toScreenMs)}`,
          head.playbackMs !== undefined && ` · line lasted ${ms(head.playbackMs)}`,
        ),
        h('ul', { class: 'bars' }, stages.map((s) =>
          h('li', { class: s.key === slow?.key ? 'slowest' : '' },
            h('span', { class: 'bar-label' }, s.label),
            h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: `width:${Math.max(2, (s.ms / max) * 100)}%` })),
            h('span', { class: 'bar-ms' }, ms(s.ms)),
          ),
        )),
        !!slow && stages.length > 1 && h('small', {}, `Slowest stage: ${STAGE_LABELS[slow.key] ?? slow.label}`),
        !!last.meta.voicePath && h('small', {}, `Voice: ${String(last.meta.voicePath)}${last.meta.audioBytes ? `, ${last.meta.audioBytes} bytes` : ''}`),
      );
    }
    const sum = summarize(hasVoice ? tracer.all().filter((t) => t.label === 'voice') : tracer.all());
    const rows = [sum.toFirstSound, sum.toScreen, ...sum.stages].filter((r): r is NonNullable<typeof r> => !!r);
    if (rows.length) {
      parts.push(
        h('table', { class: 'timing-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Stage'), h('th', {}, 'n'), h('th', {}, 'median'), h('th', {}, 'p90'))),
          h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.label), h('td', {}, String(r.n)), h('td', {}, ms(r.median)), h('td', {}, ms(r.p90))))),
        ),
      );
    }
    parts.push(
      h('button', { onclick: () => void copy(body) }, 'Copy results'),
      h('button', { class: 'link', onclick: () => tracer.clear() }, 'Clear'),
    );
    body.replaceChildren(...parts.filter((p): p is Node => !!p));
  }

  async function copy(container: HTMLElement): Promise<void> {
    const json = JSON.stringify(exportResults(tracer.all(), context()), null, 2);
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
