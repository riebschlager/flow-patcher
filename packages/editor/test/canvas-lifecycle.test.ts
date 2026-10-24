import { describe, expect, it } from 'vitest';
import { compilePatch, inputRouter, ManualClock, Runtime, Scheduler, type InputFields, type Plan } from '@flow-patcher/engine';
import { nodeRegistry } from '@flow-patcher/nodes';
import { CANVAS_TYPES, CanvasLifecycle } from '../src/canvas-lifecycle';
import { droppedWhileCold } from '../src/live';

const node = (id: string, type: string) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params: {}, position: { x: 0, y: 0 } });
function plan(nodes: ReturnType<typeof node>[]): Plan {
  const compiled = compilePatch({ format: 'flowpatch', version: 1, seed: 1, nodes, cables: [] }, nodeRegistry);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return compiled.plan;
}

/** A host that records what it was sent, with audio running or not. */
function recorder(running = false) {
  const sent: InputFields[] = [];
  const state = { running, now: 0 };
  const lifecycle = new CanvasLifecycle({ send: (event) => sent.push(event), running: () => state.running, now: () => state.now }, 'visible');
  return { sent, state, lifecycle };
}

describe('canvas lifecycle', () => {
  it('drops resize, focus, blur and visibilitychange while audio is stopped', () => {
    for (const type of CANVAS_TYPES) expect(droppedWhileCold(type), type).toBe(true);
  });

  it('keeps the state while audio is stopped, and sends what changed when it starts', () => {
    const { sent, state, lifecycle } = recorder();
    lifecycle.resize(300, 200);
    lifecycle.resize(320, 200);
    lifecycle.focus(true);
    lifecycle.focus(false);
    lifecycle.focus(true);
    expect(sent).toEqual([]);
    state.running = true;
    lifecycle.start();
    expect(sent).toEqual([{ type: 'resize', canvasWidth: 320, canvasHeight: 200 }, { type: 'focus' }]);
    // Nothing changed since: an interruption and resume sends nothing again.
    lifecycle.start();
    expect(sent).toHaveLength(2);
    // Blurred during an interruption: a Blur when audio comes back.
    state.running = false;
    lifecycle.focus(false);
    lifecycle.visibility('hidden');
    state.running = true;
    lifecycle.start();
    expect(sent.slice(2)).toEqual([{ type: 'blur' }, { type: 'visibilitychange', visibility: 'hidden' }]);
  });

  it('sends every change while audio runs', () => {
    const { sent, lifecycle } = recorder(true);
    lifecycle.resize(100, 50);
    lifecycle.focus(true);
    lifecycle.visibility('hidden');
    lifecycle.visibility('visible');
    expect(sent.map((e) => e.type)).toEqual(['resize', 'focus', 'visibilitychange', 'visibilitychange']);
  });

  it('starts from the page\'s visibility, so a page loaded hidden sends nothing until it changes', () => {
    const sent: InputFields[] = [];
    const lifecycle = new CanvasLifecycle({ send: (event) => sent.push(event), running: () => true, now: () => 0 }, 'hidden');
    expect(lifecycle.surface.visibility).toBe('hidden');
    lifecycle.start();
    expect(sent).toEqual([]);
  });
});

describe('a Canvas added while audio runs', () => {
  const before = plan([node('clk', 'clock')]);
  const after = plan([node('clk', 'clock'), node('c', 'canvas')]);

  /** Plays `before` to `now`, swaps `after` in, and reads the new Canvas's Width half a second on. `wait`:
   *  hold the size until the swap lands (the host), or push it at once (what lost it, #76 review). */
  function widthAfterSwap(now: number, wait: boolean): number | undefined {
    const clock = new ManualClock();
    const runtime = new Runtime(before);
    const scheduler = new Scheduler(runtime, { clock });
    let current = before;
    const lifecycle = new CanvasLifecycle({
      send: (event) => scheduler.pushAll(inputRouter(current).route(event)),
      running: () => true,
      now: () => clock.audioTime(),
    }, 'visible');
    lifecycle.resize(400, 200);
    for (let k = 0; k <= 40; k++) {
      clock.set(k * 0.025);
      scheduler.wake();
      lifecycle.tick();
    }
    clock.set(now);
    const report = scheduler.swap(after);
    current = after;
    if (wait) lifecycle.adopt(['c'], report.time);
    else scheduler.pushAll(inputRouter(current).route({ type: 'resize', canvasWidth: 400, canvasHeight: 200 }));
    // Frames and wakes, as the host runs them.
    for (let k = 1; k <= 30; k++) {
      clock.set(now + k * 0.016);
      scheduler.wake();
      lifecycle.tick();
    }
    return runtime.signalAt('c', 'width', now + 0.45);
  }

  it('is sent the size once its swap has landed, wherever now falls in the window', () => {
    for (const now of [1.0, 1.003, 1.01, 1.0199, 1.02]) expect(widthAfterSwap(now, true), String(now)).toBe(400);
  });

  it('would lose a size pushed before the swap lands', () => {
    // The case the wait is for: the swap lands at 1.02, after the push's stamp.
    expect(widthAfterSwap(1.0, false)).toBe(0);
  });

  it('is sent the size when audio starts, if it was added while audio was stopped', () => {
    const { sent, state, lifecycle } = recorder();
    lifecycle.resize(640, 480);
    lifecycle.adopt(['c'], -Infinity);
    expect(sent).toEqual([]);
    state.running = true;
    lifecycle.start();
    expect(sent).toEqual([{ type: 'resize', canvasWidth: 640, canvasHeight: 480 }]);
  });

  it('isn\'t sent the size again for a plan whose readers it already has', () => {
    const { sent, lifecycle } = recorder(true);
    lifecycle.resize(640, 480);
    lifecycle.adopt(['c'], -Infinity);
    lifecycle.adopt(['c'], -Infinity);
    expect(sent).toHaveLength(2);
    lifecycle.adopt(['c', 'd'], -Infinity);
    expect(sent).toHaveLength(3);
  });
});
