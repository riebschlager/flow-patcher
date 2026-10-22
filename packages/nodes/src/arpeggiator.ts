// Note envelope and glide from Flow's arpeggiator.js (`arpEnvelope`,
// `arpGlide`, and the part of `normalizeArp` they read). Sampled Voice shapes
// every note with them; the Arpeggio node will too. Changes from Flow:
// - `normalizeArpShape` keeps only the envelope and glide fields: length,
//   attack, decay, sustain, glideEnabled, glideTime, glideAmount, plus the new
//   `release`. Their ranges and defaults are Flow's.
// - `release` (ms) is new. Unset, the release is carved out of the note as in
//   Flow (20% of it, 12–250 ms). Set, it follows the note instead: the gate
//   keeps its whole length for attack, decay and hold, and the release adds
//   to `duration`. Sampled Voice sets it, so a short note can ring out.
// - No ArpEngine: scheduling is the engine's job (design.md, Reuse from Flow).

import type { EnvelopeStage } from './music';

/** The envelope and glide settings, as Flow's arp config holds them. */
export interface ArpShape {
  /** Note length, % of the step: 10–400, default 85. */
  length: number;
  /** ms, 0–2000, default 20. */
  attack: number;
  /** ms, 0–2000, default 120. */
  decay: number;
  /** %, 0–100, default 65. */
  sustain: number;
  /** ms after the gate, 0–8000, or null for Flow's release inside the gate. */
  release: number | null;
  glideEnabled: boolean;
  /** ms, 0–2000, default 180. */
  glideTime: number;
  /** % of the interval glided, 0–100, default 100. */
  glideAmount: number;
}

const number = (value: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};

/** Clamps each field to its range; missing or unusable fields get Flow's defaults. */
export function normalizeArpShape(raw: unknown = {}): ArpShape {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    length: number(r.length, 10, 400, 85),
    attack: number(r.attack, 0, 2000, 20),
    decay: number(r.decay, 0, 2000, 120),
    sustain: number(r.sustain, 0, 100, 65),
    release: r.release === null || r.release === undefined ? null : number(r.release, 0, 8000, 300),
    glideEnabled: r.glideEnabled === true,
    glideTime: number(r.glideTime, 0, 2000, 180),
    glideAmount: number(r.glideAmount, 0, 100, 100),
  };
}

export interface ArpEnvelope {
  /** Seconds from the note's start until it is silent: gate plus release. */
  duration: number;
  attack: number;
  decay: number;
  hold: number;
  release: number;
  /** Sustain level, 0–1. */
  sustain: number;
  /** True when attack and decay were shortened to fit the gate. */
  fitted: boolean;
  /** WebAudioFont stages: silence, attack to 1, decay to sustain, hold, release to 0. Durations sum to `duration`. */
  envelope: EnvelopeStage[];
}

/** The envelope of a note that lasts `length`% of a `step`-second step (0.02–8 s). */
export function arpEnvelope(raw: unknown = {}, step = 0.5): ArpEnvelope {
  const cfg = normalizeArpShape(raw);
  const gate = Math.max(0.02, Math.min(8, (Number(step) || 0.5) * cfg.length / 100));
  const release = cfg.release === null ? Math.min(0.25, Math.max(0.012, gate * 0.2)) : Math.max(0.012, cfg.release / 1000);
  const available = cfg.release === null ? gate - release : gate;
  const duration = cfg.release === null ? gate : gate + release;
  let attack = Math.max(0.002, cfg.attack / 1000), decay = Math.max(0.002, cfg.decay / 1000);
  const fit = Math.min(1, available / (attack + decay));
  attack *= fit;
  decay *= fit;
  const hold = Math.max(0, available - attack - decay), sustain = cfg.sustain / 100;
  return {
    duration, attack, decay, hold, release, sustain, fitted: fit < 0.999,
    envelope: [{ duration: 0, volume: 0 }, { duration: attack, volume: 1 }, { duration: decay, volume: sustain }, { duration: hold, volume: sustain }, { duration: release, volume: 0 }],
  };
}

export interface ArpGlide {
  enabled: boolean;
  /** Seconds, fitted to end before the release. */
  time: number;
  /** Share of the interval glided, 0–1. */
  amount: number;
  /** True when the time was shortened to fit. */
  fitted: boolean;
}

/** How a note glides in from the previous pitch: the time fits before its release. */
export function arpGlide(raw: unknown = {}, step = 0.5): ArpGlide {
  const cfg = normalizeArpShape(raw), shape = arpEnvelope(cfg, step), requested = cfg.glideTime / 1000;
  const time = Math.min(requested, shape.duration - shape.release);
  return { enabled: cfg.glideEnabled && time > 0 && cfg.glideAmount > 0, time, amount: cfg.glideAmount / 100, fitted: time < requested - 0.000001 };
}
