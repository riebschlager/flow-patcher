// Orbit Rings ★: Flow's three rotating ellipses (orbit-rings.js), an overlay
// (ADR 0030). They fade in while Active, sit at X/Y, grow with Radius and
// tilt with the Angle signal (Circle's unwrapped angle, #78), and fade out
// holding their last pose when Active drops.
//
// State and drawing are apart (docs/nodes/visual.md): frame() runs
// `updateRings` on the frame clock; the Overlay output's drawer turns that
// state into strokes (`ringStrokes`) and rasterizes them into the Renderer's
// picture. Strength (Flow's visual amount times the gesture's energy) and
// color are inputs, not app state.
//
// Changed from Flow:
// - Time is the frame clock in seconds, not performance.now() in ms.
// - Flow showed the rings only for its Orbit gesture kind; here Active says
//   when (cable Circle's state into it), and an unwired Active is always on.
// - Sizes are Flow's CSS pixels over a 720 px short side, scaled to the
//   picture, so a bigger picture draws the same rings, sharper. The line is at
//   least one picture pixel wide.
// - Reduced motion (HostServices.reducedMotion) keeps the rings, their color
//   and fades, and drops the rotation: they stay level.
import {
  colorPalettes,
  hexRGB,
  strokeEllipse,
  type EllipseStroke,
  type NodeContext,
  type NodeDefinition,
  type NodeState,
  type OverlayDrawer,
  type RGB,
} from '@flow-patcher/engine';

const TAU = Math.PI * 2;
/** Flow's canvas short side the pixel sizes below were tuned on. */
const REFERENCE_SIDE = 720;
/** Flow's ring geometry, in reference pixels. */
const BASE_RADIUS = 40, RADIUS_RANGE = 100, RING_STEP = 16, LINE_WIDTH = 1.4, ASPECT = 0.48, TILT = 0.2, MAX_ALPHA = 0.55;
export const RING_COUNT = 3;
/** Opacity time constants (s): the fade in, and the slower fade out. */
const FADE_IN = 0.1, FADE_OUT = 0.18;
/** Rotation easing time constant (s), and the longest step it eases over. */
const TURN = 0.18, MAX_TURN_STEP = 0.1;
/** Below this, a fading ring is gone. */
const GONE = 0.001;

export const ANGLE_UNITS = ['radians', 'turns'] as const;
/** The palette slot the rings take when no Color value comes in. */
export const RING_DYES = ['dye 1', 'dye 2', 'dye 3', 'dye 4'] as const;

/** What the rings follow at one moment: Flow's gesture sample, reduced to what they read. */
export interface RingSample {
  active: boolean;
  x: number;
  y: number;
  /** 0–1: ring size (Flow's orbit metric). */
  orbit: number;
  /** Radians, wrapped or not. */
  heading: number;
}

/** The rings' presentation state (Flow's OrbitRings fields). Plain data. */
export interface Rings {
  opacity: number;
  /** Frame-clock seconds of the last update, or null before the first. */
  time: number | null;
  heading: number;
  targetHeading: number;
  lastHeading: number;
  strength: number;
  x: number;
  y: number;
  orbit: number;
  color: RGB;
}

export const createRings = (): Rings => ({ opacity: 0, time: null, heading: 0, targetHeading: 0, lastHeading: 0, strength: 0, x: 0.5, y: 0.5, orbit: 0, color: [1, 1, 1] });

const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
const clampUnit = (value: number) => Math.max(0, Math.min(1, value));

/** Advances the rings to `now` (seconds) from one sample. Flow's OrbitRings.update. */
export function updateRings(rings: Rings, sample: RingSample, now: number, strength: number, color: RGB): void {
  const dt = rings.time === null || !Number.isFinite(now) ? 0 : Math.max(0, now - rings.time);
  if (Number.isFinite(now)) rings.time = now;
  const active = sample.active && strength > 0;
  if (!active && rings.opacity === 0) return;
  if (active) {
    const heading = finiteOr(sample.heading, 0);
    if (rings.opacity === 0) rings.heading = rings.targetHeading = heading;
    // Unwrap before easing: crossing ±π must not flip the rings.
    else rings.targetHeading += Math.atan2(Math.sin(heading - rings.lastHeading), Math.cos(heading - rings.lastHeading));
    rings.lastHeading = heading;
    rings.x = clampUnit(finiteOr(sample.x, 0.5));
    rings.y = clampUnit(finiteOr(sample.y, 0.5));
    rings.orbit = clampUnit(finiteOr(sample.orbit, 0));
    rings.strength = Math.min(1, strength);
    rings.color = color;
  }
  rings.opacity += ((active ? 1 : 0) - rings.opacity) * -Math.expm1(-dt / (active ? FADE_IN : FADE_OUT));
  rings.heading += (rings.targetHeading - rings.heading) * -Math.expm1(-Math.min(dt, MAX_TURN_STEP) / TURN);
  if (!active && rings.opacity < GONE) rings.opacity = 0;
  // Keep long performances numerically close to zero without changing orientation.
  if (Math.abs(rings.heading) > TAU * 100) {
    const turns = Math.trunc(rings.heading / (TAU * 5)) * TAU * 5;
    rings.heading -= turns;
    rings.targetHeading -= turns;
  }
}

/** Whether the rings show at all: drawn with some opacity and strength. */
export const ringsVisible = (rings: Rings): boolean => rings.opacity > 0 && rings.strength > 0;

