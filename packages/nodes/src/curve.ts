import type { NodeDefinition } from '@flow-patcher/engine';

export const CURVE_SHAPES = ['power', 'exponential', 's-curve'] as const;
export type CurveShape = (typeof CURVE_SHAPES)[number];

/** Knob range for Amount. 1 is a straight line for every shape. */
export const CURVE_AMOUNT_MIN = 0.01;
export const CURVE_AMOUNT_MAX = 100;

/**
 * Shapes x, clamped to 0–1, into 0–1. Every shape keeps 0 at 0 and 1 at 1, is
 * monotonic, and is the identity at amount 1:
 * - power: x^amount. Above 1 it starts slow (ease in), below 1 it starts fast.
 * - exponential: (amount^x − 1) / (amount − 1). Followed by a Map Range onto
 *   [lo, hi] with amount = hi / lo, this is lo · (hi / lo)^x: equal steps in x
 *   give equal ratios, the right response for cutoff in Hz.
 * - s-curve: power mirrored about the middle. Above 1 it eases in and out,
 *   below 1 it rushes from both ends and lingers in the middle.
 * Non-finite x or amount, or an amount that isn't positive, gives 0.
 */
export function shape(curve: CurveShape, x: number, amount: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(amount) || amount <= 0) return 0;
  const u = Math.max(0, Math.min(1, x));
  let v: number;
  switch (curve) {
    case 'power': v = u ** amount; break;
    // Near 1 the formula is 0 / 0; the limit is a straight line.
    case 'exponential': v = Math.abs(amount - 1) < 1e-9 ? u : (amount ** u - 1) / (amount - 1); break;
    case 's-curve': v = u < 0.5 ? 0.5 * (2 * u) ** amount : 1 - 0.5 * (2 - 2 * u) ** amount; break;
  }
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/**
 * A 0–1 response curve, per channel: In, read on each channel and clamped to
 * 0–1, bent by Shape and Amount into 0–1. Amount 1 is a straight line for
 * every shape, so the defaults pass a 0–1 Signal through. Typical use:
 * pressure → velocity through a power curve, or pointer y → cutoff through an
 * exponential one, with Map Range after it for the output range (Map Range is
 * linear and leaves the shaping here). Several cables into In are summed, an
 * unconnected In is 0, and Amount is a knob, so a cable can bend the curve.
 *
 * Stateless, so it has no query(): Out is a pure function of its inputs at t,
 * answered in signal(), and can't depend on windowing.
 */
export const curve: NodeDefinition = {
  type: 'curve',
  version: 1,
  label: 'Curve',
  category: 'control-logic',
  description: 'Bends a 0–1 Signal per channel through a power, exponential or S-shaped response curve.',
  ports: [
    { name: 'in', type: 'signal', direction: 'in', label: 'In' },
    { name: 'out', type: 'signal', direction: 'out', label: 'Out' },
  ],
  params: [
    { name: 'shape', kind: 'enum', options: CURVE_SHAPES, default: 'power', label: 'Shape' },
    { name: 'amount', kind: 'number', min: CURVE_AMOUNT_MIN, max: CURVE_AMOUNT_MAX, default: 1, label: 'Amount' },
  ],
  signal({ params, signal, param }, port, t, channel) {
    if (port !== 'out' || !Number.isFinite(t)) return 0;
    const s = (CURVE_SHAPES as readonly string[]).includes(params.shape as string) ? (params.shape as CurveShape) : 'power';
    return shape(s, signal('in', t, channel), param('amount', t, channel));
  },
};
