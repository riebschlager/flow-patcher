import { expect, test, type Page } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
  }
}

const PORTS = ['deltaX', 'deltaY', 'zoom'] as const;
const SIGNALS = ['scrollX', 'scrollY', 'zoomLevel'] as const;
type Seen = { time: number; channel: number; x: number; y: number; deltaX: number; deltaY: number; deltaMode?: number; zoom?: number; shift: boolean; alt: boolean; ctrl: boolean; meta: boolean };

/** What Wheel's output has sent over the last 2 s (the probe's history), stamped after `since`. */
const seen = (page: Page, port: string, since: number) =>
  page.evaluate(([p, s]) => (window.flowPatcher!.probe('wheel', p as string)?.events ?? []).filter((e) => e.time > (s as number)).map((e) => ({
    time: e.time, channel: e.channel, x: e.x, y: e.y, deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, zoom: e.zoom, shift: e.shift, alt: e.alt, ctrl: e.ctrl, meta: e.meta,
  })), [port, since] as const) as Promise<Seen[]>;

/** A signal's latest sample (channel 0, once a frame). */
const latest = (page: Page, port: string) => page.evaluate((p) => window.flowPatcher!.probe('wheel', p)?.value as number | undefined, port);

/** Every documented field (canvas-sources.md, Wheel): position 0–1, deltas in pixels, no deltaMode, the modifiers, channel 0. */
function expectPayload(e: Seen) {
  expect(e.channel).toBe(0);
  for (const axis of [e.x, e.y]) {
    expect(typeof axis).toBe('number');
    expect(axis).toBeGreaterThanOrEqual(0);
    expect(axis).toBeLessThanOrEqual(1);
  }
  expect(typeof e.deltaX).toBe('number');
  expect(typeof e.deltaY).toBe('number');
  expect(e.deltaMode).toBeUndefined();
  for (const flag of [e.shift, e.alt, e.ctrl, e.meta]) expect(typeof flag).toBe('boolean');
}

/** Dispatches a synthetic wheel on the canvas at (fx, fy) of its box; returns whether its default was prevented. */
type WheelInit = { fx: number; fy: number; deltaX?: number; deltaY?: number; deltaMode?: number; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };
const dispatchWheel = (page: Page, init: WheelInit) =>
  page.evaluate(({ fx, fy, ...rest }) => {
    const element = document.querySelector('[data-testid="performance-canvas"]')!;
    const r = element.getBoundingClientRect();
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, ...rest });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, init);

