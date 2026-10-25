import { expect, test } from '@playwright/test';
import { IMMEDIATE_OFFSET } from '../packages/engine/src/scheduler';
import type { LivePatch } from '../packages/editor/src/live';
import { burstProbeReady, installBurstProbe } from './audio-burst';
import { audioCallback, stepLog } from './audio-clock';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
  }
}

// Gate check Immediate path (docs/milestones.md, M1): a scripted pointerdown
// produces a note at currentTime + 5 ms ± 2 ms, without waiting for a wake.
test('a tap on the preview canvas plays a note on the immediate path', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

  await installBurstProbe(page);
  await page.goto('/?patch=pointer-notes');
  await expect(page.getByTestId('compile-status')).toHaveText('4 nodes compiled');
  const canvas = page.getByTestId('performance-canvas');
  await expect(page.getByTestId('audio-state')).toHaveText('tap to start');

  // Hovering before the first tap: those moves must not pile up behind the stopped AudioContext.
  const box = (await canvas.boundingBox())!;
  for (let i = 0; i < 400; i++) await page.mouse.move(box.x + 10 + (i % 200), box.y + 10 + (i % 7) * 10);

  // The first tap starts audio, and still sounds once it has.
  // The probe must be in the graph before the tap resumes the context, so it sees the resume's bursts.
  await burstProbeReady(page);
  await canvas.click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  await expect.poll(() => page.evaluate(() => window.flowPatcher!.taps[0]?.note ?? null)).not.toBeNull();

  // Warm taps, spread over different wake phases.
  for (let i = 0; i < 10; i++) {
    await canvas.click({ position: { x: 40 + i * 20, y: 80 } });
    await page.waitForTimeout(37);
  }
  const taps = await page.evaluate(() => window.flowPatcher!.taps.filter((tap) => !tap.cold));
  const steps = await audioCallback(page);
  const { step } = steps;
  // #97: why a warm tap's note sometimes lands past ±2 ms on CI. Logged before the checks, so a failing run has it.
  const baseLatency = await page.evaluate(() => window.flowPatcher!.clock.baseLatency);
  const msOf = (s: number | null) => (s === null ? 'null' : (s * 1000).toFixed(2));
  console.log(`[tap timing] baseLatency ${msOf(baseLatency)} ms, one step ${msOf(step)} ms: ${stepLog(steps)}`);
  for (const tap of taps) {
    // From the push's own clock read (stamp less the offset): past the offset at start(), the note is late.
    // That holds while no push falls back to the horizon (pushFallbacks is checked to be 0 below).
    const read = tap.stamped! - IMMEDIATE_OFFSET;
    // Clock readings from the push's read: just before the first start(), just after it, and at the push's end.
    // A note past ±2 ms with a jump of about one callback between the read and start() is ADR 0027's mechanism;
    // lateness with the clock still at the read through start() points elsewhere (main-thread stall).
    const since = (s: number | null) => msOf(s === null ? null : s - read);
    console.log(`[tap timing] clock moved ${msOf(read - tap.at)} before the push's read, ${since(tap.startClock)} just before start(), ${since(tap.startClockAfter)} just after it, ${msOf(tap.after - read)} by the push's end; ` +
      `note−stamp ${msOf(tap.note === null ? null : tap.note - tap.stamped!)}; largest step so far ${msOf(tap.largestStep)}; push ${tap.pushMs.toFixed(1)} ms (0.1 ms resolution)`);
  }
  expect(taps).toHaveLength(10);
  for (const tap of taps) {
    // push reads currentTime again after the handler did, and an audio callback can land between the
    // two reads. The +5 ms is the lower bound here; the gate's ±2 ms is then measured from push's read.
    expect(tap.stamped! - tap.at).toBeGreaterThanOrEqual(0.005 - 1e-6);
    expect(tap.stamped! - tap.at).toBeLessThanOrEqual(0.005 + steps.callback + 1e-6);
    expect(tap.note).not.toBeNull();
    expect(Math.abs(tap.note! - tap.stamped!)).toBeLessThanOrEqual(0.002);
  }
  const stats = await page.evaluate(() => window.flowPatcher!.stats);
  expect(stats.pushes).toBeGreaterThanOrEqual(11);
  // ADR 0026: a visible push always rewinds, so none fell back to the horizon.
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  expect(stats.pushFallbacks).toBe(0);

  await page.screenshot({ path: 'test-results/pointer.png' });
  expect(errors).toEqual([]);
});

