import type { EngineEvent, NodeContext, NodeDefinition, PortSpec } from '@flow-patcher/engine';
import { IN_PORT, Outputs, PASS_PORTS, routeContacts } from './recognizer';

/** Zones with their own output. Higher zones (a grid of more than 8 cells) come out of Zones only. */
export const ZONE_OUTPUTS = 8;
export const SHAPES = ['grid', 'left/right', 'rings', 'mask'] as const;

type Point = [number, number];

/**
 * Parses a mask: polygons separated by ";", each three or more "x,y" points separated by spaces,
 * in canvas units (0–1, y = 0 at the top). Polygon n is zone n. Returns the polygons and an error
 * for the first one that doesn't parse; an unusable mask has no zones.
 */
export function parseMask(text: string): { polygons: Point[][]; error: string | null } {
  const polygons: Point[][] = [];
  const parts = text.split(';').map((p) => p.trim()).filter((p) => p !== '');
  if (!parts.length) return { polygons, error: 'Draw at least one polygon: three or more "x,y" points, polygons separated by ";".' };
  for (const [i, part] of parts.entries()) {
    const points: Point[] = [];
    for (const pair of part.split(/\s+/)) {
      const xy = pair.split(',');
      const [x, y] = xy.map((v) => (v.trim() === '' ? NaN : Number(v)));
      if (xy.length !== 2 || !Number.isFinite(x) || !Number.isFinite(y)) return { polygons: [], error: `Polygon ${i + 1}: "${pair}" isn't an x,y point.` };
      points.push([x!, y!]);
    }
    if (points.length < 3) return { polygons: [], error: `Polygon ${i + 1} needs at least three points.` };
    polygons.push(points);
  }
  return { polygons, error: null };
}

export const maskError = (text: string): string | null => parseMask(text).error;

/** Even-odd rule: is (x, y) inside the polygon? Points on an edge may go either way. */
export function inside(polygon: readonly Point[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!, [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const coordinate = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The zone (from 1) an event's position falls in under the params at its time, or 0 for none. */
export function zoneOf(ctx: Pick<NodeContext, 'params' | 'param'>, event: EngineEvent, polygons: readonly Point[][]): number {
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
    case 'mask': {
      const n = polygons.findIndex((polygon) => inside(polygon, x, y));
      return n + 1;
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
 * - mask: the polygons in Mask (`parseMask`), the first that holds the point being its zone.
 *   Outside every polygon is no zone. There's no drawing tool yet: the mask is typed as points.
 *
 * A contact goes to the zone its `down` lands in and stays there until it ends (ADR 0028), even
 * when the drag crosses into another zone, so no branch is left with a down and no up. Events
 * outside a contact (hovers, events with no `phase`) go by their own position. Knobs are read at
 * the deciding event's time and channel.
 *
 * Zone 1–8 carry their zone's events, Zones every event in any zone; each with a `zone` field, the
 * zone number. Events in no zone, or with no finite x and y, go out of Pass unchanged, with its
 * phase splits. Like Modifier Router, Zone decides at the down, so a routed contact never reaches
 * Pass and needs no claim cancel.
 */
export const zone: NodeDefinition = {
  type: 'zone',
  version: 1,
  label: 'Zone',
  category: 'gesture-recognizers',
  description: 'Splits contacts by canvas region (grid cells, left/right, rings or a mask) by where they go down; events in no zone go out of Pass.',
  ports: [
    IN_PORT,
    ...Array.from({ length: ZONE_OUTPUTS }, (_, i): PortSpec => ({ name: `zone${i + 1}`, type: 'event', direction: 'out', label: `Zone ${i + 1}` })),
    { name: 'zones', type: 'event', direction: 'out', label: 'Zones' },
    ...PASS_PORTS,
  ],
  params: [
    { name: 'shape', kind: 'enum', options: SHAPES, default: 'grid', label: 'Shape' },
    { name: 'rows', kind: 'number', min: 1, max: 8, step: 1, default: 2, label: 'Rows' },
    { name: 'columns', kind: 'number', min: 1, max: 8, step: 1, default: 2, label: 'Columns' },
    { name: 'split', kind: 'number', min: 0, max: 1, default: 0.5, label: 'Split' },
    { name: 'rings', kind: 'number', min: 1, max: 8, step: 1, default: 3, label: 'Rings' },
    { name: 'centerX', kind: 'number', min: 0, max: 1, default: 0.5, label: 'Center X' },
    { name: 'centerY', kind: 'number', min: 0, max: 1, default: 0.5, label: 'Center Y' },
    { name: 'radius', kind: 'number', min: 0.01, max: 1, default: 0.5, label: 'Radius' },
    {
      name: 'mask', kind: 'text', default: '0.25,0.25 0.75,0.25 0.75,0.75 0.25,0.75', label: 'Mask', check: maskError,
      presets: {
        'Center square': '0.25,0.25 0.75,0.25 0.75,0.75 0.25,0.75',
        'Top and bottom triangles': '0,0 1,0 0.5,0.5; 0,1 1,1 0.5,0.5',
        Diamond: '0.5,0.1 0.9,0.5 0.5,0.9 0.1,0.5',
      },
    },
  ],
  query(ctx) {
    const { inputs, state, params } = ctx;
    const polygons = params.shape === 'mask' && typeof params.mask === 'string' ? parseMask(params.mask).polygons : [];
    const outputs = new Outputs(state);
    for (const { event, route } of routeContacts(state, inputs.in ?? [], (e) => zoneOf(ctx, e, polygons))) {
      if (route === 0) outputs.pass(event);
      else outputs.send(route <= ZONE_OUTPUTS ? [`zone${route}`, 'zones'] : ['zones'], { ...event, zone: route });
    }
    return outputs.result();
  },
};
