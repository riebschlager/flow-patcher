import type { EngineEvent, InputSpec, NodeDefinition, QueryResult } from '@flow-patcher/engine';

/** The browser's `WheelEvent.deltaMode` units, in CSS pixels: a line and a page (the values
 *  Facebook's normalize-wheel uses, so a Firefox notch of 3 lines is 120 px, near Chrome's 100). */
export const LINE_PIXELS = 40;
export const PAGE_PIXELS = 800;

/** Pixels per signal unit: one mouse-wheel notch in Chrome (100 px) moves Scroll X or Y by about 1. */
export const WHEEL_STEP = 100;

/** A single event's delta is clamped to ±this many pixels (after deltaMode), so one wild event can't swamp the sums. */
export const MAX_DELTA = 10_000;

/** The accumulated signals are clamped to ±this, so a long scroll with no decay stays finite. */
export const MAX_SUM = 1_000;

/** The output each wheel event goes to: plain wheels to DeltaX and DeltaY, ctrl+wheel (a trackpad pinch) to Zoom. */
export const WHEEL_PORTS = ['deltaX', 'deltaY', 'zoom'] as const;

/** Wheel reads `wheel` onto a push-only port, and its query sorts each push onto its outputs. */
export const WHEEL_READS = { wheel: 'wheel' } as const satisfies InputSpec['reads'];

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));

/** A delta in CSS pixels: lines (deltaMode 1) and pages (2) converted, clamped to ±MAX_DELTA; 0 when it isn't a finite number. */
export function wheelPixels(delta: unknown, deltaMode: unknown): number {
  if (!finite(delta)) return 0;
  const scale = deltaMode === 1 ? LINE_PIXELS : deltaMode === 2 ? PAGE_PIXELS : 1;
  // `+ 0` turns −0 into 0.
  return clamp(delta * scale, MAX_DELTA) + 0;
}

/** One wheel push's contribution to the sums, in signal units (WHEEL_STEP pixels). */
interface Change {
  time: number;
  x: number;
  y: number;
  zoom: number;
}

/** The sums as of their last change: `t` its time, or null before any. */
interface Sum {
  t: number | null;
  x: number;
  y: number;
  zoom: number;
}

const EMPTY: Sum = { t: null, x: 0, y: 0, zoom: 0 };
const rateOf = (decay: unknown): number => (finite(decay) && decay > 0 ? decay : 0);

/** Decays `sum` from its last change to `time` (never backwards) and adds `change`. Mutates `sum`. */
function fold(sum: Sum, change: Change, rate: number): void {
  const k = sum.t === null ? 0 : Math.exp(-rate * Math.max(0, change.time - sum.t));
  sum.x = clamp(sum.x * k + change.x, MAX_SUM);
  sum.y = clamp(sum.y * k + change.y, MAX_SUM);
  sum.zoom = clamp(sum.zoom * k + change.zoom, MAX_SUM);
  sum.t = change.time;
}

/** One push as Wheel emits it: deltas in pixels, `deltaMode` dropped, x and y clamped to 0–1 (left out when not finite), an integer channel (else 0). */
function rewrite(event: EngineEvent): EngineEvent {
  const { deltaMode, ...rest } = event;
  const out: EngineEvent = { ...rest, channel: Number.isInteger(event.channel) ? event.channel : 0, deltaX: wheelPixels(event.deltaX, deltaMode), deltaY: wheelPixels(event.deltaY, deltaMode) };
  for (const axis of ['x', 'y'] as const) {
    const value = event[axis];
    if (finite(value)) out[axis] = Math.min(1, Math.max(0, value));
    else delete out[axis];
  }
  return out;
}

