// The offline render helper's suspend() edits.
import { describe, expect, it } from 'vitest';
import { RENDER_QUANTUM, SAMPLE_RATE, SuspendRaceError, renderOffline } from './lib/audio';

describe('renderOffline edits', () => {
  it('runs every edit at its time rounded down to a render quantum, in order', async () => {
    let seen: [string, number][] = [];
    const quantum = RENDER_QUANTUM / SAMPLE_RATE;
    const times = [0.5, 0.0251, 0.0252, 0.3, 0.9];
    // setup runs once per try, so a try that loses a suspend starts with a clean record.
    await renderOffline(1, () => void (seen = []), { attempts: 3, edits: times.map((time, i) => ({ time, apply: (context) => void seen.push([`e${i}`, context.currentTime]) })) });
    // 0.0251 and 0.0252 share a quantum and run in the order given.
    expect(seen.map(([name]) => name)).toEqual(['e1', 'e2', 'e3', 'e0', 'e4']);
    for (const [name, at] of seen) {
      const time = times[Number(name.slice(1))]!;
      expect(at).toBeCloseTo(Math.floor(time / quantum + 1e-9) * quantum, 9);
    }
  });

  it('renders again on a fresh context when a suspend does not take', async () => {
    const tries: number[] = [];
    let contexts = 0, ran = 0;
    const setup = () => {
      contexts++;
      ran = 0;
    };
    const edits = [0.1, 0.2, 0.3].map((time) => ({ time, apply: () => void ran++ }));
    const lose = (attempt: number) => attempt === 1;
    await renderOffline(0.5, setup, { edits, attempts: 3, onAttempt: (n) => tries.push(n), testLateSuspend: lose });
    // At least 2 tries: a natural race on try 2 can add another.
    expect(tries[0]).toBe(1);
    expect(tries.length).toBeGreaterThanOrEqual(2);
    expect(contexts).toBe(tries.length);
    expect(ran).toBe(3);
    await expect(renderOffline(0.5, setup, { edits, testLateSuspend: lose })).rejects.toThrow(SuspendRaceError);
  });

  it('fails the render when an edit throws', async () => {
    const edits = [{ time: 0.1, apply: () => { throw new Error('edit broke'); } }];
    await expect(renderOffline(0.2, () => {}, { edits })).rejects.toThrow('edit broke');
  });

  it('renders again when a suspend does not take and a later edit throws because of it', async () => {
    // A later edit that depends on an earlier one (#93): it throws only on the try that loses a suspend.
    let attempt = 0;
    const tries: number[] = [];
    const edits = [{ time: 0.1, apply: () => { if (attempt === 1) throw new Error('no node "prob2"'); } }];
    await renderOffline(0.5, () => {}, { edits, attempts: 3, onAttempt: (n) => tries.push((attempt = n)), testLateSuspend: (n) => n === 1 });
    expect(tries.length).toBeGreaterThanOrEqual(2);
    // With no retries left, the race is what's reported, not the edit error it caused.
    await expect(renderOffline(0.5, () => {}, { edits, onAttempt: (n) => void (attempt = n), testLateSuspend: () => true })).rejects.toThrow(SuspendRaceError);
  });

  it('refuses edits outside the render', async () => {
    await expect(renderOffline(0.2, () => {}, { edits: [{ time: 0.2, apply: () => {} }] })).rejects.toThrow(RangeError);
  });
});
