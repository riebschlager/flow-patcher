import { describe, expect, it } from 'vitest';
import { createSignalTrack, pushSignal, signalAt, signalChannels, trimSignal } from '../src';

describe('signal track', () => {
  it('interpolates linearly between samples', () => {
    const track = createSignalTrack();
    pushSignal(track, 0, 0, 0);
    pushSignal(track, 1 / 60, 0, 1);
    pushSignal(track, 2 / 60, 0, -1);
    expect(signalAt(track, 0.5 / 60)).toBeCloseTo(0.5, 12);
    expect(signalAt(track, 1 / 60)).toBe(1);
    expect(signalAt(track, 1.25 / 60)).toBeCloseTo(0.5, 12);
  });

  it('holds before the first sample and after the last', () => {
    const track = createSignalTrack();
    pushSignal(track, 1, 0, 3);
    pushSignal(track, 2, 0, 5);
    expect(signalAt(track, 0)).toBe(3);
    expect(signalAt(track, -100)).toBe(3);
    expect(signalAt(track, 2)).toBe(5);
    expect(signalAt(track, 1e9)).toBe(5);
  });

  it('keeps channels apart', () => {
    const track = createSignalTrack();
    pushSignal(track, 0, 0, 1);
    pushSignal(track, 0, 3, 10);
    pushSignal(track, 1, 3, 20);
    expect(signalAt(track, 0.5, 0)).toBe(1);
    expect(signalAt(track, 0.5, 3)).toBe(15);
    expect(signalChannels(track)).toEqual([0, 3]);
  });

  it('reads 0 on a channel with no samples', () => {
    expect(signalAt(createSignalTrack(), 1)).toBe(0);
  });

  it('ignores non-finite samples and reads 0 at a non-finite time', () => {
    const track = createSignalTrack();
    pushSignal(track, 0, 0, 1);
    pushSignal(track, 1, 0, NaN);
    pushSignal(track, NaN, 0, 5);
    pushSignal(track, Infinity, 0, 5);
    pushSignal(track, 0, NaN, 5);
    expect(signalAt(track, 2)).toBe(1);
    expect(signalAt(track, NaN)).toBe(0);
    expect(signalChannels(track)).toEqual([0]);
  });

  it('sorts out-of-order samples and replaces a sample at the same time', () => {
    const track = createSignalTrack();
    pushSignal(track, 1, 0, 10);
    pushSignal(track, 0, 0, 0);
    pushSignal(track, 1, 0, 20);
    expect(signalAt(track, 0.5)).toBe(10);
  });

  it('trims old samples without changing later reads', () => {
    const track = createSignalTrack();
    for (let i = 0; i <= 10; i++) pushSignal(track, i, 0, i * i);
    const reads = () => [5, 5.5, 7.25, 10, 11].map((t) => signalAt(track, t));
    const before = reads();
    trimSignal(track, 5.5);
    expect(reads()).toEqual(before);
    expect(signalAt(track, 0)).toBe(25);
  });

  it('is plain data: a structuredClone reads the same and evolves independently', () => {
    const track = createSignalTrack();
    for (let i = 0; i < 20; i++) pushSignal(track, i / 60, i % 3, Math.sin(i));
    const copy = structuredClone(track);
    const times = Array.from({ length: 50 }, (_, i) => i / 140 - 0.05);
    for (const channel of [0, 1, 2, 7]) expect(times.map((t) => signalAt(copy, t, channel))).toEqual(times.map((t) => signalAt(track, t, channel)));
    expect(signalChannels(copy)).toEqual(signalChannels(track));
    pushSignal(copy, 1, 0, 99);
    expect(signalAt(track, 1, 0)).not.toBe(99);
  });
});
