// A drag edits the document as one undo step: previews at most once a frame, nothing for a click,
// a cancel puts it back, and an edit from elsewhere mid-drag ends it unrecorded.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Patch, PatchEdit } from '@flow-patcher/engine';
import { DRAG_THRESHOLD, startDrag, type DragEdit } from '../src/drag-edit';
import { keyedValue } from '../src/param-format';
import { createEditorStore } from '../src/store';

const doc = (): Patch => ({
  format: 'flowpatch',
  version: 1,
  seed: 1,
  nodes: [{ id: 'n', type: 'euclidean', typeVersion: 1, params: { hits: 5 }, position: { x: 0, y: 0 } }],
  cables: [],
});

let frames: (() => void)[] = [];
const runFrame = () => frames.splice(0).forEach((f) => f());

beforeEach(() => {
  frames = [];
  const g = globalThis as Record<string, unknown>;
  g.window = new EventTarget();
  g.requestAnimationFrame = (f: () => void) => frames.push(f);
  g.cancelAnimationFrame = (id: number) => void (frames[id - 1] = () => {});
});
afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.requestAnimationFrame;
  delete g.cancelAnimationFrame;
});

const pointer = (type: string, clientX: number, pointerId = 1) => Object.assign(new Event(type), { clientX, pointerId, shiftKey: false });
const fire = (type: string, clientX: number, pointerId = 1) => window.dispatchEvent(pointer(type, clientX, pointerId));

function setup() {
  const store = createEditorStore(doc());
  const previews: PatchEdit[][] = [];
  const preview = store.getState().preview;
  store.setState({ preview: (edits) => (previews.push(edits), preview(edits)) });
  let ended = 0;
  const drag: DragEdit = {
    from: 5,
    valueAt: (dx) => 5 + Math.round(dx / 10),
    edits: (v) => [{ op: 'set-param', node: 'n', param: 'hits', value: v }],
    onEnd: () => void ended++,
  };
  startDrag(store, { pointerId: 1, clientX: 100 }, drag);
  const hits = () => store.getState().doc.nodes[0]?.params.hits;
  return { store, previews, hits, ended: () => ended };
}

describe('startDrag', () => {
  it('previews at most once a frame, and records the drag as one undo step', () => {
    const { store, previews, hits, ended } = setup();
    for (let x = 101; x <= 150; x++) fire('pointermove', x);
    expect(previews).toHaveLength(0);
    runFrame();
    expect(previews).toHaveLength(1);
    expect(hits()).toBe(10);
    fire('pointermove', 160);
    fire('pointerup', 160);
    expect(hits()).toBe(11);
    expect(store.getState().past).toHaveLength(1);
    expect(ended()).toBe(1);
    store.getState().undo();
    expect(hits()).toBe(5);
  });

  it('ignores other pointers, and records nothing for a press that moves less than the threshold', () => {
    const { store, previews, hits } = setup();
    fire('pointermove', 300, 2);
    fire('pointermove', 100 + DRAG_THRESHOLD - 1);
    runFrame();
    fire('pointerup', 100 + DRAG_THRESHOLD - 1);
    expect(previews).toHaveLength(0);
    expect(hits()).toBe(5);
    expect(store.getState().past).toHaveLength(0);
  });

  it('records nothing for a drag that comes back to where it started', () => {
    const { store, hits } = setup();
    fire('pointermove', 150);
    runFrame();
    fire('pointerup', 100);
    expect(hits()).toBe(5);
    expect(store.getState().past).toHaveLength(0);
  });

  it('puts the value back on pointercancel, whatever its coordinates', () => {
    const { store, hits, ended } = setup();
    fire('pointermove', 150);
    runFrame();
    fire('pointercancel', 0);
    expect(hits()).toBe(5);
    expect(store.getState().past).toHaveLength(0);
    expect(ended()).toBe(1);
  });

  it('ends unrecorded when the document changes under it, and keeps no listeners', () => {
    const { store, previews, ended } = setup();
    fire('pointermove', 150);
    runFrame();
    store.getState().apply([{ op: 'remove-node', node: 'n' }]);
    expect(ended()).toBe(1);
    fire('pointermove', 200);
    runFrame();
    fire('pointerup', 200);
    expect(previews).toHaveLength(1);
    expect(store.getState().past).toHaveLength(1);
  });
});

describe('undo during a drag', () => {
  it('waits for the drag, so a preview is never left out of history', () => {
    const store = createEditorStore(doc());
    store.getState().apply([{ op: 'set-param', node: 'n', param: 'steps', value: 12 }]);
    const hits = () => store.getState().doc.nodes[0]?.params.hits;
    startDrag(store, { pointerId: 1, clientX: 100 }, { from: 5, valueAt: (dx) => 5 + Math.round(dx / 10), edits: (v) => [{ op: 'set-param', node: 'n', param: 'hits', value: v }] });
    expect(store.getState().dragging).toBe(true);
    fire('pointermove', 150);
    runFrame();
    store.getState().undo();
    expect(hits()).toBe(10);
    expect(store.getState().doc.nodes[0]?.params.steps).toBe(12);
    fire('pointerup', 150);
    expect(store.getState().dragging).toBe(false);
    expect(store.getState().past).toHaveLength(2);
    store.getState().undo();
    expect(hits()).toBe(5);
  });
});

describe('keyedValue', () => {
  it('steps with arrows, finer with Shift, ten times with Page keys, to the ends with Home and End', () => {
    expect(keyedValue('ArrowRight', false, 5, 0, 32, 1)).toBe(6);
    expect(keyedValue('ArrowDown', false, 0, 0, 32, 1)).toBe(0);
    expect(keyedValue('PageUp', false, 5, 0, 32, 1)).toBe(15);
    expect(keyedValue('ArrowUp', false, 0.5, 0, 1)).toBe(0.51);
    expect(keyedValue('ArrowUp', true, 0.5, 0, 1)).toBe(0.501);
    expect(keyedValue('Home', false, 5, -3, 32)).toBe(-3);
    expect(keyedValue('End', false, 5, -3, 32)).toBe(32);
    expect(keyedValue('a', false, 5, 0, 32)).toBeUndefined();
  });
});
