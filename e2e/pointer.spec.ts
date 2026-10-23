import { expect, test } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';
import { audioCallback } from './audio-clock';

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

  await page.goto('/?patch=pointer-notes');
  await expect(page.getByTestId('compile-status')).toHaveText('4 nodes compiled');
  const canvas = page.getByTestId('performance-canvas');
  await expect(page.getByTestId('audio-state')).toHaveText('tap to start');

  // Hovering before the first tap: those moves must not pile up behind the stopped AudioContext.
  const box = (await canvas.boundingBox())!;
  for (let i = 0; i < 400; i++) await page.mouse.move(box.x + 10 + (i % 200), box.y + 10 + (i % 7) * 10);

  // The first tap starts audio, and still sounds once it has.
  await canvas.click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  await expect.poll(() => page.evaluate(() => window.flowPatcher!.taps[0]?.note ?? null)).not.toBeNull();

  // Warm taps, spread over different wake phases.
  for (let i = 0; i < 10; i++) {
    await canvas.click({ position: { x: 40 + i * 20, y: 80 } });
    await page.waitForTimeout(37);
  }
  const taps = await page.evaluate(() => window.flowPatcher!.taps.filter((tap) => !tap.cold));
  const { callback } = await audioCallback(page);
  expect(taps).toHaveLength(10);
  for (const tap of taps) {
    // push reads currentTime again after the handler did, and an audio callback can land between the
    // two reads. The +5 ms is the lower bound here; the gate's ±2 ms is then measured from push's read.
    expect(tap.stamped! - tap.at).toBeGreaterThanOrEqual(0.005 - 1e-6);
    expect(tap.stamped! - tap.at).toBeLessThanOrEqual(0.005 + callback + 1e-6);
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
// every down, move, up and cancel with its phase, and channels are slots, freed on leave.
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
  // Back in, hovering: enter and the hover moves take slot 1 again.
  for (let i = 0; i <= 8; i++) await page.mouse.move(box.x + 10 + i * 10, box.y + box.height / 2, { steps: 1 });
  await expect.poll(slots).toEqual([[1, 1]]);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2 + 10, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.mouse.move(box.x - 30, box.y + 10);
  await expect.poll(slots).toEqual([[1, null]]);

  type Seen = { phase: string; channel: number; buttons: number; shift: boolean; speed: number; age: number; dx: number };
  const seen = () => page.evaluate(() => (window.flowPatcher!.probe('pointer', 'all')?.events ?? []).map((e) => ({
    phase: e.phase, channel: e.channel, buttons: e.buttons, shift: e.shift, speed: e.speed, age: e.age, dx: e.dx,
  }))) as Promise<Seen[]>;
  // Everything up to the up has sounded once the probe shows it.
  await expect.poll(async () => (await seen()).some((e) => e.phase === 'up')).toBe(true);
  const all = await seen();
  // Only the four phases, all on slot 1: enter and leave have none.
  expect(new Set(all.map((e) => e.phase))).toEqual(new Set(['move', 'down', 'up']));
  expect(new Set(all.map((e) => e.channel))).toEqual(new Set([1]));
  const down = all.findIndex((e) => e.phase === 'down');
  const up = all.findIndex((e) => e.phase === 'up');
  // Hover moves come first, with no button held; then the press, with Shift, a drag and the up.
  const hovers = all.slice(0, down);
  expect(hovers.length).toBeGreaterThanOrEqual(5);
  for (const e of hovers) expect([e.phase, e.buttons, e.age]).toEqual(['move', 0, 0]);
  expect(hovers.some((e) => e.speed > 0 && e.dx > 0)).toBe(true);
  expect(all[down]).toMatchObject({ buttons: 1, shift: true, age: 0 });
  expect(all.slice(down + 1, up).every((e) => e.phase === 'move' && e.buttons === 1)).toBe(true);
  expect(all[up]!.age).toBeGreaterThan(0);
  expect(all[up]!.buttons).toBe(0);

  await page.evaluate(() => (window as unknown as { unwatchAll: () => void }).unwatchAll());
  expect(errors).toEqual([]);
});