// Pointer complete (#74): hover moves, pointerenter and pointerleave reach Pointer, All carries
// every down, move, up and cancel with its phase, and a hover's leave (#101), and channels are slots, freed on leave.
test('hover, enter and leave reach Pointer, and All tags every event with its phase on a slot', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

  await page.goto('/?patch=pointer-notes');
  await expect(page.getByTestId('compile-status')).toHaveText('4 nodes compiled');
  const canvas = page.getByTestId('performance-canvas');
  await canvas.click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  expect(await page.evaluate(() => [...window.flowPatcher!.inputTypes].sort())).toEqual(
    ['pointercancel', 'pointerdown', 'pointerenter', 'pointerleave', 'pointermove', 'pointerup'],
  );
  await page.evaluate(() => {
    (window as unknown as { unwatchAll: () => void }).unwatchAll = window.flowPatcher!.watchProbe('pointer', 'all', 'out', 'event', () => {});
  });
  const slots = () => page.evaluate(() => ((window.flowPatcher!.stateOf('pointer')?.contacts ?? []) as { slot: number; id: number | null }[]).map((c) => [c.slot, c.id]));

  // Out of the canvas: the mouse's leave frees its slot.
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x - 30, box.y + box.height / 2);
  await expect.poll(slots).toEqual([[1, null]]);
  type Seen = { time: number; phase: string; channel: number; buttons: number; shift: boolean; speed: number; age: number; dx: number };
  // The probe shows what has sounded over the last 2 s, so each phase is read as soon as it shows up.
  const seen = () => page.evaluate(() => (window.flowPatcher!.probe('pointer', 'all')?.events ?? []).map((e) => ({
    time: e.time, phase: e.phase, channel: e.channel, buttons: e.buttons, shift: e.shift, speed: e.speed, age: e.age, dx: e.dx,
  }))) as Promise<Seen[]>;
  // The probe may also show the tap that started audio, depending on when it began watching:
  // only what's stamped after the leave counts. (That leave marks nothing on All: the tap's up
  // already freed the mouse's slot, and no hover move took it again.)
  const started = await page.evaluate(() => window.flowPatcher!.clock.currentTime);
  const after = async () => (await seen()).filter((e) => e.time > started);
  const hoverMoves = async () => (await after()).filter((e) => e.phase === 'move' && e.buttons === 0);

  // Back in, hovering: enter and the hover moves take slot 1 again, and reach All as moves with no button.
  for (let i = 0; i <= 8; i++) await page.mouse.move(box.x + 10 + i * 10, box.y + box.height / 2, { steps: 1 });
  await expect.poll(slots).toEqual([[1, 1]]);
  await expect.poll(async () => (await hoverMoves()).length).toBeGreaterThanOrEqual(5);
  const hovers = await hoverMoves();
  for (const e of hovers) expect([e.channel, e.age]).toEqual([1, 0]);
  expect(hovers.some((e) => e.speed > 0 && e.dx > 0)).toBe(true);
  const hovered = Math.max(...hovers.map((e) => e.time));

  // No pauses: a hover move, the press, the drag, the up and the move after it often share render
  // quanta, and Pointer still applies a hover move before a Down at its stamp and after an Up.
  await page.mouse.move(box.x + 95, box.y + box.height / 2);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2 + 10, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.mouse.move(box.x + 125, box.y + 10);
  await page.mouse.move(box.x - 30, box.y + 10);
  await expect.poll(slots).toEqual([[1, null]]);

  // Everything has sounded once the leave after the up's hover shows (it can sit in the lookahead a while).
  await expect.poll(async () => {
    const events = await after();
    const u = events.findIndex((e) => e.phase === 'up');
    return u >= 0 && events.slice(u + 1).some((e) => e.phase === 'leave');
  }).toBe(true);
  const all = await after();
  // The contact's phases and the hover-end marker, all on slot 1; enter has none (ADR 0028, #101).
  expect(new Set(all.map((e) => e.phase))).toEqual(new Set(['move', 'down', 'up', 'leave']));
  // The mouse left while hovering: one leave, its last event.
  expect(all.filter((e) => e.phase === 'leave')).toHaveLength(1);
  expect(all.at(-1)!.phase).toBe('leave');
  expect(all.at(-1)!.buttons).toBe(0);
  expect(new Set(all.map((e) => e.channel))).toEqual(new Set([1]));
  const down = all.findIndex((e) => e.phase === 'down');
  const up = all.findIndex((e) => e.phase === 'up');
  // After the hover, the press with Shift, a drag and the up.
  expect(all[down]!.time).toBeGreaterThanOrEqual(hovered);
  expect(all.slice(0, down).every((e) => e.phase === 'move' && e.buttons === 0)).toBe(true);
  expect(all[down]).toMatchObject({ buttons: 1, shift: true, age: 0 });
  expect(all.slice(down + 1, up).every((e) => e.phase === 'move' && e.buttons === 1)).toBe(true);
  expect(all[up]!.age).toBeGreaterThan(0);
  expect(all[up]!.buttons).toBe(0);
  // After the up, hover again, then the leave.
  expect(all.slice(up + 1, -1).every((e) => e.phase === 'move' && e.buttons === 0)).toBe(true);
  expect(all.length - up - 2).toBeGreaterThanOrEqual(1);

  await page.evaluate(() => (window as unknown as { unwatchAll: () => void }).unwatchAll());
  expect(errors).toEqual([]);
});