// Wheel (#75): wheel events on the preview canvas reach DeltaX, DeltaY and Zoom (ctrl + wheel, a trackpad
// pinch), in pixels, with the accumulated signals; the canvas keeps the wheel only while a source reads it.
test('wheel on the preview canvas reaches DeltaX, DeltaY, Zoom and the accumulated signals', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

  await page.goto('/?patch=wheel-scroll');
  await expect(page.getByTestId('compile-status')).toHaveText('6 nodes compiled');
  // Wheel plays the canvas, so there's no "No Pointer" hint.
  await expect(page.locator('.preview__hint')).toHaveCount(0);
  const canvas = page.getByTestId('performance-canvas');
  await canvas.click({ position: { x: 20, y: 20 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  expect(await page.evaluate(() => [...window.flowPatcher!.inputTypes])).toEqual(['wheel']);
  await page.evaluate(([ports, signals]) => {
    const live = window.flowPatcher!;
    (window as unknown as { unwatch: (() => void)[] }).unwatch = [
      ...ports.map((port) => live.watchProbe('wheel', port, 'out', 'event', () => {})),
      ...signals.map((port) => live.watchProbe('wheel', port, 'out', 'signal', () => {})),
    ];
  }, [[...PORTS], [...SIGNALS]] as const);
  const box = (await canvas.boundingBox())!;
  let since = await page.evaluate(() => window.flowPatcher!.clock.currentTime);
  const pushes = () => page.evaluate(() => window.flowPatcher!.stats.pushes);

  // A real wheel notch down at a quarter across, three quarters down: one push, DeltaY only, and Scroll Y rises.
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.75);
  const scrollTop = await page.evaluate(() => document.scrollingElement!.scrollTop);
  let before = await pushes();
  await page.mouse.wheel(0, 100);
  await expect.poll(async () => (await seen(page, 'deltaY', since)).length).toBe(1);
  expect(await pushes() - before).toBe(1);
  const [notch] = await seen(page, 'deltaY', since);
  expectPayload(notch!);
  expect(notch).toMatchObject({ x: expect.closeTo(0.25, 1), y: expect.closeTo(0.75, 1), deltaX: 0, deltaY: 100, shift: false, alt: false, ctrl: false, meta: false });
  expect(await seen(page, 'deltaX', since)).toEqual([]);
  await expect.poll(() => latest(page, 'scrollY')).toBeGreaterThan(0.3);
  // The canvas kept it: the page didn't scroll.
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(scrollTop);
  // And Scroll Y decays back toward 0 (decay 1.5 /s).
  await expect.poll(() => latest(page, 'scrollY'), { timeout: 6000 }).toBeLessThan(0.05);
  // The probes keep 2 s of history, so count from here.
  since = await page.evaluate(() => window.flowPatcher!.clock.currentTime);

  // A pinch out (Chrome sends wheel + ctrlKey, deltaY < 0): Zoom only, zoom = −deltaY / 100, browser zoom prevented.
  before = await pushes();
  expect(await dispatchWheel(page, { fx: 0.5, fy: 0.4, deltaX: 1, deltaY: -12, ctrlKey: true })).toBe(true);
  await expect.poll(async () => (await seen(page, 'zoom', since)).length).toBe(1);
  expect(await pushes() - before).toBe(1);
  const [pinch] = await seen(page, 'zoom', since);
  expectPayload(pinch!);
  expect(pinch).toMatchObject({ x: expect.closeTo(0.5, 1), y: expect.closeTo(0.4, 1), deltaX: 1, deltaY: -12, zoom: 0.12, ctrl: true });
  expect(await seen(page, 'deltaY', since)).toEqual([]);
  expect(await seen(page, 'deltaX', since)).toEqual([]);
  await expect.poll(() => latest(page, 'zoomLevel')).toBeGreaterThan(0.02);

  // Firefox-style line deltas, diagonal, with Shift, Alt and Meta: lines become pixels (× 40) on DeltaX and DeltaY.
  expect(await dispatchWheel(page, { fx: 0.9, fy: 0.1, deltaX: -1, deltaY: 3, deltaMode: 1 /* DOM_DELTA_LINE */, shiftKey: true, altKey: true, metaKey: true })).toBe(true);
  await expect.poll(async () => (await seen(page, 'deltaX', since)).length).toBe(1);
  await expect.poll(async () => (await seen(page, 'deltaY', since)).length).toBe(1);
  const [lines] = await seen(page, 'deltaX', since);
  expectPayload(lines!);
  expect(lines).toMatchObject({ x: expect.closeTo(0.9, 1), y: expect.closeTo(0.1, 1), deltaX: -40, deltaY: 120, shift: true, alt: true, ctrl: false, meta: true });
  expect((await seen(page, 'deltaY', since))[0]).toEqual(lines);
  await expect.poll(() => latest(page, 'scrollX')).toBeLessThan(-0.1);

  // A page delta past the canvas edge: × 800 px, position clamped.
  expect(await dispatchWheel(page, { fx: 1.5, fy: -0.5, deltaY: 1, deltaMode: 2 /* DOM_DELTA_PAGE */ })).toBe(true);
  await expect.poll(async () => (await seen(page, 'deltaY', since)).length).toBe(2);
  expect((await seen(page, 'deltaY', since))[1]).toMatchObject({ x: 1, y: 0, deltaY: 800 });

  await page.evaluate(() => (window as unknown as { unwatch: (() => void)[] }).unwatch.forEach((stop) => stop()));
  await page.screenshot({ path: 'test-results/wheel.png' });

  // A patch without Wheel leaves the wheel to the browser.
  await page.goto('/?patch=click-notes');
  await expect(page.getByTestId('compile-status')).toHaveText('7 nodes compiled');
  expect(await dispatchWheel(page, { fx: 0.5, fy: 0.5, deltaY: 100 })).toBe(false);
  expect(await dispatchWheel(page, { fx: 0.5, fy: 0.5, deltaY: -5, ctrlKey: true })).toBe(false);
  expect(errors).toEqual([]);
});
