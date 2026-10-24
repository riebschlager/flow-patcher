import type { EngineEvent, InputFields, InputSpec, NodeDefinition, QueryResult } from '@flow-patcher/engine';

/** The outputs, one per browser event Click reads. */
export const CLICK_PORTS = ['click', 'double', 'middle', 'right'] as const;
export type ClickPort = (typeof CLICK_PORTS)[number];

/** The input stream type (ADR 0029) each output reads. */
export const CLICK_READS = {
  click: 'click',
  dblclick: 'double',
  auxclick: 'middle',
  contextmenu: 'right',
} as const satisfies InputSpec['reads'];

/** The button an auxclick has for Middle. Browsers also send auxclick for the right button (beside
 *  contextmenu) and the back and forward buttons (3 and 4), which Middle leaves out. */
export const MIDDLE_BUTTON = 1;

/** Whether an event of a type Click reads reaches its output: every one, except an auxclick that isn't the middle button's. */
export function clickAccepts(event: Readonly<Pick<InputFields, 'type' | 'button'>>): boolean {
  return event.type !== 'auxclick' || event.button === MIDDLE_BUTTON;
}

/** A position field, clamped to 0–1, or undefined when it's missing or not a finite number. */
function unit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
}

/** One pushed event as Click emits it: its channel an integer (else 0), x and y clamped to 0–1 (left out when not finite). */
function rewrite(event: EngineEvent): EngineEvent {
  const out: EngineEvent = { ...event, channel: Number.isInteger(event.channel) ? event.channel : 0 };
  for (const axis of ['x', 'y'] as const) {
    const value = unit(event[axis]);
    if (value === undefined) delete out[axis];
    else out[axis] = value;
  }
  return out;
}

/**
 * Canvas source: clicks on the performance canvas (docs/nodes/canvas-sources.md). `input` reads
 * click, dblclick, auxclick and contextmenu (ADR 0029); the host pushes each browser event once,
 * stamped currentTime + 5 ms, as `{ x, y, pointerType, button, buttons, shift, alt, ctrl, meta }`,
 * x and y normalized 0–1 with y = 0 at the top. Click isn't a contact source: the host sends no
 * channel, so its events are on channel 0, and it has no All output and no signals.
 *
 * - **Click**: each `click`, the primary button's (browsers send click for button 0 only, and on
 *   a tap). A double click is two Clicks and then a Double, as the browser sends them.
 * - **Double**: each `dblclick`.
 * - **Middle**: each `auxclick` with button 1 (MIDDLE_BUTTON). Browsers send auxclick for the
 *   right, back and forward buttons too; those are dropped (`accepts`), so a right-click is Right only.
 * - **Right**: each `contextmenu`: a right-click, Ctrl-click on macOS, a long press on touch, or
 *   the keyboard's menu key. While a patch has a Click node the host suppresses the context menu
 *   (Platform rules).
 *
 * It rewrites its pushes (`InputSpec.rewrites`) so weird input gives a defined result: x and y are
 * clamped to 0–1 and left out when they aren't finite numbers, and a channel that isn't an integer
 * becomes 0. The rest of the payload passes through, at the push's time (the immediate path).
 * Pushes with a non-finite time are dropped. Stateless: each window returns its own pushes, so
 * windowing can't change anything.
 */
export const click: NodeDefinition = {
  type: 'click',
  version: 1,
  label: 'Click',
  category: 'canvas-sources',
  description: 'Click, Double, Middle and Right events from clicks on the canvas, with their position, buttons and modifier keys.',
  ports: [
    { name: 'click', type: 'event', direction: 'out', label: 'Click' },
    { name: 'double', type: 'event', direction: 'out', label: 'Double' },
    { name: 'middle', type: 'event', direction: 'out', label: 'Middle' },
    { name: 'right', type: 'event', direction: 'out', label: 'Right' },
  ],
  params: [],
  input: { reads: CLICK_READS, accepts: clickAccepts, rewrites: true },
  query({ pushed }) {
    const result: QueryResult = {};
    for (const port of CLICK_PORTS) {
      const events = (pushed[port] ?? [])
        .filter((e) => Number.isFinite(e.time) && (port !== 'middle' || e.button === MIDDLE_BUTTON))
        .map(rewrite);
      if (events.length) result[port] = events;
    }
    return result;
  },
};
