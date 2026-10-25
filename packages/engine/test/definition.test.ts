import { describe, expect, it } from 'vitest';
import { compilePatch, createNodeContext, CUSTOM_PRESET, depthRange, depthUnit, isLogParam, isModulatable, knobPosition, knobValue, modulate, paramSpecError, presetFor, resolveParam, resolveParams, type NodeDefinition, type NumberParamSpec, type TextParamSpec } from '../src';

const chord: TextParamSpec = {
  name: 'chords', kind: 'text', default: 'C G Am F',
  presets: { 'Pop': 'C G Am F', 'Blues': 'C7 F7 C7 G7' },
  check: (text) => (text.trim() ? null : 'Enter at least one chord'),
};

describe('text params', () => {
  it('keep any string and fall back to the default otherwise', () => {
    expect(resolveParam(chord, 'Dm7 G7')).toBe('Dm7 G7');
    expect(resolveParam(chord, '')).toBe('');
    expect(resolveParam(chord, 4)).toBe('C G Am F');
    expect(resolveParam(chord, undefined)).toBe('C G Am F');
  });

  it('derive the preset menu from the text: a hand edit reads as Custom', () => {
    expect(presetFor(chord, 'C7 F7 C7 G7')).toBe('Blues');
    expect(presetFor(chord, chord.default)).toBe('Pop');
    expect(presetFor(chord, 'C7 F7 C7 G7 ')).toBe(CUSTOM_PRESET);
    expect(presetFor({ ...chord, presets: undefined }, 'C')).toBe(CUSTOM_PRESET);
  });

  it('report unusable text through check without rejecting it', () => {
    expect(chord.check!('  ')).toBe('Enter at least one chord');
    expect(chord.check!('C')).toBeNull();
  });
});

describe('modulatable params', () => {
  it('are number params unless they opt out', () => {
    expect(isModulatable({ name: 'a', kind: 'number', min: 0, max: 1, default: 0 })).toBe(true);
    expect(isModulatable({ name: 'a', kind: 'number', min: 0, max: 1, default: 0, modulatable: false })).toBe(false);
    expect(isModulatable(chord)).toBe(false);
    expect(isModulatable(undefined)).toBe(false);
  });
});

describe('node context', () => {
  const definition: NodeDefinition = {
    type: 't', version: 1, label: 'T', category: 'control-logic', description: '',
    ports: [{ name: 'in', type: 'event', direction: 'in' }],
    params: [
      { name: 'n', kind: 'number', min: 0, max: 1, default: 0.2 },
      { name: 'fixed', kind: 'number', min: 0, max: 1, default: 0.5, modulatable: false },
      chord,
    ],
  };
  // n's base (0.5) differs from its default (0.2), so a fallback to the default would show.
  const make = (mods = {}) => createNodeContext({ nodeId: 't', seed: 1, definition, params: resolveParams(definition, { n: 0.5 }), state: {} }, { events: ['in'], mods });

  it('reads NaN for a param that is not a number', () => {
    expect(make().param('chords', 0)).toBeNaN();
    expect(make().param('missing', 0)).toBeNaN();
  });

  it('falls back to the base value when the modulated sum overflows', () => {
    const huge = { n: [{ depth: 1e308, signal: () => 1e308 }] };
    expect(make(huge).param('n', 0)).toBe(0.5);
    const twoBig = { n: [{ depth: 1, signal: () => 1.5e308 }, { depth: 1, signal: () => 1.5e308 }] };
    expect(make(twoBig).param('n', 0)).toBe(0.5);
  });

  it('ignores cables into a param that opted out', () => {
    expect(make({ fixed: [{ depth: 1, signal: () => 0.3 }] }).param('fixed', 0)).toBe(0.5);
  });

  it('knows which ports and params are connected', () => {
    const ctx = make({ n: [{ depth: 1, signal: () => 0 }] });
    expect(['in', 'n', 'fixed', 'chords'].filter((p) => ctx.connected(p))).toEqual(['in', 'n']);
  });
});

