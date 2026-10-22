import {
  advanceTransport,
  beatAt,
  createTransport,
  phaseAt,
  retune,
  type EngineEvent,
  type NodeContext,
  type NodeDefinition,
  type Transport,
  type TransportTempo,
} from '@flow-patcher/engine';

/** Note values as fractions of a whole note; one beat is a quarter note. */
export const CLOCK_DIVISIONS: Record<string, number> = {
  '1/1': 1, '1/2': 1 / 2, '1/4': 1 / 4, '1/8': 1 / 8, '1/16': 1 / 16, '1/32': 1 / 32,
  '1/4T': 1 / 6, '1/8T': 1 / 12, '1/16T': 1 / 24,
};

const BPM = { min: 20, max: 300, default: 120 };
const RATE = { min: 0.25, max: 4, default: 1 };
const SWING = { min: 0, max: 0.75, default: 0 };

/** Knob values as stored in state; a change means a new plan took effect. */
interface Knobs {
  bpm: number;
  rate: number;
  swing: number;
  division: string;
}

interface ClockState {
  transport?: Transport;
  knobs?: Knobs;
}

const finiteIn = (x: number, range: { min: number; max: number; default: number }) =>
  Number.isFinite(x) ? Math.max(range.min, Math.min(range.max, x)) : range.default;

/** The transport tempo at t: knobs plus modulation, clamped so the transport never throws. */
function tempoAt(ctx: NodeContext, t: number): TransportTempo {
  const bpm = finiteIn(ctx.param('bpm', t), BPM);
  const rate = finiteIn(ctx.param('rate', t), RATE);
  const swing = finiteIn(ctx.param('swing', t), SWING);
  const division = CLOCK_DIVISIONS[ctx.params.division as string] ?? CLOCK_DIVISIONS['1/4']!;
  return { beatsPerSecond: (bpm / 60) * rate, stepBeats: 4 * division, swing };
}

const knobsOf = (ctx: NodeContext): Knobs => ({
  bpm: ctx.params.bpm as number,
  rate: ctx.params.rate as number,
  swing: ctx.params.swing as number,
  division: ctx.params.division as string,
});

const sameKnobs = (a: Knobs, b: Knobs) => a.bpm === b.bpm && a.rate === b.rate && a.swing === b.swing && a.division === b.division;

/**
 * Generator and transport source (ADR 0018). Ticks fire at a note division
 * from time 0; each carries the transport's step index in `index`. Transport
 * is the beat position at any time already queried, Phase the even, unswung
 * ramp through the current step. A knob change re-anchors both at the window
 * the new plan starts, and a modulated tempo is sampled at each tick, so
 * neither ever jumps and the ticks don't depend on the windowing.
 */
export const clock: NodeDefinition = {
  type: 'clock',
  version: 3,
  label: 'Clock',
  category: 'time-rhythm',
  description: 'Emits ticks at a note division of a tempo, with a Phase ramp and the beat position on Transport.',
  ports: [
    { name: 'tick', type: 'event', direction: 'out', label: 'Tick' },
    { name: 'phase', type: 'signal', direction: 'out', label: 'Phase' },
    { name: 'transport', type: 'value', direction: 'out', label: 'Transport' },
  ],
  params: [
    { name: 'bpm', kind: 'number', ...BPM, unit: 'bpm', label: 'Tempo' },
    { name: 'rate', kind: 'number', ...RATE, unit: '×', label: 'Rate' },
    { name: 'swing', kind: 'number', ...SWING, label: 'Swing' },
    { name: 'division', kind: 'enum', options: Object.keys(CLOCK_DIVISIONS), default: '1/4', label: 'Division' },
  ],
  query(ctx) {
    const { t0, t1 } = ctx;
    const s = ctx.state as ClockState;
    const sample = (t: number) => tempoAt(ctx, t);
    const knobs = knobsOf(ctx);
    if (!s.transport) {
      s.transport = createTransport(sample(0), 0);
      s.knobs = knobs;
    } else if (!s.knobs || !sameKnobs(s.knobs, knobs)) {
      // A new plan took effect at this window. Compare knobs, not the anchor's
      // tempo, so a modulated tempo doesn't re-anchor at every window.
      // A window before the newest anchor can't re-anchor in the past; keep
      // the old knobs so the next window at or after it still sees the change.
      if (t0 >= s.transport.anchors.at(-1)!.time) {
        retune(s.transport, t0, sample(t0));
        s.knobs = knobs;
      }
    }
    const tick: EngineEvent[] = advanceTransport(s.transport, t0, t1, sample).map((k) => ({ time: k.time, channel: 0, index: k.step }));
    return { tick };
  },
  signal({ state }, port, t) {
    const transport = (state as ClockState).transport;
    return port === 'phase' && transport ? phaseAt(transport, t) : 0;
  },
  value({ state }, port, t) {
    const transport = (state as ClockState).transport;
    return port === 'transport' && transport ? beatAt(transport, t) : 0;
  },
};