// Pointer (high rate) (#74): a move's coalesced samples reach the high-rate node, one push per
// browser event, while Pointer gets the plain move only.
test('coalesced samples reach Pointer (high rate), and only the plain move reaches Pointer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

  const node = (id: string, type: string, typeVersion: number, x: number) => ({ id, type, typeVersion, params: {}, position: { x, y: 100 } });
  const patch = { format: 'flowpatch', version: 1, seed: 74, nodes: [node('p', 'pointer', 2, 0), node('h', 'pointer-high-rate', 1, 260)], cables: [] };
  await page.goto('/?patch=new');
  await page.getByTestId('open-file').setInputFiles({ name: 'pointers.flowpatch', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(patch)) });
  await expect(page.getByTestId('compile-status')).toHaveText('2 nodes compiled');
  const canvas = page.getByTestId('performance-canvas');
  await canvas.click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  expect(await page.evaluate(() => window.flowPatcher!.readsCoalesced)).toBe(true);
  await page.evaluate(() => {
    const live = window.flowPatcher!;
    (window as unknown as { unwatch: (() => void)[] }).unwatch = ['p', 'h'].map((id) => live.watchProbe(id, 'move', 'out', 'event', () => {}));
  });
  const moves = (id: string) => page.evaluate((node) => (window.flowPatcher!.probe(node, 'move')?.events ?? []).map((e) => ({ x: e.x as number, channel: e.channel, coalesced: e.coalesced === true, interval: e.interval as number | undefined, time: e.time })), id);

  // Five moves, each with four coalesced samples, the last of them the move itself. Counted as soon as
  // they show up: the probe keeps only 2 s.
  const pushesBefore = await page.evaluate(() => window.flowPatcher!.stats.pushes);
  for (let f = 0; f < 5; f++) {
    await page.evaluate((frame) => {
      const element = document.querySelector('[data-testid="performance-canvas"]')!;
      const box = element.getBoundingClientRect();
      const at = (i: number) => ({ pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, clientX: box.left + 60 + frame * 20 + i * 5, clientY: box.top + 50 });
      const samples = [0, 1, 2, 3].map((i) => new PointerEvent('pointermove', at(i)));
      element.dispatchEvent(new PointerEvent('pointermove', { ...at(3), coalescedEvents: samples }));
    }, f);
    await page.waitForTimeout(30);
  }
  // One push per browser event.
  expect(await page.evaluate(() => window.flowPatcher!.stats.pushes) - pushesBefore).toBe(5);
  await expect.poll(async () => (await moves('h')).length).toBe(20);
  await expect.poll(async () => (await moves('p')).length).toBe(5);
  const high = await moves('h'), plain = await moves('p');
  expect(high.every((e) => e.coalesced && e.channel === 1)).toBe(true);
  expect(plain.every((e) => !e.coalesced && e.channel === 1)).toBe(true);
  // Every sample after the first carries its interval, from the events' timeStamps.
  expect(high.slice(1).every((e) => e.interval !== undefined && e.interval >= 0)).toBe(true);
  // In order, and each frame's last sample at the plain move's position.
  expect(high.map((e) => e.x)).toEqual([...high.map((e) => e.x)].sort((a, b) => a - b));
  expect(plain.map((e) => e.x)).toEqual(high.filter((_, i) => i % 4 === 3).map((e) => e.x));

  // Real mouse moves: Chromium may or may not coalesce them; either way high rate gets at least Pointer's
  // samples. The probe keeps 2 s, so this phase counts only what's stamped after it starts.
  const started = await page.evaluate(() => window.flowPatcher!.clock.currentTime);
  const since = async (id: string) => (await moves(id)).filter((e) => e.time > started).length;
  const box = (await canvas.boundingBox())!;
  for (let i = 0; i < 20; i++) await page.mouse.move(box.x + 20 + i * 8, box.y + 100);
  await expect.poll(() => since('p')).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  expect(await since('h')).toBeGreaterThanOrEqual(await since('p'));

  await page.evaluate(() => (window as unknown as { unwatch: (() => void)[] }).unwatch.forEach((stop) => stop()));
  // The two cards side by side, clear of the preview pane.
  await page.locator('.react-flow__controls-zoomout').click();
  await page.locator('.react-flow__controls-zoomout').click();
  await page.screenshot({ path: 'test-results/pointer-cards.png' });
  expect(errors).toEqual([]);
});