describe('log-scaled params (ADR 0032)', () => {
  const cutoff: NumberParamSpec = { name: 'cutoff', kind: 'number', min: 20, max: 20000, default: 1200, unit: 'Hz', scale: 'log' };
  const linear: NumberParamSpec = { name: 'level', kind: 'number', min: -1, max: 3, default: 1 };
  const stepped: NumberParamSpec = { name: 'size', kind: 'number', min: 1, max: 1024, default: 64, step: 1, scale: 'log' };

  it('map knob position to value by ratio: equal travel, equal octaves', () => {
    expect(knobValue(cutoff, 0)).toBe(20);
    expect(knobValue(cutoff, 1)).toBe(20000);
    // 20 Hz to 20 kHz is a factor of 1000: a third of the way is ×10.
    expect(knobValue(cutoff, 1 / 3)).toBeCloseTo(200, 9);
    expect(knobValue(cutoff, 0.5)).toBeCloseTo(20 * Math.sqrt(1000), 9);
    expect(knobPosition(cutoff, 2000)).toBeCloseTo(2 / 3, 12);
    expect(knobPosition(cutoff, 20)).toBe(0);
    expect(knobPosition(cutoff, 20000)).toBe(1);
    // Every octave is the same travel.
    const octave = knobPosition(cutoff, 800) - knobPosition(cutoff, 400);
    expect(knobPosition(cutoff, 10000) - knobPosition(cutoff, 5000)).toBeCloseTo(octave, 12);
    expect(octave).toBeCloseTo(1 / Math.log2(1000), 12);
  });

  it('map a linear param by difference, as the knob always did', () => {
    expect(knobPosition(linear, 0)).toBe(0.25);
    expect(knobValue(linear, 0.75)).toBe(2);
    expect(knobValue(linear, 0)).toBe(-1);
    expect(knobValue(linear, 1)).toBe(3);
  });

  it('round-trip position ⇄ value', () => {
    for (const spec of [cutoff, linear, stepped]) {
      for (let i = 0; i <= 1000; i++) {
        const p = i / 1000, v = knobValue(spec, p);
        expect(v).toBeGreaterThanOrEqual(spec.min);
        expect(v).toBeLessThanOrEqual(spec.max);
        expect(knobPosition(spec, v)).toBeCloseTo(p, 12);
      }
      for (const v of [spec.min, spec.default, spec.max, (spec.min + spec.max) / 2]) expect(knobValue(spec, knobPosition(spec, v))).toBeCloseTo(v, 9);
    }
  });

  it('clamp out-of-range positions and values to the ends, and read NaN as the default', () => {
    expect(knobValue(cutoff, -0.5)).toBe(20);
    expect(knobValue(cutoff, 7)).toBe(20000);
    expect(knobValue(cutoff, -Infinity)).toBe(20);
    expect(knobValue(cutoff, Infinity)).toBe(20000);
    expect(knobValue(cutoff, NaN)).toBe(1200);
    expect(knobPosition(cutoff, 5)).toBe(0);
    expect(knobPosition(cutoff, 0)).toBe(0);
    expect(knobPosition(cutoff, -300)).toBe(0);
    expect(knobPosition(cutoff, 1e9)).toBe(1);
    expect(knobPosition(cutoff, Infinity)).toBe(1);
    expect(knobPosition(cutoff, NaN)).toBeCloseTo(knobPosition(cutoff, 1200), 12);
    expect(knobPosition(linear, NaN)).toBe(0.5);
  });

  it('modulate in octaves on a log param and in the unit on a linear one', () => {
    expect(modulate(cutoff, 1000, 1)).toBe(2000);
    expect(modulate(cutoff, 1000, -2)).toBe(250);
    expect(modulate(cutoff, 1000, 0)).toBe(1000);
    expect(modulate(cutoff, 1000, 5)).toBe(20000);
    expect(modulate(cutoff, 1000, -10)).toBe(20);
    // A power that overflows or underflows clamps; a non-finite offset keeps the base.
    expect(modulate(cutoff, 1000, 1e6)).toBe(20000);
    expect(modulate(cutoff, 1000, -1e6)).toBe(20);
    expect(modulate(cutoff, 1000, Infinity)).toBe(1000);
    expect(modulate(cutoff, 1000, NaN)).toBe(1000);
    expect(modulate(linear, 1, 1.5)).toBe(2.5);
    expect(modulate(linear, 1, 9)).toBe(3);
    expect(modulate(linear, 1, NaN)).toBe(1);
    // A stepped log param rounds after scaling.
    expect(modulate(stepped, 10, 0.5)).toBe(14);
  });

  it('give the depth control its reach and unit: octaves on a log param', () => {
    expect(depthRange(cutoff)).toBeCloseTo(Math.log2(1000), 12);
    expect(depthUnit(cutoff)).toBe('oct');
    expect(depthRange(linear)).toBe(4);
    expect(depthUnit(linear)).toBeUndefined();
    expect(depthUnit({ ...linear, unit: 'dB' })).toBe('dB');
    expect(isLogParam(cutoff)).toBe(true);
    expect(isLogParam(linear)).toBe(false);
    expect(isLogParam(undefined)).toBe(false);
  });

  it('need 0 < min < max, and the compiler rejects a node whose definition breaks it', () => {
    expect(paramSpecError(cutoff)).toBeNull();
    expect(paramSpecError(linear)).toBeNull();
    expect(paramSpecError({ ...linear, min: 0, scale: 'linear' })).toBeNull();
    for (const bad of [{ ...cutoff, min: 0 }, { ...cutoff, min: -20 }, { ...cutoff, min: NaN }, { ...cutoff, max: 20 }, { ...cutoff, max: Infinity }]) {
      expect(paramSpecError(bad), `${bad.min}–${bad.max}`).toMatch(/0 < min < max/);
    }
    const broken: NodeDefinition = {
      type: 'b', version: 1, label: 'Broken', category: 'effects-mix', description: '', ports: [],
      params: [{ ...cutoff, min: 0 }], signal: () => 0,
    };
    const result = compilePatch({ format: 'flowpatch', version: 1, seed: 1, nodes: [{ id: 'n', type: 'b', typeVersion: 1, params: {}, position: { x: 0, y: 0 } }], cables: [] }, new Map([['b', broken]]));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toEqual(['node "n": param "cutoff" of Broken: a log-scaled param needs 0 < min < max (has 0–20000)']);
  });

  it('store and read in the param\'s unit: resolving a log param is the same clamp as a linear one', () => {
    expect(resolveParam(cutoff, 440)).toBe(440);
    expect(resolveParam(cutoff, 5)).toBe(20);
    expect(resolveParam(cutoff, NaN)).toBe(1200);
    const definition: NodeDefinition = { type: 'f', version: 1, label: 'F', category: 'effects-mix', description: '', ports: [], params: [cutoff], signal: () => 0 };
    const ctx = createNodeContext({ nodeId: 'f', seed: 1, definition, params: resolveParams(definition, { cutoff: 300 }), state: {} }, {
      mods: { cutoff: [{ depth: 3, signal: (t) => t }, { depth: 1, signal: () => NaN }] },
    });
    expect(ctx.param('cutoff', 0)).toBe(300);
    expect(ctx.param('cutoff', 1)).toBe(2400);
    expect(ctx.param('cutoff', 1 / 3)).toBe(600);
  });
});