/** Ring i (0 innermost) as an outline in a width × height picture, written into `out`. Flow's OrbitRings.draw. */
export function ringStroke(rings: Rings, i: number, width: number, height: number, reducedMotion: boolean, out: EllipseStroke): EllipseStroke {
  const unit = Math.min(width, height) / REFERENCE_SIDE;
  const r = (BASE_RADIUS + rings.orbit * RADIUS_RANGE + i * RING_STEP) * unit;
  out.cx = rings.x * width;
  out.cy = rings.y * height;
  out.rx = r;
  out.ry = r * ASPECT;
  out.rotation = reducedMotion ? 0 : rings.heading * TILT;
  out.lineWidth = Math.max(1, LINE_WIDTH * unit);
  out.color = rings.color;
  out.alpha = MAX_ALPHA * rings.strength * rings.opacity;
  return out;
}

const blankStroke = (): EllipseStroke => ({ cx: 0, cy: 0, rx: 0, ry: 0, rotation: 0, lineWidth: 0, color: [0, 0, 0], alpha: 0 });

/** The rings as outlines in a width × height picture: none while hidden. */
export function ringStrokes(rings: Rings, width: number, height: number, reducedMotion = false): EllipseStroke[] {
  if (rings.opacity === 0) return [];
  return Array.from({ length: RING_COUNT }, (_, i) => ringStroke(rings, i, width, height, reducedMotion, blankStroke()));
}

/** Frame-only state (Orbit Rings has no query, so it is never snapshotted and may hold the drawer). */
interface OrbitRingsState extends NodeState {
  rings?: Rings;
  reduced?: boolean;
  drawer?: OverlayDrawer;
  /** Reused for each ring as it's drawn, so drawing allocates nothing. */
  stroke?: EllipseStroke;
}

/** Each palette's four slots as 0–1 RGB, parsed once. A constant table, not state. */
const PALETTE_RGB: Readonly<Record<string, readonly RGB[]>> = Object.fromEntries(
  Object.entries(colorPalettes).map(([id, palette]) => [id, palette.colors.map((c) => hexRGB(c.hex))]),
);

/** A Color Value as 0–1 RGB: '#rrggbb', or [r, g, b] with 0–1 channels. Anything else is null. */
export function colorOf(value: unknown): RGB | null {
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return hexRGB(value);
  if (Array.isArray(value) && value.length === 3 && value.every((c) => typeof c === 'number' && Number.isFinite(c))) return value.map(clampUnit) as RGB;
  return null;
}

function colorAt(ctx: NodeContext, t: number): RGB {
  const wired = ctx.connected('color') ? colorOf(ctx.value('color', t)) : null;
  if (wired) return wired;
  const palette = PALETTE_RGB[ctx.params.palette as string] ?? PALETTE_RGB.classic!;
  const slot = Math.max(0, RING_DYES.indexOf(ctx.params.dye as (typeof RING_DYES)[number]));
  return palette[slot]!;
}

function sampleAt(ctx: NodeContext, t: number): RingSample {
  const read = (port: string, unwired: number) => (ctx.connected(port) ? ctx.signal(port, t) : unwired);
  const angle = read('angle', 0);
  return {
    active: !ctx.connected('active') || ctx.signal('active', t) >= 0.5,
    x: read('x', 0.5),
    y: read('y', 0.5),
    orbit: ctx.param('radius', t),
    heading: ctx.params.unit === 'turns' ? angle * TAU : angle,
  };
}

export const orbitRings: NodeDefinition = {
  type: 'orbit-rings',
  version: 1,
  label: 'Orbit Rings',
  category: 'visual',
  description: 'Three tilted rings at X/Y that turn with Angle, fading in while Active. Cable Overlay into the Renderer’s Overlays.',
  ports: [
    { name: 'angle', type: 'signal', direction: 'in', label: 'Angle', unwiredHint: 'The rings stay level.' },
    { name: 'x', type: 'signal', direction: 'in', label: 'X', unwiredHint: 'Rings in the middle (0.5).' },
    { name: 'y', type: 'signal', direction: 'in', label: 'Y', unwiredHint: 'Rings in the middle (0.5).' },
    { name: 'active', type: 'signal', direction: 'in', label: 'Active', unwiredHint: 'Always showing.' },
    { name: 'color', type: 'value', direction: 'in', label: 'Color' },
    { name: 'overlay', type: 'field', direction: 'out', label: 'Overlay', fieldKind: 'overlay' },
  ],
  params: [
    { name: 'radius', kind: 'number', min: 0, max: 1, default: 0.5, label: 'Radius' },
    { name: 'strength', kind: 'number', min: 0, max: 1, default: 0.65, label: 'Strength' },
    { name: 'unit', kind: 'enum', options: ANGLE_UNITS, default: 'radians', label: 'Angle unit' },
    { name: 'palette', kind: 'enum', options: Object.keys(colorPalettes), default: 'classic', label: 'Palette' },
    { name: 'dye', kind: 'enum', options: RING_DYES, default: 'dye 1', label: 'Dye' },
  ],
  field(ctx) {
    const s = ctx.state as OrbitRingsState;
    return (s.drawer ??= {
      kind: 'overlay',
      visible: () => (s.rings ? ringsVisible(s.rings) : false),
      draw(target) {
        const rings = s.rings;
        if (!rings || !ringsVisible(rings)) return;
        const stroke = (s.stroke ??= blankStroke());
        for (let i = 0; i < RING_COUNT; i++) strokeEllipse(target, ringStroke(rings, i, target.width, target.height, s.reduced === true, stroke));
      },
    });
  },
  frame(ctx) {
    const s = ctx.state as OrbitRingsState;
    s.reduced = ctx.services.reducedMotion?.() === true;
    const t = ctx.t1;
    updateRings((s.rings ??= createRings()), sampleAt(ctx, t), t, ctx.param('strength', t), colorAt(ctx, t));
  },
};
