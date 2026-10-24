import type { EngineEvent, NodeContext, NodeDefinition, PortSpec } from '@flow-patcher/engine';
import { IN_PORT, Outputs, PASS_PORTS, phaseOf } from './recognizer';

/** Zones with their own output. Higher zones (a grid of more than 8 cells) come out of Zones only. */
export const ZONE_OUTPUTS = 8;
/** A drawn mask waits for an editor drawing tool (#102). */
export const SHAPES = ['grid', 'left/right', 'rings'] as const;
export const ZONE_MODES = ['All phases', 'Presses only'] as const;

const coordinate = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The zone (from 1) an event's position falls in under the params at its time, or 0 for none. */
export function zoneOf(ctx: Pick<NodeContext, 'params' | 'param'>, event: EngineEvent): number {
  const x = coordinate(event.x), y = coordinate(event.y);
  if (x === null || y === null) return 0;
  const at = (name: string) => ctx.param(name, event.time, event.channel);
  switch (ctx.params.shape) {
    case 'left/right':
      return clamp01(x) < at('split') ? 1 : 2;
    case 'rings': {
      const rings = at('rings'), radius = at('radius');
      const d = Math.hypot(x - at('centerX'), y - at('centerY'));
      if (!(d <= radius)) return 0;
      return Math.min(rings, Math.floor((d / radius) * rings) + 1);
    }
    default: {
      const rows = at('rows'), columns = at('columns');
      const column = Math.min(columns - 1, Math.floor(clamp01(x) * columns));
      const row = Math.min(rows - 1, Math.floor(clamp01(y) * rows));
      return row * columns + column + 1;
    }
  }
}

/**
 * Gesture recognizer: splits events by canvas region (docs/nodes/gesture-recognizers.md). Shape:
 * - grid: Rows × Columns cells, numbered from 1 left to right, then top to bottom. Positions
 *   outside 0–1 count as the nearest edge cell.
 * - left/right: zone 1 left of Split, zone 2 from Split on.
 * - rings: Rings bands of equal width around (Center X, Center Y) out to Radius, zone 1 the
 *   innermost; beyond Radius is no zone. Distances are in canvas units, so on a canvas that
 *   isn't square the rings are ellipses.
 * A drawn mask waits for an editor drawing tool (#102).
 *
 * Events follow the pointer: each goes to the zone it's in, read at its time on its channel.
 * So that every zone's stream stays well formed (each down gets an up or cancel), a contact
 * that moves from zone A into zone B ends in A with an `up` and starts in B with a `down`,
 * both copies of the crossing move (its time, position and payload), in place of it; its later
 * moves go to B. No zone works the same way, on Pass. A contact's `up` or `cancel` ends it in
 * the zone it's in, without a crossing check. This is a deliberate difference from Switch and
 * Modifier Router, which keep a contact where it started. Events outside a contact (hovers,
 * a hover's `leave`, events with no `phase`) go by their own position.
 *
 * Outputs: Zone 1–8 carry their zone's events, and Zones every event in any zone (grids past
 * eight cells included); each with a `zone` field, the zone number, so at a crossing Zones carries
 * the up with A's number, then the down with B's. With Outputs set to Presses only, Zone 1–8
 * carry only `down` events, crossing downs included, so a slide across pads plays each pad;
 * Zones and Pass still carry every phase. Events in no zone, or with no finite x and y, go out of
 * Pass unchanged, and on Pass Down, Move, Up and Cancel without `phase`. Zone never claims.
 *
 * State: `zones`, each open contact's zone (0 for none), and `cell`, the event budget: moves
 * and events with no phase are thinned below NODE_EVENT_LIMIT − RESERVE, so downs, ups and
 * cancels always go out. A crossing goes out only whole, with room below RESERVE for its up and
 * down; when the window is that full, the contact stays in its zone until a later move finds
 * room (or it ends there), so every zone's stream stays well formed under the cap.
 */
export const zone: NodeDefinition = {
  type: 'zone',
  version: 1,
  label: 'Zone',
  category: 'gesture-recognizers',
  description: 'Splits events by canvas region (grid cells, left/right or rings), following the pointer; a contact crossing zones ends in one and starts in the next. Events in no zone go out of Pass.',
  ports: [
    IN_PORT,
    ...Array.from({ length: ZONE_OUTPUTS }, (_, i): PortSpec => ({ name: `zone${i + 1}`, type: 'event', direction: 'out', label: `Zone ${i + 1}` })),
    { name: 'zones', type: 'event', direction: 'out', label: 'Zones' },
    ...PASS_PORTS,
  ],
  params: [
    { name: 'shape', kind: 'enum', options: SHAPES, default: 'grid', label: 'Shape' },
    { name: 'outputs', kind: 'enum', options: ZONE_MODES, default: 'All phases', label: 'Outputs' },
    { name: 'rows', kind: 'number', min: 1, max: 8, step: 1, default: 2, label: 'Rows' },
    { name: 'columns', kind: 'number', min: 1, max: 8, step: 1, default: 2, label: 'Columns' },
    { name: 'split', kind: 'number', min: 0, max: 1, default: 0.5, label: 'Split' },
    { name: 'rings', kind: 'number', min: 1, max: 8, step: 1, default: 3, label: 'Rings' },
    { name: 'centerX', kind: 'number', min: 0, max: 1, default: 0.5, label: 'Center X' },
    { name: 'centerY', kind: 'number', min: 0, max: 1, default: 0.5, label: 'Center Y' },
    { name: 'radius', kind: 'number', min: 0.01, max: 1, default: 0.5, label: 'Radius' },
  ],
  query(ctx) {
    const { inputs, state, params } = ctx;
    const open = (state.zones ??= {}) as Record<string, number>;
    const pressesOnly = params.outputs === 'Presses only';
    const outputs = new Outputs(state);
    const portsOf = (z: number, phase: string) => (z <= ZONE_OUTPUTS && (!pressesOnly || phase === 'down') ? [`zone${z}`, 'zones'] : ['zones']);
    const emit = (z: number, event: EngineEvent, thin?: boolean) => {
      if (z === 0) return outputs.pass(event, thin);
      outputs.send(portsOf(z, event.phase as string), { ...event, zone: z }, thin);
    };
    /** Events a crossing's up in `from` and down in `to` cost. */
    const crossingCost = (from: number, to: number) => (from === 0 ? 2 : portsOf(from, 'up').length) + (to === 0 ? 2 : portsOf(to, 'down').length);
    for (const event of inputs.in ?? []) {
      if (!Number.isFinite(event.time) || !Number.isFinite(event.channel)) continue;
      const phase = phaseOf(event);
      if (!phase) {
        emit(zoneOf(ctx, event), event);
        continue;
      }
      const key = String(event.channel);
      const held = open[key];
      if (phase === 'down') {
        const z = zoneOf(ctx, event);
        open[key] = z;
        emit(z, event);
      } else if (held === undefined) {
        // A hover, or an end with no contact open.
        emit(zoneOf(ctx, event), event);
      } else if (phase === 'move') {
        const z = zoneOf(ctx, event);
        // A crossing goes out whole or not at all: without room below RESERVE for its up and down,
        // the contact stays where it is for now, and this move is thinned there.
        if (z === held || !outputs.fits(event.time, crossingCost(held, z))) emit(held, event);
        else {
          emit(held, { ...event, phase: 'up' }, false);
          emit(z, { ...event, phase: 'down' }, false);
          open[key] = z;
        }
      } else {
        delete open[key];
        emit(held, event);
      }
    }
    return outputs.result();
  },
};
