import { describe, expect, it } from 'vitest';
import {
  compilePatch,
  createInProcessFluid,
  FLUID_BACKGROUND,
  hexRGB,
  isOverlayDrawer,
  Runtime,
  type HostServices,
  type NodeState,
  type OverlayDrawer,
  type OverlayTarget,
  type Patch,
  type RGB,
} from '@flow-patcher/engine';
import { nodeRegistry, orbitRings, rendererImage } from '../src';
import { colorOf, createRings, ringStrokes, updateRings, type RingSample, type Rings } from '../src/orbit-rings';
import { context, frame } from './helpers';

const LILAC = hexRGB('#b7a0ff');
const WHITE: RGB = [1, 1, 1];
/** Flow's test sample: an orbit at (0.4, 0.6) just short of +π. */
const sample: RingSample = { active: true, x: 0.4, y: 0.6, orbit: 0.8, heading: Math.PI - 0.02 };

const drawerOf = (state: NodeState, services?: HostServices): OverlayDrawer => {
  const drawer = orbitRings.field!(context(orbitRings, { state, services }), 'overlay');
  if (!isOverlayDrawer(drawer)) throw new Error('Orbit Rings.overlay is not an OverlayDrawer');
  return drawer;
};
function target(width = 320, height = 180): OverlayTarget {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let k = 0; k < pixels.length; k += 4) pixels.set([...FLUID_BACKGROUND, 255], k);
  return { width, height, pixels };
}
const lit = (t: OverlayTarget) => {
  let n = 0;
  for (let k = 0; k < t.pixels.length; k += 4) if (t.pixels[k] !== FLUID_BACKGROUND[0]) n++;
  return n;
};

