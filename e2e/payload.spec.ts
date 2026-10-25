import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { EngineEvent } from '@flow-patcher/engine';
import { nodeRegistry } from '@flow-patcher/nodes';
import type { LivePatch } from '../packages/editor/src/live';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
    /** Every event a watched output showed, by "node.port", kept past the probe's history. */
    payloadSeen?: Record<string, EngineEvent[]>;
  }
}

// M2 gate, Payload: synthetic mouse, touch, pen, wheel and key input on the canvas; every source node
// emits every documented field, with x and y in 0–1 and y = 0 at the top. The pointer fields come from
// the payload table in docs/nodes/canvas-sources.md, so a field added to the table needs a rule here; the
// Click, Wheel, Key and Pen lists below are written out from their paragraphs. Covered elsewhere: Touch extras'
// Gesture (Safari only; touch.spec), Canvas's events (canvas.spec), MIDI (midi.spec), hover enter and leave
// (pointer.spec, pen.spec) and field values (pen.spec, touch.spec).

/** The payload table's field names, in the doc's order. */
function documentedFields(): string[] {
  const doc = readFileSync(new URL('../docs/nodes/canvas-sources.md', import.meta.url), 'utf8');
  const table = doc.slice(doc.indexOf('| Field | Meaning |'));
  const rows = table.slice(0, table.indexOf('\n\n')).split('\n').slice(2);
  return rows.flatMap((row) => [...row.split('|')[1]!.matchAll(/`([a-zA-Z]+)`/g)].map((m) => m[1]!));
}

/** When each documented field is on a pointer source's event. */
const POINTER_RULES: Record<string, 'always' | 'after first' | 'samples only'> = {
  time: 'always', channel: 'always', x: 'always', y: 'always', dx: 'always', dy: 'always', speed: 'always', angle: 'always',
  pressure: 'always', width: 'always', height: 'always', pointerType: 'always', button: 'always', buttons: 'always',
  shift: 'always', alt: 'always', ctrl: 'always', meta: 'always', age: 'always',
  // Only on Pointer (high rate)'s moves (getCoalescedEvents() samples).
  coalesced: 'samples only',
  // Left out on a pointer's first sample, and its first since each up, cancel or leave.
  interval: 'after first',
};
const PEN_FIELDS = ['tiltX', 'tiltY', 'twist', 'tangentialPressure', 'altitudeAngle', 'azimuthAngle', 'barrel'];
const MODIFIERS = ['shift', 'alt', 'ctrl', 'meta'];

const SOURCES = ['pointer', 'pointer-high-rate', 'pen', 'touch-extras', 'click', 'wheel', 'key', 'canvas'] as const;

/** A patch with one of every canvas source, side by side, and nothing else. */
function sourcesPatch() {
  return {
    format: 'flowpatch', version: 1, seed: 84,
    nodes: SOURCES.map((type, i) => ({ id: type, type, typeVersion: nodeRegistry.get(type)!.version, params: {}, position: { x: i * 260, y: 0 } })),
    cables: [],
  };
}

/** Watches every Event output of every source, keeping each event once. */
async function follow(page: Page) {
  const outputs = SOURCES.flatMap((type) => nodeRegistry.get(type)!.ports.filter((p) => p.direction === 'out' && p.type === 'event').map((p) => [type, p.name] as const));
  await page.evaluate((list) => {
    const seen: Record<string, EngineEvent[]> = (window.payloadSeen = {});
    for (const [node, port] of list) {
      const key = `${node}.${port}`;
      seen[key] = [];
      window.flowPatcher!.watchProbe(node, port, 'out', 'event', () => {
        for (const event of window.flowPatcher!.probe(node, port)?.events ?? []) {
          if (!seen[key]!.some((e) => e.time === event.time && e.channel === event.channel && e.phase === event.phase && e.x === event.x)) seen[key]!.push({ ...event });
        }
      });
    }
  }, outputs);
}
const seen = (page: Page) => page.evaluate(() => window.payloadSeen!);

/** Dispatches a synthetic pointer event on the canvas at (fx, fy) of its box. */
type Init = { fx: number; fy: number } & Record<string, number | string | boolean>;
const dispatch = (page: Page, type: string, init: Init) =>
  page.evaluate(([t, { fx, fy, ...rest }]) => {
    const element = document.querySelector('[data-testid="performance-canvas"]')!;
    const r = element.getBoundingClientRect();
    // pointerId 1 is the mouse's, the one pointer Chromium always has active, so the canvas can capture it.
    element.dispatchEvent(new PointerEvent(t as string, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, ...(rest as PointerEventInit) }));
  }, [type, init] as const);

