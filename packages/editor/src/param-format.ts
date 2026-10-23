// How number params read in fields and depth chips, and how typed numbers are read back.
import type { NumberParamSpec } from '@flow-patcher/engine';
import { snapTo } from './drag-edit';

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

/** A slider's value after a key: arrows step (Shift finer when the param has no step), Page keys step ten times,
 *  Home and End go to the ends.
 *  Undefined for any other key. */
export function keyedValue(key: string, shift: boolean, value: number, min: number, max: number, step?: number): number | undefined {
  const range = max - min;
  const unit = step ?? (shift ? range / 1000 : range / 100);
  const by: Record<string, number> = { ArrowUp: unit, ArrowRight: unit, ArrowDown: -unit, ArrowLeft: -unit, PageUp: unit * 10, PageDown: -unit * 10 };
  if (key === 'Home') return min;
  if (key === 'End') return max;
  return key in by ? snapTo(value + by[key]!, min, max, step) : undefined;
}
