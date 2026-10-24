// Recognizers chained through Pass (ADR 0028): priority is wiring.
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@flow-patcher/engine';
import { drag, pinch } from '../src';
import { ev, merge, run } from './recognizers';

describe('recognizers chained through Pass', () => {
  it('Pinch → Drag: the pinch takes both fingers, Drag keeps what it had, and the end of the chain sees one cancel per contact', () => {
    // Finger 1 strokes (a drag), then finger 2 lands and the two close in.
    const events: EngineEvent[] = merge(
      [ev(0, 1, 'down', 0.2, 0.5), ev(0.1, 1, 'move', 0.25, 0.5), ev(0.2, 1, 'move', 0.3, 0.5)],
      [ev(0.3, 2, 'down', 0.8, 0.5)],
      [0.4, 0.5, 0.6].flatMap((t, i) => [ev(t, 1, 'move', 0.3 + (i + 1) * 0.04, 0.5), ev(t, 2, 'move', 0.8 - (i + 1) * 0.04, 0.5)]),
      [ev(0.7, 1, 'up', 0.42, 0.5), ev(0.7, 2, 'up', 0.68, 0.5)],
    );
    const first = run(pinch, events);
    expect(first.pinchIn).toHaveLength(1);
    const claimAt = first.pinchIn![0]!.time;
    const second = run(drag, first.pass!);
    // Drag claimed finger 1 at its first move; finger 2 never got far enough before the pinch took it.
    expect(second.start?.map((e) => `${e.time} ${e.channel}`)).toEqual(['0.1 1']);
    // Pinch's cancel ends finger 1's drag without End.
    expect(second.end).toBeUndefined();
    const pass = second.pass ?? [];
    for (const channel of [1, 2]) {
      const mine = pass.filter((e) => e.channel === channel);
      expect(mine.filter((e) => e.phase === 'cancel'), `channel ${channel}`).toHaveLength(1);
      expect(mine.at(-1)!.phase).toBe('cancel');
    }
    expect(pass.filter((e) => e.channel === 1).at(-1)!.time).toBe(0.1);
    expect(pass.filter((e) => e.channel === 2).at(-1)!.time).toBe(claimAt);
  });
});
