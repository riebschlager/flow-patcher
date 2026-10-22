import { describe, expect, it } from 'vitest';
import { createNodeContext, CUSTOM_PRESET, isModulatable, presetFor, resolveParam, resolveParams, type NodeDefinition, type TextParamSpec } from '../src';

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