describe('orbit rings', () => {
  it('has Angle, X, Y, Active and Color inputs and an Overlay output for the Renderer', () => {
    expect(orbitRings.ports.map((p) => [p.name, p.type, p.direction])).toEqual([
      ['angle', 'signal', 'in'], ['x', 'signal', 'in'], ['y', 'signal', 'in'], ['active', 'signal', 'in'], ['color', 'value', 'in'], ['overlay', 'field', 'out'],
    ]);
    expect(orbitRings.ports.at(-1)!.fieldKind).toBe('overlay');
    expect(orbitRings.params.map((p) => p.name)).toEqual(['radius', 'strength', 'unit', 'palette', 'dye']);
    expect(orbitRings.query).toBeUndefined();
  });

  // Flow's orbit-rings.test.mjs, in seconds instead of milliseconds.
  describe('ported from Flow', () => {
    it('fades in gently, eases across ±π the short way, and fades out holding its pose', () => {
      const rings = createRings();
      updateRings(rings, sample, 0, 0.65, LILAC);
      expect(rings.opacity).toBe(0);
      updateRings(rings, sample, 0.016, 0.65, LILAC);
      expect(rings.opacity > 0 && rings.opacity < 0.2).toBe(true);
      updateRings(rings, sample, 0.15, 0.65, LILAC);
      expect(rings.opacity > 0.7 && rings.opacity < 1).toBe(true);

      // The π boundary continues in the same direction, and the wrapped change is eased.
      const heading = rings.heading;
      updateRings(rings, { ...sample, heading: -Math.PI + 0.02 }, 0.166, 0.65, LILAC);
      expect(rings.heading).toBeGreaterThan(heading);
      expect(rings.heading - heading).toBeLessThan(0.01);

      const targetHeading = rings.targetHeading;
      updateRings(rings, { ...sample, heading: -1 }, 0.182, 0.65, LILAC);
      expect(rings.heading).toBeLessThan(rings.targetHeading);
      expect(rings.targetHeading).toBeGreaterThan(targetHeading);

      // The fade holds the last ring position.
      const pose = { x: rings.x, y: rings.y, orbit: rings.orbit };
      const opacity = rings.opacity;
      updateRings(rings, { ...sample, active: false, x: 0.9, y: 0.1 }, 0.198, 0.65, WHITE);
      expect(rings.opacity > 0 && rings.opacity < opacity).toBe(true);
      expect({ x: rings.x, y: rings.y, orbit: rings.orbit }).toEqual(pose);

      // Three rings, faded, in the color they had while active.
      const drawn = ringStrokes(rings, 1000, 600);
      expect(drawn).toHaveLength(3);
      expect(drawn.every((d) => d.alpha > 0 && d.alpha < 0.55 * 0.65 && d.color === LILAC)).toBe(true);

      // A long while after release they're gone (Flow: another gesture kind; here, still inactive).
      updateRings(rings, { ...sample, active: false }, 1.6, 0.65, WHITE);
      expect(rings.opacity).toBe(0);
      expect(ringStrokes(rings, 1000, 600)).toEqual([]);
    });

    it('fades in and out at the same rate whatever the frame rate', () => {
      const envelope = (rate: number) => {
        const rings = createRings();
        updateRings(rings, sample, 0, 1, WHITE);
        for (let f = 1; f <= rate; f++) updateRings(rings, sample, f / rate, 1, WHITE);
        const peak = rings.opacity;
        for (let f = 1; f <= rate; f++) updateRings(rings, { ...sample, active: false }, 1 + f / rate, 1, WHITE);
        return [peak, rings.opacity];
      };
      const reference = envelope(60);
      for (const rate of [30, 120]) envelope(rate).forEach((value, i) => expect(Math.abs(value - reference[i]!)).toBeLessThan(1e-12));
    });
  });

  it('stays hidden with zero strength, and keeps the heading near zero over long performances', () => {
    const rings = createRings();
    for (let f = 0; f < 10; f++) updateRings(rings, sample, f / 60, 0, LILAC);
    expect(rings.opacity).toBe(0);
    // Half a radian a frame for a long while: the heading folds back by five turns at a time (whole turns
    // of the 0.2 tilt), so it stays bounded and the rings' orientation never jumps.
    const spinning = createRings();
    let folded = false;
    for (let f = 0; f < 20000; f++) {
      const before = spinning.heading;
      updateRings(spinning, { ...sample, heading: (f * 0.5) % (2 * Math.PI) }, f / 60, 1, LILAC);
      const step = spinning.heading - before;
      if (Math.abs(step) > 1) {
        folded = true;
        // Tilt before and after differ by whole turns only, up to the eased step.
        const tiltTurns = (step * 0.2) / (2 * Math.PI);
        expect(Math.abs(tiltTurns - Math.round(tiltTurns))).toBeLessThan(0.1);
      }
    }
    expect(folded).toBe(true);
    expect(Math.abs(spinning.heading)).toBeLessThanOrEqual(2 * Math.PI * 100);
  });

  it('sizes rings from Radius and the picture’s short side, and stays level with reduced motion', () => {
    const rings: Rings = { ...createRings(), opacity: 1, strength: 1, orbit: 0, heading: 1, x: 0.5, y: 0.5, color: LILAC };
    const small = ringStrokes(rings, 720, 1280);
    expect(small.map((s) => s.rx)).toEqual([40, 56, 72]);
    expect(small[0]!.ry).toBeCloseTo(40 * 0.48);
    expect(small[0]!.rotation).toBeCloseTo(0.2);
    expect(small[0]!.alpha).toBeCloseTo(0.55);
    expect(ringStrokes({ ...rings, orbit: 1 }, 1440, 720)[0]!.rx).toBe(140);
    // A small picture still gets a one-pixel line.
    expect(ringStrokes(rings, 288, 512)[0]!.lineWidth).toBe(1);
    const still = ringStrokes(rings, 720, 1280, true);
    expect(still.map((s) => s.rotation)).toEqual([0, 0, 0]);
    expect(still.map((s) => s.color)).toEqual(small.map((s) => s.color));
  });

  it('reads its inputs on the frame clock and draws through the Overlay drawer', () => {
    const state: NodeState = {};
    const drawer = drawerOf(state);
    const signals = { x: [() => 0.25], y: [() => 0.5], angle: [() => 1] };
    // Before any frame, and on the first (no elapsed time yet), nothing shows.
    const blank = target();
    drawer.draw(blank);
    expect(lit(blank)).toBe(0);
    for (let f = 0; f < 30; f++) frame(orbitRings, f / 60, (f + 1) / 60, { state, signals });
    const rings = state.rings as Rings;
    expect([rings.x, rings.y, rings.heading]).toEqual([0.25, 0.5, 1]);
    expect(rings.color).toEqual(LILAC);
    const drawn = target();
    drawer.draw(drawn);
    expect(lit(drawn)).toBeGreaterThan(100);
    // Drawn around x = 0.25: the right half of the picture is untouched.
    for (let y = 0; y < drawn.height; y++) for (let x = drawn.width / 2 + 20; x < drawn.width; x++) expect(drawn.pixels[(y * drawn.width + x) * 4]).toBe(FLUID_BACKGROUND[0]);
    // Drawing changes nothing: a second draw of the same state gives the same pixels.
    const again = target();
    drawer.draw(again);
    expect(again.pixels).toEqual(drawn.pixels);
    expect(drawerOf(state)).toBe(drawer);
  });

  it('turns by whole turns with the turns unit, and follows Active', () => {
    const state: NodeState = {};
    const signals = { angle: [() => 0.25], active: [(t: number) => (t < 0.5 ? 1 : 0)] };
    for (let f = 0; f < 20; f++) frame(orbitRings, f / 60, (f + 1) / 60, { state, signals, params: { unit: 'turns' } });
    expect((state.rings as Rings).heading).toBeCloseTo(Math.PI / 2);
    expect((state.rings as Rings).opacity).toBeGreaterThan(0.9);
    for (let f = 20; f < 120; f++) frame(orbitRings, f / 60, (f + 1) / 60, { state, signals, params: { unit: 'turns' } });
    expect((state.rings as Rings).opacity).toBe(0);
  });

  it('takes its color from the Color value, else the palette slot', () => {
    const colorFrom = (value: unknown, params = {}) => {
      const state: NodeState = {};
      const values = value === undefined ? undefined : { color: () => value };
      for (let f = 0; f < 3; f++) frame(orbitRings, f / 60, (f + 1) / 60, { state, values, params });
      return (state.rings as Rings).color;
    };
    expect(colorFrom(undefined)).toEqual(LILAC);
    expect(colorFrom(undefined, { palette: 'tide', dye: 'dye 2' })).toEqual(hexRGB('#62d9dc'));
    expect(colorFrom('#ff0000')).toEqual([1, 0, 0]);
    expect(colorFrom([0.5, 2, -1])).toEqual([0.5, 1, 0]);
    // Anything unusable falls back to the palette.
    for (const bad of ['red', '#12345', [1, 2], [NaN, 0, 0], null, 7, {}]) expect(colorFrom(bad), JSON.stringify(bad)).toEqual(LILAC);
    expect(colorOf('#B7A0FF')).toEqual(LILAC);
  });

  it('keeps the rings level when the host asks for reduced motion', () => {
    const run = (reducedMotion: boolean) => {
      const state: NodeState = {};
      const services: HostServices = { reducedMotion: () => reducedMotion };
      for (let f = 0; f < 30; f++) frame(orbitRings, f / 60, (f + 1) / 60, { state, services, signals: { angle: [() => 2] } });
      const t = target();
      drawerOf(state, services).draw(t);
      return t.pixels;
    };
    const moving = run(false), still = run(true);
    expect(still).not.toEqual(moving);
    // Level rings are symmetric top to bottom about the center row.
    const t = { width: 320, height: 180 };
    const row = (y: number) => still.slice(y * t.width * 4, (y + 1) * t.width * 4);
    expect(row(60)).toEqual(row(119));
  });

  it('gives defined rings for hostile inputs', () => {
    const state: NodeState = {};
    const signals = { x: [() => NaN], y: [() => Infinity], angle: [() => -Infinity], active: [() => NaN] };
    frame(orbitRings, 0, 1 / 60, { state, signals, params: { radius: 9, strength: -2, unit: 'degrees', palette: 'nope', dye: 'puce' } });
    frame(orbitRings, 1 / 60, 2 / 60, { state, signals: { ...signals, active: [() => 1] }, params: { radius: 9, strength: NaN } });
    frame(orbitRings, NaN, NaN, { state, signals: { ...signals, active: [() => 1] } });
    const rings = state.rings as Rings;
    for (const v of [rings.opacity, rings.heading, rings.x, rings.y, rings.orbit, ...rings.color]) expect(Number.isFinite(v)).toBe(true);
    const t = target(16, 9);
    drawerOf(state).draw(t);
    for (const v of t.pixels) expect(v >= 0 && v <= 255).toBe(true);
  });

  it('shows over the fluid in a running patch, cabled into the Renderer', () => {
    const node = (id: string, type: string) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params: {}, position: { x: 0, y: 0 } });
    const cable = (from: string, fromPort: string, to: string, toPort: string) => ({ from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
    const patch: Patch = {
      format: 'flowpatch', version: 1, seed: 2,
      nodes: [node('c', 'clock'), node('o', 'orbit-rings'), node('f', 'fluid'), node('r', 'renderer')],
      cables: [cable('c', 'phase', 'o', 'angle'), cable('o', 'overlay', 'r', 'overlays'), cable('f', 'field', 'r', 'field')],
    };
    const compiled = compilePatch(patch, nodeRegistry);
    expect(compiled.ok ? [] : compiled.errors).toEqual([]);
    if (!compiled.ok) return;
    const rt = new Runtime(compiled.plan, { services: { fluid: createInProcessFluid() } });
    rt.query(0, 1);
    for (let f = 0; f < 30; f++) rt.frame(f / 60, (f + 1) / 60, 1 / 60);
    const image = rendererImage(rt.stateOf('r') ?? {})!;
    expect([image.width, image.height]).toEqual([512, 288]);
    const center = (144 * 512 + 256) * 4;
    // The middle of the rings is the dark still fluid; somewhere on them it's lilac.
    expect(image.pixels[center + 2]).toBeLessThan(40);
    let brightest = 0;
    for (let k = 0; k < image.pixels.length; k += 4) brightest = Math.max(brightest, image.pixels[k + 2]!);
    expect(brightest).toBeGreaterThan(100);
  });
});
