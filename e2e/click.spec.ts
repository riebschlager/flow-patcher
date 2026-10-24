import { expect, test, type Page } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
  }
}

const PORTS = ['click', 'double', 'middle', 'right'] as const;
type Seen = { time: number; channel: number; x: number; y: number; pointerType: string; button: number; buttons: number; shift: boolean; alt: boolean; ctrl: boolean; meta: boolean };

/** What Click's output has sent over the last 2 s (the probe's history), stamped after `since`. */
const seen = (page: Page, port: string, since: number) =>
  page.evaluate(([p, s]) => (window.flowPatcher!.probe('click', p as string)?.events ?? []).filter((e) => e.time > (s as number)).map((e) => ({
    time: e.time, channel: e.channel, x: e.x, y: e.y, pointerType: e.pointerType, button: e.button, buttons: e.buttons, shift: e.shift, alt: e.alt, ctrl: e.ctrl, meta: e.meta,
  })), [port, since] as const) as Promise<Seen[]>;

/** Every documented field (canvas-sources.md, Event payload, the ones a click has), with x and y in 0–1. */
function expectPayload(e: Seen) {
  expect(e.channel).toBe(0);
  for (const axis of [e.x, e.y]) {
    expect(typeof axis).toBe('number');
    expect(axis).toBeGreaterThanOrEqual(0);
    expect(axis).toBeLessThanOrEqual(1);
  }
  expect(typeof e.pointerType).toBe('string');
  expect(Number.isInteger(e.button)).toBe(true);
  expect(Number.isInteger(e.buttons)).toBe(true);
  for (const flag of [e.shift, e.alt, e.ctrl, e.meta]) expect(typeof flag).toBe('boolean');
}

// Click (#75): click, dblclick, auxclick (middle) and contextmenu reach Click's outputs from the
// preview canvas, each browser event pushed once, with position and the base payload fields.
test('clicks on the preview canvas reach Click, Double, Middle and Right with their payload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

  await page.goto('/?patch=click-notes');
  await expect(page.getByTestId('compile-status')).toHaveText('7 nodes compiled');
  // Click plays the canvas, so there's no "No Pointer" hint.
  await expect(page.locator('.preview__hint')).toHaveCount(0);
  const canvas = page.getByTestId('performance-canvas');
  await canvas.click({ position: { x: 20, y: 20 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  expect(await page.evaluate(() => [...window.flowPatcher!.inputTypes].sort())).toEqual(['auxclick', 'click', 'contextmenu', 'dblclick']);
  await page.evaluate((ports) => {
    const live = window.flowPatcher!;
    (window as unknown as { unwatch: (() => void)[] }).unwatch = ports.map((port) => live.watchProbe('click', port, 'out', 'event', () => {}));
  }, [...PORTS]);
  const box = (await canvas.boundingBox())!;
  const since = await page.evaluate(() => window.flowPatcher!.clock.currentTime);
  const pushes = () => page.evaluate(() => window.flowPatcher!.stats.pushes);

  // A click at a quarter across, three quarters down: one push.
  let before = await pushes();
  await canvas.click({ position: { x: box.width * 0.25, y: box.height * 0.75 } });
  await expect.poll(async () => (await seen(page, 'click', since)).length).toBe(1);
  expect(await pushes() - before).toBe(1);
  const [single] = await seen(page, 'click', since);
  expectPayload(single!);
  expect(single!.x).toBeCloseTo(0.25, 1);
  expect(single!.y).toBeCloseTo(0.75, 1);
  expect(single).toMatchObject({ pointerType: 'mouse', button: 0, shift: false, alt: false, ctrl: false, meta: false });

  // A double click with Alt: two Clicks, then a Double.
  before = await pushes();
  await canvas.dblclick({ position: { x: box.width * 0.5, y: box.height * 0.5 }, modifiers: ['Alt'] });
  await expect.poll(async () => (await seen(page, 'double', since)).length).toBe(1);
  await expect.poll(async () => (await seen(page, 'click', since)).length).toBe(3);
  const [double] = await seen(page, 'double', since);
  expectPayload(double!);
  expect(double).toMatchObject({ x: expect.closeTo(0.5, 1), y: expect.closeTo(0.5, 1), button: 0, alt: true });
  const clicks = await seen(page, 'click', since);
  expect(clicks.slice(1).every((e) => e.alt && e.time <= double!.time)).toBe(true);
  // Three browser events (two clicks, one dblclick), each pushed once; the presses reach no source.
  expect(await pushes() - before).toBe(3);

  // A middle click: Middle, button 1, and nothing on Click.
  await canvas.click({ position: { x: box.width * 0.8, y: box.height * 0.2 }, button: 'middle' });
  await expect.poll(async () => (await seen(page, 'middle', since)).length).toBe(1);
  const [middle] = await seen(page, 'middle', since);
  expectPayload(middle!);
  expect(middle).toMatchObject({ x: expect.closeTo(0.8, 1), y: expect.closeTo(0.2, 1), button: 1 });

  // A right-click with Shift: Right only. The context menu is suppressed, and Chromium's button-2 auxclick isn't Middle.
  await canvas.click({ position: { x: box.width * 0.9, y: box.height * 0.1 }, button: 'right', modifiers: ['Shift'] });
  await expect.poll(async () => (await seen(page, 'right', since)).length).toBe(1);
  const [right] = await seen(page, 'right', since);
  expectPayload(right!);
  expect(right).toMatchObject({ x: expect.closeTo(0.9, 1), y: expect.closeTo(0.1, 1), button: 2, shift: true });

  // Synthetic events: a touch tap's click (Chromium's click is a PointerEvent), Ctrl-click's contextmenu
  // (macOS), and a back-button auxclick, which Middle leaves out. Positions past the canvas clamp to 0–1.
  const prevented = await page.evaluate(() => {
    const element = document.querySelector('[data-testid="performance-canvas"]')!;
    const r = element.getBoundingClientRect();
    element.dispatchEvent(new PointerEvent('click', { bubbles: true, pointerType: 'touch', clientX: r.left + r.width * 0.4, clientY: r.top + r.height * 0.6, button: 0, metaKey: true }));
    element.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5, button: 3 }));
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.right + 40, clientY: r.top - 40, button: 0, ctrlKey: true });
    element.dispatchEvent(menu);
    return menu.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect.poll(async () => (await seen(page, 'click', since)).length).toBe(4);
  await expect.poll(async () => (await seen(page, 'right', since)).length).toBe(2);
  const touch = (await seen(page, 'click', since))[3]!;
  expectPayload(touch);
  expect(touch).toMatchObject({ pointerType: 'touch', x: expect.closeTo(0.4, 1), y: expect.closeTo(0.6, 1), meta: true });
  const ctrl = (await seen(page, 'right', since))[1]!;
  expectPayload(ctrl);
  expect(ctrl).toMatchObject({ x: 1, y: 0, button: 0, ctrl: true });
  // Only the middle button's auxclick ever reached Middle.
  expect((await seen(page, 'middle', since)).map((e) => e.button)).toEqual([1]);

  await page.evaluate(() => (window as unknown as { unwatch: (() => void)[] }).unwatch.forEach((stop) => stop()));
  await page.screenshot({ path: 'test-results/click.png' });
  expect(errors).toEqual([]);
});