/**
 * Canvas source: the mouse wheel and trackpad scrolling on the performance canvas
 * (docs/nodes/canvas-sources.md). `input` reads `wheel` (ADR 0029); the host pushes each
 * browser wheel event once, stamped currentTime + 5 ms, as `{ x, y, deltaX, deltaY, deltaMode,
 * shift, alt, ctrl, meta }`: the pointer's position (0–1, y = 0 at the top) and the deltas and
 * deltaMode as the browser reports them. Not a contact source: the host sends no channel, so its
 * events are on channel 0, and it has no All output.
 *
 * It rewrites its pushes (`InputSpec.rewrites`), each at the push's own time:
 * - `deltaX`, `deltaY` become CSS pixels whatever the deltaMode (lines × LINE_PIXELS, pages ×
 *   PAGE_PIXELS), clamped to ±MAX_DELTA, 0 when missing or not finite; `deltaMode` is dropped.
 *   Positive is right and down, the way the browser reports scrolling (macOS natural scrolling
 *   already flips them).
 * - **DeltaX** / **DeltaY**: a wheel without Ctrl whose deltaX / deltaY isn't 0. A diagonal
 *   trackpad swipe gives both.
 * - **Zoom**: a wheel with Ctrl. Chrome, Edge and Firefox send a macOS trackpad pinch as
 *   wheel + ctrlKey, as is Ctrl + mouse wheel, which browsers treat as zoom. It goes to Zoom
 *   only, never DeltaY, with `zoom` = −deltaY / WHEEL_STEP: positive zooms in (fingers apart,
 *   Ctrl + wheel up), and e^zoom is the scale step. (Safari sends pinches as gesturechange:
 *   Touch extras.)
 * - x and y clamp to 0–1 (left out when not finite), a channel that isn't an integer becomes 0,
 *   and the rest of the payload passes through. Pushes with a non-finite time are dropped.
 *
 * Signals, the same on every channel: **Scroll X**, **Scroll Y** and **Zoom level**, the running
 * sums of deltaX / WHEEL_STEP, deltaY / WHEEL_STEP (plain wheels) and `zoom` (Ctrl wheels), so a
 * Chrome mouse notch moves one by about 1. Each decays toward 0 exponentially from its last
 * event: sum × e^(−decay × seconds since). **Decay** is that rate, per second: 0 holds the sums,
 * 1 loses 63% a second, and the default 2 halves them in about 0.35 s. The sums clamp to
 * ±MAX_SUM. Before any wheel every signal is 0. Not modulatable: the decay is applied
 * analytically between events, so it must hold still between them.
 *
 * State (plain data): `sum` the sums as of the current window's start (with the time of their
 * last change), `pending` this window's changes. `query` folds the previous window's changes in
 * first; `signal(t)` folds the pending ones at or before t into a copy and decays it to t. Each
 * change folds once, at its own time, so the signals don't depend on the window size.
 */
export const wheel: NodeDefinition = {
  type: 'wheel',
  version: 1,
  label: 'Wheel',
  category: 'canvas-sources',
  description: 'DeltaX, DeltaY and Zoom events from the mouse wheel, trackpad scrolling and trackpad pinch on the canvas, with decaying Scroll X, Scroll Y and Zoom level sums.',
  ports: [
    { name: 'deltaX', type: 'event', direction: 'out', label: 'DeltaX' },
    { name: 'deltaY', type: 'event', direction: 'out', label: 'DeltaY' },
    { name: 'zoom', type: 'event', direction: 'out', label: 'Zoom' },
    { name: 'scrollX', type: 'signal', direction: 'out', label: 'Scroll X' },
    { name: 'scrollY', type: 'signal', direction: 'out', label: 'Scroll Y' },
    { name: 'zoomLevel', type: 'signal', direction: 'out', label: 'Zoom level' },
  ],
  params: [{ name: 'decay', kind: 'number', min: 0, max: 20, default: 2, unit: '/s', label: 'Decay', modulatable: false }],
  input: { reads: WHEEL_READS, rewrites: true },
  query({ state, params, pushed }) {
    const sum = (state.sum ??= { ...EMPTY }) as Sum;
    const rate = rateOf(params.decay);
    for (const change of (state.pending ?? []) as Change[]) fold(sum, change, rate);
    const pending: Change[] = [];
    const out: Record<(typeof WHEEL_PORTS)[number], EngineEvent[]> = { deltaX: [], deltaY: [], zoom: [] };
    for (const event of pushed.wheel ?? []) {
      if (!Number.isFinite(event.time)) continue;
      const e = rewrite(event);
      const dx = e.deltaX as number, dy = e.deltaY as number;
      if (event.ctrl === true) {
        const zoom = -dy / WHEEL_STEP + 0;
        if (zoom !== 0) out.zoom.push({ ...e, zoom });
        pending.push({ time: event.time, x: 0, y: 0, zoom });
      } else {
        if (dx !== 0) out.deltaX.push(e);
        if (dy !== 0) out.deltaY.push(e);
        pending.push({ time: event.time, x: dx / WHEEL_STEP, y: dy / WHEEL_STEP, zoom: 0 });
      }
    }
    state.pending = pending;
    const result: QueryResult = {};
    for (const port of WHEEL_PORTS) if (out[port].length) result[port] = out[port];
    return result;
  },
  signal({ state, params }, port, t) {
    // Reads never write state: only query() changes it (NodeState contract).
    const sum: Sum = { ...((state.sum as Sum | undefined) ?? EMPTY) };
    const rate = rateOf(params.decay);
    for (const change of (state.pending ?? []) as Change[]) {
      if (change.time > t) break;
      fold(sum, change, rate);
    }
    if (sum.t === null) return 0;
    const k = Math.exp(-rate * Math.max(0, t - sum.t));
    const value = port === 'scrollX' ? sum.x : port === 'scrollY' ? sum.y : port === 'zoomLevel' ? sum.zoom : 0;
    return value * k + 0;
  },
};
