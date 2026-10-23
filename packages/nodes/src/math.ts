import type { NodeDefinition } from '@flow-patcher/engine';

export const MATH_OPS = ['add', 'subtract', 'multiply', 'divide', 'min', 'max', 'modulo'] as const;
export type MathOp = (typeof MATH_OPS)[number];

/** Out for one pair of operands. Division or modulo by 0, and any non-finite result, give 0. */
export function applyOp(op: MathOp, a: number, b: number): number {
  let v: number;
  switch (op) {
    case 'add': v = a + b; break;
    case 'subtract': v = a - b; break;
    case 'multiply': v = a * b; break;
    case 'divide': v = b === 0 ? 0 : a / b; break;
    case 'min': v = Math.min(a, b); break;
    case 'max': v = Math.max(a, b); break;
    // Floored, so the result takes B's sign: a ramp wraps into [0, B) for B > 0.
    case 'modulo': v = b === 0 ? 0 : a - b * Math.floor(a / b); break;
  }
  return Number.isFinite(v) ? v : 0;
}

/**
 * Arithmetic on Signals, per channel: Out = A op (B + Constant), all read at
 * the same time and channel. Several cables into A or B are summed, an
 * unconnected input is 0 and a non-finite cable counts as 0, so with the
 * defaults (Add, Constant 0) Out is A. Constant is a knob, so a lone A can be
 * scaled or offset without a second source.
 *
 * Stateless: Out is a pure function of its inputs at t, so it can't depend on
 * windowing.
 */
export const math: NodeDefinition = {
  type: 'math',
  version: 1,
  label: 'Math',
  category: 'control-logic',
  description: 'Combines two Signals per channel: add, subtract, multiply, divide, min, max or modulo, with a constant added to B.',
  ports: [
    { name: 'a', type: 'signal', direction: 'in', label: 'A' },
    { name: 'b', type: 'signal', direction: 'in', label: 'B' },
    { name: 'out', type: 'signal', direction: 'out', label: 'Out' },
  ],
  params: [
    { name: 'op', kind: 'enum', options: MATH_OPS, default: 'add', label: 'Operation' },
    { name: 'constant', kind: 'number', min: -100, max: 100, default: 0, label: 'Constant' },
  ],
  // Nothing to compute per window: Out is answered in signal(). The empty query
  // puts Math in the plan like any other source, with nothing to snapshot.
  query() {
    return {};
  },
  signal({ params, signal, param }, port, t, channel) {
    if (port !== 'out' || !Number.isFinite(t)) return 0;
    const op = (MATH_OPS as readonly string[]).includes(params.op as string) ? (params.op as MathOp) : 'add';
    return applyOp(op, signal('a', t, channel), signal('b', t, channel) + param('constant', t, channel));
  },
};
