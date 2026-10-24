import type { EngineEvent, NodeDefinition, NodeState, QueryResult } from '@flow-patcher/engine';

/** The canvas's size in CSS pixels, as of some time: [width, height]. */
type Size = [number, number];

/** One resize this window. */
interface Change {
  time: number;
  width: number;
  height: number;
}

/** The Event outputs. */
type EventPort = 'focus' | 'blur' | 'hidden' | 'visible';

const sizeOf = (state: NodeState): Size => (state.size ?? [0, 0]) as Size;
const pendingOf = (state: NodeState): Change[] => (state.pending ?? []) as Change[];

/** A dimension the host could have measured: a finite number of CSS pixels, 0 or more. */
const dimension = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/** Width over height, or 1 while either is 0 (no size yet, or a collapsed canvas). */
export const aspectOf = (width: number, height: number): number => (width > 0 && height > 0 ? width / height : 1);

/** The size at time t: the window's base, then this window's resizes at or before t. */
function sizeAt(state: NodeState, t: number): Size {
  // Reads never write state: only query() changes it (NodeState contract).
  let [width, height] = sizeOf(state);
  for (const change of pendingOf(state)) {
    if (change.time > t) break;
    width = change.width;
    height = change.height;
  }
  return [width, height];
}

/**
 * Canvas source: the performance canvas's lifecycle (docs/nodes/canvas-sources.md),
 * so a patch can follow the canvas's size and fade or pause cleanly when the
 * canvas loses focus or the page is hidden. Not a contact source: it has no All.
 *
 * It reads four stream types (ADR 0029), each event on channel 0 (one canvas):
 * - `resize`, with `canvasWidth` and `canvasHeight` in CSS pixels, on the push-only
 *   port `resize`. It moves the signals and emits nothing. A resize whose width or
 *   height is missing, negative or not finite is ignored.
 * - `focus` and `blur`: **Focus** and **Blur** events.
 * - `visibilitychange`, with `visibility` `'hidden'` or `'visible'` (the page's
 *   `document.visibilityState`), on the push-only port `visibility`: a **Hidden** or
 *   **Visible** event. Any other `visibility` is ignored.
 * It rewrites its pushes (`InputSpec.rewrites`), so it returns each event itself at
 * the push's time, on channel 0, without the payload: an event is the news, and the
 * size is on the signals. The host sends focus, blur and visibility only when they
 * change, so the node doesn't drop repeats.
 *
 * Signals, the same on every channel:
 * - **Width** and **Height**: the latest resize's size, CSS pixels; 0 before the first.
 * - **Aspect**: width / height, so a patch can follow the shape whatever the
 *   screen; 1 while either is 0.
 *
 * State (plain data), like MIDI In's: `size` as the current window began, and
 * `pending` this window's resizes in time order; `signal(t)` applies the pending
 * ones at or before t, so reads don't depend on how time was split into windows.
 */
export const canvas: NodeDefinition = {
  type: 'canvas',
  version: 1,
  label: 'Canvas',
  category: 'canvas-sources',
  description: "The canvas's Width, Height and Aspect, and Focus, Blur, Hidden and Visible events, to fade or pause when the canvas loses focus or the page is hidden.",
  ports: [
    { name: 'focus', type: 'event', direction: 'out', label: 'Focus' },
    { name: 'blur', type: 'event', direction: 'out', label: 'Blur' },
    { name: 'hidden', type: 'event', direction: 'out', label: 'Hidden' },
    { name: 'visible', type: 'event', direction: 'out', label: 'Visible' },
    { name: 'width', type: 'signal', direction: 'out', label: 'Width' },
    { name: 'height', type: 'signal', direction: 'out', label: 'Height' },
    { name: 'aspect', type: 'signal', direction: 'out', label: 'Aspect' },
  ],
  params: [],
  input: {
    reads: { resize: 'resize', focus: 'focus', blur: 'blur', visibilitychange: 'visibility' },
    rewrites: true,
  },
  query({ state, pushed }) {
    state.size = sizeAt(state, Infinity);
    const pending: Change[] = [];
    for (const e of pushed.resize ?? []) {
      const width = dimension(e.canvasWidth), height = dimension(e.canvasHeight);
      if (!Number.isFinite(e.time) || width === null || height === null) continue;
      pending.push({ time: e.time, width, height });
    }
    state.pending = pending;
    const out: Record<EventPort, EngineEvent[]> = { focus: [], blur: [], hidden: [], visible: [] };
    const emit = (port: EventPort, time: number) => {
      if (Number.isFinite(time)) out[port].push({ time, channel: 0 });
    };
    for (const e of pushed.focus ?? []) emit('focus', e.time);
    for (const e of pushed.blur ?? []) emit('blur', e.time);
    for (const e of pushed.visibility ?? []) {
      if (e.visibility === 'hidden') emit('hidden', e.time);
      else if (e.visibility === 'visible') emit('visible', e.time);
    }
    return out satisfies QueryResult;
  },
  signal(ctx, port, t) {
    const [width, height] = sizeAt(ctx.state, t);
    if (port === 'width') return width;
    if (port === 'height') return height;
    if (port === 'aspect') return aspectOf(width, height);
    return 0;
  },
};
