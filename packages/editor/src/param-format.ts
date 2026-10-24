// How number params read in fields and depth chips, and how typed numbers are read back.
// A log-scaled param (ADR 0032) turns by ratio, reads in its unit with a prefix ("1.2 kHz"),
// and its cables' depth reads in octaves.
import { depthRange, isLogParam, knobPosition, knobValue, type NumberParamSpec } from '@flow-patcher/engine';
import { snapTo } from './drag-edit';

/** Significant figures a log-scaled value keeps when dragged, keyed or shown: about 1/700 of the knob, as a linear knob snaps to 1/1000. */
const LOG_FIGURES = 3;
/** A log-scaled param's depth snaps to this many octaves. */
export const OCTAVE_STEP = 0.01;

/** Unit prefixes a log-scaled value reads with: the unit, the larger one and where it starts. */
const PREFIXED: Record<string, { at: number; unit: string; scale: number }[]> = {
  Hz: [{ at: 1000, unit: 'kHz', scale: 1000 }],
  s: [{ at: 1, unit: 's', scale: 1 }, { at: 0, unit: 'ms', scale: 0.001 }],
};

/** A number to `figures` significant figures, without trailing zeros: 1200 → "1200", 1.20 → "1.2". */
function significant(value: number, figures: number): string {
  if (value === 0 || !Number.isFinite(value)) return String(value);
  return Number(value.toPrecision(figures)).toString();
}

/** A number as its field shows it: the step's decimals, or enough for the range, with the unit. A log-scaled
 *  param shows three significant figures, Hz as kHz from 1 kHz and seconds as ms below 1 s. */
export function formatParam(spec: NumberParamSpec, value: number): string {
  if (isLogParam(spec) && spec.step === undefined) {
    const prefix = PREFIXED[spec.unit ?? '']?.find((p) => Math.abs(value) >= p.at);
    const text = significant(prefix ? value / prefix.scale : value, LOG_FIGURES).replace('-', '−');
    const unit = prefix?.unit ?? spec.unit;
    return unit ? `${text} ${unit}` : text;
  }
  const range = spec.max - spec.min;
  const decimals = spec.step !== undefined ? Math.max(0, -Math.floor(Math.log10(spec.step) + 1e-9)) : range <= 2 ? 3 : range <= 20 ? 2 : range <= 200 ? 1 : 0;
  const text = value.toFixed(decimals).replace('-', '−');
  return spec.unit ? `${text} ${spec.unit}` : text;
}

/** A cable's depth into `spec` as its chip shows it, signed: in octaves on a log-scaled param ("+3.17 oct"), else in the param's unit. */
export function formatDepth(spec: NumberParamSpec, depth: number): string {
  const sign = depth >= 0 ? '+' : '';
  if (isLogParam(spec)) return `${sign}${depth.toFixed(2).replace('-', '−')} oct`;
  return `${sign}${formatParam(spec, depth)}`;
}

/** Reads a typed number: a leading number, any unit after it ignored, a typographic minus allowed. */
export function parseTyped(text: string): number {
  return Number.parseFloat(text.trim().replace('−', '-'));
}

/** Reads a number typed into `spec`'s field, in its unit. A prefix the field shows is understood too:
 *  "1.2k" or "1.2 kHz" on a Hz param is 1200, "250 ms" on a seconds param is 0.25. */
export function parseParam(spec: NumberParamSpec, text: string): number {
  const value = parseTyped(text);
  const suffix = text.trim().replace(/^[−+-]?[\d.]+(e[+-]?\d+)?\s*/i, '');
  if (spec.unit === 'Hz' && /^k/i.test(suffix)) return value * 1000;
  if (spec.unit === 's' && /^ms/i.test(suffix)) return value / 1000;
  return value;
}

/** Snaps a value of `spec` as a drag or key leaves it: a linear param to its step or a thousandth of its range,
 *  a log-scaled one to three significant figures (its step, if any, after that). Clamped to the range. */
export function snapParam(spec: NumberParamSpec, value: number): number {
  if (!isLogParam(spec)) return snapTo(value, spec.min, spec.max, spec.step);
  const rounded = Number(significant(value, LOG_FIGURES));
  if (spec.step !== undefined) return snapTo(rounded, spec.min, spec.max, spec.step);
  return Number.isFinite(rounded) ? Math.min(spec.max, Math.max(spec.min, rounded)) : spec.min;
}

/** The value `travel` of the knob's width (−1 to 1) away from `from`: linear in the value, or by ratio on a log-scaled param. */
export function turnBy(spec: NumberParamSpec, from: number, travel: number): number {
  return snapParam(spec, knobValue(spec, knobPosition(spec, from) + travel));
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

/** `keyedValue` for a param's field: on a log-scaled param, the arrows step a hundredth of the knob's travel (Shift a
 *  thousandth), by ratio. */
export function keyedParam(spec: NumberParamSpec, key: string, shift: boolean, value: number): number | undefined {
  if (!isLogParam(spec)) return keyedValue(key, shift, value, spec.min, spec.max, spec.step);
  const unit = shift ? 1 / 1000 : 1 / 100;
  const by: Record<string, number> = { ArrowUp: unit, ArrowRight: unit, ArrowDown: -unit, ArrowLeft: -unit, PageUp: unit * 10, PageDown: -unit * 10 };
  if (key === 'Home') return spec.min;
  if (key === 'End') return spec.max;
  return key in by ? turnBy(spec, value, by[key]!) : undefined;
}

/** How far a depth chip reaches each way, and the step it snaps to: octaves on a log-scaled param. */
export function depthScale(spec: NumberParamSpec): { range: number; step: number | undefined } {
  return { range: depthRange(spec), step: isLogParam(spec) ? OCTAVE_STEP : spec.step };
}
