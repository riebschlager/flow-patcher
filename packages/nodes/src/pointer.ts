import type { NodeDefinition } from '@flow-patcher/engine';

/**
 * Canvas source: the pointers on the performance canvas (docs/nodes/canvas-sources.md).
 * M1 basic, events only. The host turns pointerdown, pointermove, pointerup and
 * pointercancel into `scheduler.push(nodeId, 'down' | 'move' | 'up' | 'cancel',
 * { channel: pointerId, x, y, pressure, … })`, with x and y normalized 0–1 and
 * y = 0 at the top. The scheduler stamps them currentTime + 5 ms and the runtime
 * merges them into this node's outputs (ADR 0019), so they pass through unchanged.
 * The node computes nothing itself: `query` emits no events of its own.
 *
 * TODO(#27, after #20 merges): add the X, Y and Pressure signals per channel and
 * Count. They need the engine to hand `query` the events pushed onto this node's
 * own outputs (a `pushed` map on QueryContext), so per-channel position, pressure
 * and the active set can be kept in `ctx.state` and read by `signal()`.
 */
export const pointer: NodeDefinition = {
  type: 'pointer',
  version: 1,
  label: 'Pointer',
  category: 'canvas-sources',
  description: 'Down, Move, Up and Cancel events from pointers on the canvas, one channel per pointer.',
  ports: [
    { name: 'down', type: 'event', direction: 'out', label: 'Down' },
    { name: 'move', type: 'event', direction: 'out', label: 'Move' },
    { name: 'up', type: 'event', direction: 'out', label: 'Up' },
    { name: 'cancel', type: 'event', direction: 'out', label: 'Cancel' },
  ],
  params: [],
  query() {
    return {};
  },
};