// Cold drops (#74, Platform rules): before the first tap, hover moves, coalesced samples, enter and
// leave are dropped rather than held, so hovering in and out of a stopped canvas can't pile up pushes
// that replay as a burst of rewinds when audio starts.
test('hovering before the first tap holds no pushes, and inputAll does nothing while audio is stopped', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

  const node = (id: string, type: string, typeVersion: number, x: number) => ({ id, type, typeVersion, params: {}, position: { x, y: 100 } });
  const patch = { format: 'flowpatch', version: 1, seed: 74, nodes: [node('p', 'pointer', 2, 0), node('h', 'pointer-high-rate', 1, 260)], cables: [] };
  await page.goto('/?patch=new');
  await page.getByTestId('open-file').setInputFiles({ name: 'pointers.flowpatch', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(patch)) });
  await expect(page.getByTestId('compile-status')).toHaveText('2 nodes compiled');
  const canvas = page.getByTestId('performance-canvas');
  await expect(page.getByTestId('audio-state')).toHaveText('tap to start');
  const box = (await canvas.boundingBox())!;
  for (let pass = 0; pass < 5; pass++) {
    await page.mouse.move(box.x - 20, box.y + 30);
    for (let i = 0; i < 10; i++) await page.mouse.move(box.x + 10 + i * 15, box.y + 30 + pass * 5);
  }
  await page.mouse.move(box.x - 20, box.y + 30);
  const stats = () => page.evaluate(() => ({ deferred: window.flowPatcher!.stats.deferredPushes, pushes: window.flowPatcher!.stats.pushes }));
  expect(await stats()).toEqual({ deferred: 0, pushes: 0 });
  // The host's batch path while suspended: dropped, not held.
  expect(await page.evaluate(() => window.flowPatcher!.inputAll([
    { type: 'pointermove', channel: 1, x: 0.5, y: 0.5, coalesced: true, interval: 0.004 },
    { type: 'pointermove', channel: 1, x: 0.5, y: 0.5, interval: 0.016 },
  ]))).toBeNull();
  expect(await stats()).toEqual({ deferred: 0, pushes: 0 });
  expect(await page.evaluate(() => window.flowPatcher!.readsCoalesced)).toBe(true);

  // The first tap still starts audio and reaches both nodes, on slot 1.
  await canvas.click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  await expect.poll(() => page.evaluate(() => ['p', 'h'].map((id) => ((window.flowPatcher!.stateOf(id)?.contacts ?? []) as { slot: number }[]).map((c) => c.slot)))).toEqual([[1], [1]]);
  // At most the tap's own Down and Up were held while audio started: no burst of hover pushes behind them.
  expect((await stats()).deferred).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});
