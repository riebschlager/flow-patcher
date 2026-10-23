// How number params read in fields and depth chips, and how typed numbers are read back.
import type { NumberParamSpec } from '@flow-patcher/engine';

/** A number as its field shows it: the step's decimals, or enough for the range, with the unit. */
export function formatParam(spec: NumberParamSpec, value: number): string {
  const range = spec.max - spec.min;
  const decimals = spec.step !== undefined ? Math.max(0, -Math.floor(Math.log10(spec.step) + 1e-9)) : range <= 2 ? 3 : range <= 20 ? 2 : range <= 200 ? 1 : 0;
  const text = value.toFixed(decimals).replace('-', '−');
  return spec.unit ? `${text} ${spec.unit}` : text;
}

/** Reads a typed number: a leading number, any unit after it ignored, a typographic minus allowed. */
export function parseTyped(text: string): number {
  return Number.parseFloat(text.trim().replace('−', '-'));
}
