import type { NodeDefinition } from '@flow-patcher/engine';

/** Knob range for all four bounds: wide enough for MIDI pitch and filter cutoff in Hz. */
export const MAP_RANGE_LIMIT = 20000;

/**
 * Maps x from [inMin, inMax] onto [outMin, outMax], linearly. Either range may
 * be reversed, which inverts the mapping. With clamp the result stays between
 * outMin and outMax; without it the line extends past both ends. An empty
 * input range (inMin = inMax) gives outMin, and any non-finite input or result
 * gives 0.
 */
export function rescale(x: number, inMin: number, inMax: number, outMin: number, outMax: number, clamp: boolean): number {
  if (![x, inMin, inMax, outMin, outMax].every(Number.isFinite)) return 0;
  const span = inMax - inMin;
  let u = span === 0 ? 0 : (x - inMin) / span;
  if (clamp) u = Math.max(0, Math.min(1, u));
  const v = outMin + u * (outMax - outMin);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Rescales a Signal per channel: In, read on each channel, mapped from the
 * input range onto the output range, optionally clamped to it. The defaults
 * (0–1 onto 0–1, clamped) pass a 0–1 Signal through and keep anything else
 * inside 0–1. Typical use: pointer y or a Clock phase (0–1) onto a pitch or
 * cutoff range. Several cables into In are summed, an unconnected In is 0.
 * Every bound is a knob, so a cable can move the range.
 *
 * Stateless, so it has no query(): Out is a pure function of its inputs at t,
 * answered in signal(), and can't depend on windowing.
 */
export const mapRange: NodeDefinition = {
  type: 'map-range',
  version: 1,
  label: 'Map Range',
  category: 'control-logic',
  description: 'Rescales a Signal per channel from an input range onto an output range, optionally clamped.',
  ports: [
    { name: 'in', type: 'signal', direction: 'in', label: 'In' },
    { name: 'out', type: 'signal', direction: 'out', label: 'Out' },
  ],
  params: [
    { name: 'inMin', kind: 'number', min: -MAP_RANGE_LIMIT, max: MAP_RANGE_LIMIT, default: 0, label: 'In min' },
    { name: 'inMax', kind: 'number', min: -MAP_RANGE_LIMIT, max: MAP_RANGE_LIMIT, default: 1, label: 'In max' },
    { name: 'outMin', kind: 'number', min: -MAP_RANGE_LIMIT, max: MAP_RANGE_LIMIT, default: 0, label: 'Out min' },
    { name: 'outMax', kind: 'number', min: -MAP_RANGE_LIMIT, max: MAP_RANGE_LIMIT, default: 1, label: 'Out max' },
    { name: 'clamp', kind: 'toggle', default: true, label: 'Clamp' },
  ],
  signal({ params, signal, param }, port, t, channel) {
    if (port !== 'out' || !Number.isFinite(t)) return 0;
    const at = (name: string) => param(name, t, channel);
    return rescale(signal('in', t, channel), at('inMin'), at('inMax'), at('outMin'), at('outMax'), params.clamp !== false);
  },
};