/** Waits until the audio clock is 10 ms past where it is now, so what comes next lands on a later stamp
 *  than anything sent before (stamps are the clock + 5 ms), however the runner schedules the audio thread. */
async function nextStamp(page: Page) {
  const now = await page.evaluate(() => window.flowPatcher!.clock.currentTime);
  await expect.poll(() => page.evaluate(() => window.flowPatcher!.clock.currentTime), { intervals: [5] }).toBeGreaterThan(now + 0.01);
}
const signal = (page: Page, node: string, port: string) => page.evaluate(([n, p]) => window.flowPatcher!.probe(n!, p!)?.value as number | undefined, [node, port]);
const has = (e: EngineEvent, field: string) => e[field] !== undefined;

test('Payload: mouse, touch, pen, wheel and key input give every documented field, x and y in 0–1 with y = 0 at the top', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?patch=new');
  await page.getByTestId('open-file').setInputFiles({ name: 'sources.flowpatch', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(sourcesPatch())) });
  await expect(page.getByTestId('compile-status')).toHaveText(`${SOURCES.length} nodes compiled`);
  const canvas = page.getByTestId('performance-canvas');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  await follow(page);
  await page.evaluate(() => {
    const live = window.flowPatcher!;
    for (const [node, port] of [['touch-extras', 'width'], ['touch-extras', 'height'], ['canvas', 'width'], ['canvas', 'height'], ['canvas', 'aspect']]) live.watchProbe(node!, port!, 'out', 'signal', () => {});
  });

  // Mouse: a press on the top row of pixels, dragged with Shift held to the bottom row.
  await page.mouse.move(box.x + box.width * 0.3, box.y + 0.5);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(box.x + box.width * (0.3 + i * 0.02), box.y + 0.5 + (box.height - 1) * (i / 10));
    await page.waitForTimeout(20);
  }
  await page.keyboard.up('Shift');
  await page.mouse.up();
  // Each contact here is pointerId 1, so keep one's end and the next one's down on different stamps (#122).
  await nextStamp(page);

  // Touch, with a contact size; then a second touch that's cancelled.
  const touch = { pointerType: 'touch', width: 20, height: 24 };
  await dispatch(page, 'pointerdown', { fx: 0.2, fy: 0.5, ...touch, pressure: 0.4, button: 0, buttons: 1 });
  for (let i = 1; i <= 5; i++) {
    await dispatch(page, 'pointermove', { fx: 0.2 + i * 0.02, fy: 0.5, ...touch, pressure: 0.4, buttons: 1 });
    await page.waitForTimeout(20);
  }
  await expect.poll(() => signal(page, 'touch-extras', 'width')).toBe(20);
  expect(await signal(page, 'touch-extras', 'height')).toBe(24);
  await dispatch(page, 'pointerup', { fx: 0.3, fy: 0.5, ...touch, pressure: 0, button: 0, buttons: 0 });
  await nextStamp(page);
  await dispatch(page, 'pointerdown', { fx: 0.4, fy: 0.6, ...touch, pressure: 0.4, button: 0, buttons: 1 });
  await page.waitForTimeout(20);
  await dispatch(page, 'pointermove', { fx: 0.42, fy: 0.6, ...touch, pressure: 0.4, buttons: 1 });
  await page.waitForTimeout(20);
  await dispatch(page, 'pointercancel', { fx: 0.42, fy: 0.6, ...touch, pressure: 0, buttons: 0 });
  await nextStamp(page);

  // Pen, tilted and twisted.
  const pen = { pointerType: 'pen', tiltX: 20, tiltY: -10, twist: 30, tangentialPressure: 0.2 };
  await dispatch(page, 'pointerdown', { fx: 0.6, fy: 0.4, ...pen, pressure: 0.7, button: 0, buttons: 1 });
  for (let i = 1; i <= 5; i++) {
    await dispatch(page, 'pointermove', { fx: 0.6 + i * 0.02, fy: 0.4, ...pen, pressure: 0.7, buttons: 1 });
    await page.waitForTimeout(20);
  }
  await dispatch(page, 'pointerup', { fx: 0.7, fy: 0.4, ...pen, pressure: 0, button: 0, buttons: 0 });

  // The pointer checks below cover what came before here: the clicks after it press and release on one
  // stamp, which is Click's to check. The pen's up is stamped 5 ms ahead of the clock, so wait past it.
  await nextStamp(page);
  const pointersEnd = await page.evaluate(() => window.flowPatcher!.clock.currentTime);

  // Wheel, plain and with Ctrl (a trackpad pinch).
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.25);
  await page.mouse.wheel(30, 100);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -50);
  await page.keyboard.up('Control');

  // Keys, one with Shift.
  await page.keyboard.press('KeyA');
  await page.keyboard.press('Shift+KeyB');

  // Clicks: a double click, a right click and a middle click.
  await page.mouse.dblclick(box.x + box.width * 0.4, box.y + box.height * 0.6);
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.6, { button: 'right' });
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.6, { button: 'middle' });
  await expect.poll(async () => (await seen(page))['click.middle']!.length).toBe(1);
  const all = await seen(page);

  // Every field the doc lists has a rule, and every rule a documented field.
  const documented = documentedFields();
  expect(documented.sort()).toEqual(Object.keys(POINTER_RULES).sort());

  // Pointer sources: every documented field, on the events its rule says.
  for (const source of ['pointer', 'pointer-high-rate', 'pen']) {
    const events = all[`${source}.all`]!.filter((e) => e.time < pointersEnd);
    expect(events.length, source).toBeGreaterThan(0);
    // `interval` is left out on a pointer's first sample, and its first since each up, cancel or leave. Inside
    // a contact (after its down, up to its up or cancel) every sample has one; the downs are checked exactly
    // below. Every synthetic pointer here is pointerId 1, as is the mouse, so contacts are told apart by type
    // and never overlap.
    const downs = events.filter((e) => e.phase === 'down');
    const inContact = (e: EngineEvent) => (e.phase === 'move' || e.phase === 'up' || e.phase === 'cancel') && downs.some((d) =>
      d.pointerType === e.pointerType && d.time < e.time && !events.some((u) => u.pointerType === e.pointerType && (u.phase === 'up' || u.phase === 'cancel') && u.time >= d.time && u.time < e.time));
    const first = (e: EngineEvent) => !inContact(e);
    expect(events.filter((e) => has(e, 'interval')).length, `${source}: most samples carry interval`).toBeGreaterThan(events.length / 2);
    for (const e of events) {
      for (const [field, rule] of Object.entries(POINTER_RULES)) {
        const sample = source === 'pointer-high-rate' && e.phase === 'move';
        if (rule === 'after first' && first(e)) continue;
        const expected = rule === 'always' || rule === 'after first' || (rule === 'samples only' && sample);
        expect(has(e, field), `${source} ${e.phase} ${e.pointerType} at ${e.time.toFixed(4)}: ${field}`).toBe(expected);
      }
      expect(e.x, `${source} x`).toBeGreaterThanOrEqual(0);
      expect(e.x, `${source} x`).toBeLessThanOrEqual(1);
      expect(e.y, `${source} y`).toBeGreaterThanOrEqual(0);
      expect(e.y, `${source} y`).toBeLessThanOrEqual(1);
      // Pen fields on pens' events only; Pen completes them, with the barrel. Chromium (the CI browser) has
      // altitudeAngle and azimuthAngle, which the host passes on where the browser has them.
      for (const field of PEN_FIELDS) {
        const onPen = e.pointerType === 'pen' && (source === 'pen' || field !== 'barrel');
        expect(has(e, field), `${source} ${e.pointerType}: ${field}`).toBe(onPen);
      }
    }
  }
  // `interval` on the downs, exactly. The mouse's press follows its hover move, so it has one; each touch's
  // and the pen's down follow the previous pointer's up or cancel on pointerId 1, so they don't.
  for (const source of ['pointer', 'pointer-high-rate', 'pen']) {
    const downs = all[`${source}.all`]!.filter((e) => e.phase === 'down' && e.time < pointersEnd);
    for (const d of downs) expect(has(d, 'interval'), `${source} ${d.pointerType} down: interval`).toBe(d.pointerType === 'mouse');
    // Every contact's end was checked: an up per pointer type, and the touch's cancel.
    const ends = all[`${source}.all`]!.filter((e) => e.time < pointersEnd && (e.phase === 'up' || e.phase === 'cancel')).map((e) => `${e.pointerType} ${e.phase}`);
    const expected = source === 'pen' ? ['pen up'] : ['mouse up', 'touch up', 'touch cancel', 'pen up'];
    expect(ends, source).toEqual(expect.arrayContaining(expected));
  }
  // Each kind of pointer reached Pointer, and only pens reached Pen.
  expect(new Set(all['pointer.all']!.map((e) => e.pointerType))).toEqual(new Set(['mouse', 'touch', 'pen']));
  expect(new Set(all['pen.all']!.map((e) => e.pointerType))).toEqual(new Set(['pen']));
  // y = 0 at the top: the press on the top row of pixels, the release on the bottom row.
  const mouse = all['pointer.all']!.filter((e) => e.pointerType === 'mouse');
  const press = mouse.find((e) => e.phase === 'down' && (e.y as number) < 0.5)!;
  expect(press.y).toBeLessThan(0.01);
  expect(mouse.find((e) => e.phase === 'up' && e.time > press.time)!.y).toBeGreaterThan(0.99);
  // Modifiers are held state: Shift on the moves made while it was down.
  expect(mouse.some((e) => e.phase === 'move' && e.shift === true)).toBe(true);
  expect(press.shift).toBe(false);

  // Click: position, pointer type, buttons and modifiers on every output.
  for (const port of ['click', 'double', 'right', 'middle']) {
    const events = all[`click.${port}`]!;
    expect(events.length, `click.${port}`).toBeGreaterThan(0);
    for (const e of events) {
      for (const field of ['time', 'channel', 'x', 'y', 'pointerType', 'button', 'buttons', ...MODIFIERS]) expect(has(e, field), `click.${port}: ${field}`).toBe(true);
      for (const v of [e.x, e.y] as number[]) expect(v >= 0 && v <= 1, `click.${port} x, y in 0–1`).toBe(true);
    }
  }
  expect(all['click.right']![0]!.button).toBe(2);
  expect(all['click.middle']![0]!.button).toBe(1);

  // Wheel: position, deltas and modifiers; Ctrl's goes to Zoom with `zoom`, positive zooming in.
  for (const port of ['deltaX', 'deltaY', 'zoom']) {
    const [e] = all[`wheel.${port}`]!;
    expect(e, `wheel.${port}`).toBeDefined();
    for (const field of ['time', 'channel', 'x', 'y', 'deltaX', 'deltaY', ...MODIFIERS]) expect(has(e!, field), `wheel.${port}: ${field}`).toBe(true);
    for (const v of [e!.x, e!.y] as number[]) expect(v >= 0 && v <= 1, `wheel.${port} x, y in 0–1`).toBe(true);
    expect(e!.x).toBeCloseTo(0.75, 1);
    expect(e!.y).toBeCloseTo(0.25, 1);
  }
  expect(all['wheel.zoom']![0]!.zoom).toBeGreaterThan(0);
  expect(all['wheel.zoom']![0]!.ctrl).toBe(true);

  // Key: key, code, repeat, modifiers and age, with All tagging the phase.
  for (const port of ['down', 'up', 'all']) {
    expect(all[`key.${port}`]!.length, `key.${port}`).toBeGreaterThan(0);
    for (const e of all[`key.${port}`]!) for (const field of ['time', 'channel', 'key', 'code', 'repeat', 'age', ...MODIFIERS]) expect(has(e, field), `key.${port}: ${field}`).toBe(true);
  }
  expect(new Set(all['key.all']!.map((e) => e.phase))).toEqual(new Set(['down', 'up']));
  // A key's channel is fixed by its code: KeyA 1, KeyB 2.
  expect(all['key.down']!.find((e) => e.code === 'KeyA')!.channel).toBe(1);
  expect(all['key.down']!.find((e) => e.code === 'KeyB')!.channel).toBe(2);
  expect(all['key.down']!.map((e) => e.code)).toEqual(expect.arrayContaining(['KeyA', 'KeyB']));
  expect(all['key.down']!.find((e) => e.code === 'KeyB')!.shift).toBe(true);

  // Canvas: its size in CSS pixels and the aspect.
  expect(await signal(page, 'canvas', 'width')).toBeCloseTo(box.width, 0);
  expect(await signal(page, 'canvas', 'height')).toBeCloseTo(box.height, 0);
  expect(await signal(page, 'canvas', 'aspect')).toBeCloseTo(box.width / box.height, 2);

  expect(errors).toEqual([]);
});
