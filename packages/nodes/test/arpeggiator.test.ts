// Flow's checks/arp-envelope.test.mjs and checks/portamento.test.mjs, the parts
// that test arpEnvelope, arpGlide and normalizeArp. Their ArpEngine halves
// (live edits, pitch history across replans) belong to the Arpeggio node.
import { describe, expect, it } from 'vitest';
import { arpEnvelope, arpGlide, normalizeArpShape } from '../src/arpeggiator';

describe('normalizeArpShape', () => {
  it('fills Flow defaults and keeps given fields', () => {
    const migrated = normalizeArpShape({ voice: 'newage', count: 12, beats: 0.25 });
    expect([migrated.length, migrated.attack, migrated.decay, migrated.sustain]).toEqual([85, 20, 120, 65]);
    const legacy = normalizeArpShape({ length: 200 });
    expect([legacy.glideEnabled, legacy.glideTime, legacy.glideAmount, legacy.length, legacy.release]).toEqual([false, 180, 100, 200, null]);
  });

  it('clamps out-of-range values and replaces unusable ones', () => {
    const invalid = normalizeArpShape({ length: 999, attack: -3, decay: 'bad', sustain: 200, release: -1 });
    expect([invalid.length, invalid.attack, invalid.decay, invalid.sustain, invalid.release]).toEqual([400, 0, 120, 100, 0]);
    const glide = normalizeArpShape({ glideEnabled: 'true', glideTime: 9000, glideAmount: -4 });
    expect([glide.glideEnabled, glide.glideTime, glide.glideAmount]).toEqual([false, 2000, 0]);
    expect(normalizeArpShape(null)).toEqual(normalizeArpShape({}));
    expect(normalizeArpShape('weird')).toEqual(normalizeArpShape({}));
  });
});

describe('arpEnvelope', () => {
  it('stays in range, sums to its duration and runs from silence through sustain to silence, for every combination', () => {
    let cases = 0;
    for (const bpm of [30, 56, 100]) for (const rate of [0.5, 1, 2]) for (const beats of [4, 2, 1, 0.5, 0.25, 0.125, 1 / 3])
      for (const length of [10, 85, 200, 400]) for (const attack of [0, 20, 500, 2000]) for (const decay of [0, 120, 500, 2000]) for (const sustain of [0, 65, 100])
        for (const release of [null, 0, 300, 8000]) {
          const shape = arpEnvelope({ length, attack, decay, sustain, release }, (60 / bpm / rate) * beats);
          const sum = shape.envelope.reduce((n, stage) => n + stage.duration, 0);
          const gate = shape.duration - (release === null ? 0 : shape.release);
          if (!(gate >= 0.02 - 1e-9 && gate <= 8 + 1e-9)) throw new Error(`gate ${gate}`);
          if (Math.abs(sum - shape.duration) >= 1e-9) throw new Error(`sum ${sum} vs ${shape.duration}`);
          if (!shape.envelope.every((s) => Number.isFinite(s.duration) && s.duration >= 0 && s.volume >= 0 && s.volume <= 1)) throw new Error('bad stage');
          if (shape.envelope[0]!.volume !== 0 || shape.envelope.at(-1)!.volume !== 0) throw new Error('endpoints');
          if (shape.envelope[2]!.volume !== sustain / 100 || shape.envelope[3]!.volume !== sustain / 100) throw new Error('sustain');
          cases++;
        }
    expect(cases).toBe(3 * 3 * 7 * 4 * 4 * 4 * 3 * 4);
  });

  it('fits attack and decay into a short note', () => {
    const fitted = arpEnvelope({ length: 100, attack: 2000, decay: 2000 }, 0.2);
    expect(fitted.fitted).toBe(true);
    expect(fitted.attack).toBeCloseTo(0.08, 9);
    expect(fitted.decay).toBeCloseTo(0.08, 9);
    expect(arpEnvelope({ length: 400 }, 0.5).duration).toBe(2);
  });

  it('puts an explicit release after the gate', () => {
    const shape = arpEnvelope({ length: 100, attack: 10, decay: 90, sustain: 50, release: 400 }, 0.5);
    expect(shape.release).toBeCloseTo(0.4, 9);
    expect(shape.duration).toBeCloseTo(0.9, 9);
    expect(shape.hold).toBeCloseTo(0.4, 9);
    expect(shape.fitted).toBe(false);
    // A zero release still ramps down, over Flow's 12 ms minimum.
    expect(arpEnvelope({ release: 0 }, 0.5).release).toBe(0.012);
  });

  it('treats a non-numeric step as Flow does, as half a second', () => {
    expect(arpEnvelope({ length: 100 }, Number.NaN).duration).toBe(0.5);
  });
});

describe('arpGlide', () => {
  it('fits its time before the release and is on only with time and amount', () => {
    for (const step of [0.0375, 0.125, 0.5, 2]) for (const length of [10, 85, 400]) for (const glideTime of [0, 180, 2000]) for (const glideAmount of [0, 40, 100]) {
      const glide = arpGlide({ glideEnabled: true, length, glideTime, glideAmount }, step);
      expect(glide.time).toBeGreaterThanOrEqual(0);
      expect(glide.time).toBeLessThan(Math.max(0.02, Math.min(8, (step * length) / 100)));
      expect(glide.enabled).toBe(glideTime > 0 && glideAmount > 0);
      expect(glide.amount).toBe(glideAmount / 100);
    }
  });

  it('is off unless enabled, and reports a shortened time', () => {
    expect(arpGlide({ glideTime: 180 }, 0.5).enabled).toBe(false);
    const short = arpGlide({ glideEnabled: true, glideTime: 2000, length: 100 }, 0.5);
    expect(short.fitted).toBe(true);
    expect(short.time).toBeCloseTo(0.5 - 0.1, 9);
    // With an explicit release the whole gate is available.
    expect(arpGlide({ glideEnabled: true, glideTime: 2000, length: 100, release: 300 }, 0.5).time).toBeCloseTo(0.5, 9);
  });
});
