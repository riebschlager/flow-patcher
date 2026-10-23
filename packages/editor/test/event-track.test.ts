// What a probe or a cable flash sees of an Event output: every event as it sounds, even ones the runtime
// stopped retaining between two frames.
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@flow-patcher/engine';
import { EventTrack, PROBE_HISTORY, type EventSource } from '../src/event-track';

/** A runtime stand-in: one output's events, retained from `retainedFrom` on. */
function source() {
  const events: EngineEvent[] = [];
  const s = {
    retainedFrom: null as number | null,
    eventsAt: (_node: string, _port: string, t0: number, t1: number) => events.filter((e) => e.time >= t0 && e.time < t1 && (s.retainedFrom === null || e.time >= s.retainedFrom)),
    add: (time: number) => events.push({ time, channel: 0 }),
    replaceFrom: (t: number, times: number[]) => {
      events.splice(0, events.length, ...events.filter((e) => e.time < t), ...times.map((time) => ({ time, channel: 0 })));
    },
  };
  return s;
}
const times = (events: readonly EngineEvent[]) => events.map((e) => e.time);

describe('EventTrack', () => {
  it('hands over each event once, in the frame it sounds', () => {
    const rt = source();
    [0.1, 0.2, 0.3].forEach(rt.add);
    const track = new EventTrack('n', 'out', 0);
    track.update(rt as EventSource, 0.15);
    expect(times(track.sounded)).toEqual([0.1]);
    track.update(rt as EventSource, 0.15);
    expect(track.sounded).toEqual([]);
    track.update(rt as EventSource, 0.3);
    expect(times(track.sounded)).toEqual([0.2, 0.3]);
    expect(times(track.history)).toEqual([0.1, 0.2, 0.3]);
  });

  it('keeps what the runtime stopped retaining since it last read ahead', () => {
    const rt = source();
    rt.add(0.12);
    const track = new EventTrack('n', 'out', 0.1);
    track.update(rt as EventSource, 0.11);
    // A wake retains from 0.125 on (currentTime runs ahead of what's heard) before the next frame.
    rt.retainedFrom = 0.125;
    track.update(rt as EventSource, 0.13);
    expect(times(track.sounded)).toEqual([0.12]);
  });

  it('keeps a live event pushed and pruned between two frames, once refreshed after the push', () => {
    const rt = source();
    const track = new EventTrack('n', 'out', 0.1);
    track.update(rt as EventSource, 0.11);
    rt.add(0.118); // the push: currentTime + 5 ms
    track.refresh(rt as EventSource);
    rt.retainedFrom = 0.125; // the next wake, before the next frame
    track.update(rt as EventSource, 0.127);
    expect(times(track.sounded)).toEqual([0.118]);
    // Without the refresh it would be lost.
    const missed = new EventTrack('n', 'out', 0.1);
    const late = source();
    missed.update(late as EventSource, 0.11);
    late.add(0.118);
    late.retainedFrom = 0.125;
    missed.update(late as EventSource, 0.127);
    expect(missed.sounded).toEqual([]);
  });

  it('shows what a rewind put in place of the events it replaced', () => {
    const rt = source();
    [0.2, 0.3].forEach(rt.add);
    const track = new EventTrack('n', 'out', 0);
    track.update(rt as EventSource, 0.1);
    rt.replaceFrom(0.15, [0.25]);
    track.refresh(rt as EventSource);
    track.update(rt as EventSource, 0.35);
    expect(times(track.sounded)).toEqual([0.25]);
  });

  it('keeps PROBE_HISTORY seconds of history', () => {
    const rt = source();
    [0.5, 1, 2.5, 3].forEach(rt.add);
    const track = new EventTrack('n', 'out', 0);
    track.update(rt as EventSource, 3);
    expect(times(track.history)).toEqual([1, 2.5, 3].filter((t) => t > 3 - PROBE_HISTORY));
  });
});
