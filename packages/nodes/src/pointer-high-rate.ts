import type { NodeDefinition } from '@flow-patcher/engine';
import { POINTER_PORTS, POINTER_READS, pointerQuery, pointerSignal } from './pointer';

/**
 * Canvas source: Pointer with every sub-frame move sample (docs/nodes/canvas-sources.md,
 * ADR 0028), for smooth strokes and fast flicks. Browsers coalesce the pointer's moves
 * into one pointermove per frame; this node reads the samples of each (from
 * `getCoalescedEvents()`), which the host pushes as `pointermove` with `coalesced: true`,
 * and not the plain pointermove. The coalesced list includes the dispatched move itself,
 * so reading both would give each frame's last sample twice. Down, Up, Cancel, enter and
 * leave are read as Pointer reads them. Pointer reads only the plain moves, so the two
 * nodes see the same contacts at different rates.
 *
 * Everything else is Pointer's (pointer.ts shares its query and signals): it rewrites its
 * pushes onto slot channels with the derived fields, All tags each event with its phase,
 * and the X, Y, Pressure, Speed and Count signals follow the samples. Each node keeps its
 * own slot map, so a pointer usually has the same slot on both, but nothing ties them:
 * a node added mid-gesture, or a Pointer that never saw a hover sample, can differ.
 *
 * Timing: the host pushes a browser event's samples and its plain move as one push, at
 * one stamp (currentTime + 5 ms; stamps can't go back before currentTime, and moving the
 * later samples forward would add latency). Each sample carries `ago`, how long before
 * the dispatched move it was taken, so `dx`, `dy`, `speed` and `angle` come from the
 * samples' own spacing (time − ago). The samples keep their order on every output, all
 * at the push's time. Samples whose time − ago doesn't move past the previous sample's
 * (two pushes in one render quantum, about 2.7 ms, or a sample without `ago`) keep the
 * previous motion, by Pointer's same-time rule.
 */
export const pointerHighRate: NodeDefinition = {
  type: 'pointer-high-rate',
  version: 1,
  label: 'Pointer (high rate)',
  category: 'canvas-sources',
  description: 'Pointer with every sub-frame move sample the browser coalesced, for smooth strokes and fast flicks.',
  ports: POINTER_PORTS,
  params: [],
  input: {
    reads: POINTER_READS,
    accepts: (event) => (event.type === 'pointermove' ? event.coalesced === true : true),
    rewrites: true,
  },
  query: pointerQuery,
  signal: (ctx, port, t, channel) => pointerSignal(ctx.state, port, t, channel),
};
