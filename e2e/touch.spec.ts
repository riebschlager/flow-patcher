import { expect, test, type Page } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
  }
}

const SIGNALS = ['width', 'height', 'scale', 'rotation'] as const;
type Seen = Record<string, number | string | boolean | undefined> & { time: number; channel: number; phase?: string };
type Contact = { slot: number; id: number | null; down: boolean; payload: Record<string, unknown> };

/** Every event a node's output has sent over the last 2 s (the probe's history), stamped after `since`. */
const seen = (page: Page, id: string, port: string, since: number) =>
  page.evaluate(([n, p, s]) => (window.flowPatcher!.probe(n as string, p as string)?.events ?? []).filter((e) => e.time > (s as number)).map((e) => ({ ...e })), [id, port, since] as const) as Promise<Seen[]>;
/** A signal's latest sample (channel 0, once a frame). */
const latest = (page: Page, port: string) => page.evaluate((p) => window.flowPatcher!.probe('touch', p)?.value as number | undefined, port);
/** Touch extras' touch slots (its own map), for the per-channel sizes. */
const contacts = (page: Page) => page.evaluate(() => (window.flowPatcher!.stateOf('touch')?.contacts ?? []) as Contact[]);
const now = (page: Page) => page.evaluate(() => window.flowPatcher!.clock.currentTime);

/**
 * Dispatches a synthetic touch PointerEvent on the canvas at (fx, fy) of its box. The canvas takes
 * pointer capture on a down, which needs an active pointerId, and Chromium's only synthetic one is
 * the mouse's (1); so each touch borrows capture from it for its id.
 */
type Init = { fx: number; fy: number; pointerId: number } & Record<string, number | string | boolean>;
const touch = (page: Page, type: string, init: Init) =>
  page.evaluate(([t, { fx, fy, ...rest }]) => {
    const element = document.querySelector('[data-testid="performance-canvas"]') as HTMLCanvasElement;
    const r = element.getBoundingClientRect();
    element.dispatchEvent(new PointerEvent(t as string, { bubbles: true, cancelable: true, pointerType: 'touch', clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, ...(rest as PointerEventInit) }));
  }, [type, init] as const);

/**
 * Dispatches a Safari gesture event on the canvas. Chromium has no GestureEvent, so it's a plain Event
 * with GestureEvent's fields defined on it. Returns whether its default was prevented.
 */
type GestureInit = { fx: number; fy: number; scale: number; rotation: number; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };
const gesture = (page: Page, type: string, init: GestureInit) =>
  page.evaluate(([t, { fx, fy, ...rest }]) => {
    const element = document.querySelector('[data-testid="performance-canvas"]')!;
    const r = element.getBoundingClientRect();
    const event = new Event(t as string, { bubbles: true, cancelable: true });
    const fields = { clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...rest };
    for (const [name, value] of Object.entries(fields)) Object.defineProperty(event, name, { value });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, [type, init] as const);

// Touch extras (#75): touches' contact sizes reach Width and Height on their own slots, and Safari's
// gesturechange reaches Gesture, Scale and Rotation; the canvas keeps gestures only while a source reads them.
test('touch sizes reach Width and Height, and Safari gesturechange reaches Gesture, Scale and Rotation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

  await page.goto('/?patch=touch-size');
  await expect(page.getByTestId('compile-status')).toHaveText('7 nodes compiled');
  await expect(page.locator('.preview__hint')).toHaveCount(0);
  const canvas = page.getByTestId('performance-canvas');
  await page.evaluate((signals) => {
    const live = window.flowPatcher!;
    // Touches can't take capture with a synthetic pointerId (above): let the canvas's capture fall back to the mouse's.
    const element = document.querySelector('[data-testid="performance-canvas"]') as HTMLCanvasElement;
    const capture = element.setPointerCapture.bind(element);
    element.setPointerCapture = (id: number) => {
      try {
        capture(id);
      } catch {
        capture(1);
      }
    };
    (window as unknown as { unwatch: (() => void)[] }).unwatch = [
      live.watchProbe('touch', 'gesture', 'out', 'event', () => {}),
      live.watchProbe('pointer', 'all', 'out', 'event', () => {}),
      ...signals.map((port) => live.watchProbe('touch', port, 'out', 'signal', () => {})),
    ];
  }, [...SIGNALS]);
  expect(await page.evaluate(() => [...window.flowPatcher!.inputTypes].sort())).toEqual(['gesturechange', 'pointercancel', 'pointerdown', 'pointerenter', 'pointerleave', 'pointermove', 'pointerup']);

  // A real mouse click starts audio. It reaches Pointer, not Touch extras: no slot, Width 0, and the
  // gesture at rest (Scale 1, Rotation 0), as outside Safari.
  await canvas.click({ position: { x: 20, y: 20 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  expect(await contacts(page)).toEqual([]);
  await expect.poll(() => latest(page, 'scale')).toBe(1);
  expect(await latest(page, 'rotation')).toBe(0);
  expect(await latest(page, 'width')).toBe(0);
  expect(await latest(page, 'height')).toBe(0);

  // Two fingers with different contact sizes (CSS pixels): slots 1 and 2, each with its own size.
  let since = await now(page);
  await touch(page, 'pointerdown', { fx: 0.3, fy: 0.5, pointerId: 21, button: 0, buttons: 1, pressure: 0.5, width: 20, height: 24 });
  await expect.poll(() => latest(page, 'width')).toBe(20);
  expect(await latest(page, 'height')).toBe(24);
  await touch(page, 'pointerdown', { fx: 0.7, fy: 0.5, pointerId: 22, button: 0, buttons: 1, pressure: 0.5, width: 30, height: 10 });
  // Channel 0 reads the latest touch.
  await expect.poll(() => latest(page, 'width')).toBe(30);
  expect(await latest(page, 'height')).toBe(10);
  // The first finger flattens.
  await touch(page, 'pointermove', { fx: 0.31, fy: 0.5, pointerId: 21, buttons: 1, pressure: 0.6, width: 36, height: 40 });
  await expect.poll(() => latest(page, 'width')).toBe(36);
  expect(await latest(page, 'height')).toBe(40);
  const slots = (await contacts(page)).map((c) => [c.slot, c.id, c.down, c.payload.width, c.payload.height, c.payload.pointerType]).sort();
  expect(slots).toEqual([[1, 21, true, 36, 40, 'touch'], [2, 22, true, 30, 10, 'touch']]);
  // Pointer saw the same sizes on its events.
  await expect.poll(async () => (await seen(page, 'pointer', 'all', since)).map((e) => [e.phase, e.width, e.height])).toEqual([['down', 20, 24], ['down', 30, 10], ['move', 36, 40]]);

  // Safari's pinch: gesturestart and each gesturechange kept from the page, each change on Gesture with
  // its scale, rotation in radians, centre and modifiers, on channel 0; Scale and Rotation follow.
  since = await now(page);
  expect(await gesture(page, 'gesturestart', { fx: 0.5, fy: 0.5, scale: 1, rotation: 0 })).toBe(true);
  expect(await gesture(page, 'gesturechange', { fx: 0.5, fy: 0.5, scale: 1.25, rotation: 10 })).toBe(true);
  expect(await gesture(page, 'gesturechange', { fx: 0.52, fy: 0.25, scale: 1.5, rotation: 30, shiftKey: true, metaKey: true })).toBe(true);
  await expect.poll(async () => (await seen(page, 'touch', 'gesture', since)).length).toBe(2);
  const [first, second] = await seen(page, 'touch', 'gesture', since);
  for (const e of [first!, second!]) {
    expect(e.channel).toBe(0);
    for (const axis of [e.x, e.y]) expect(axis as number).toBeGreaterThanOrEqual(0);
    for (const flag of ['shift', 'alt', 'ctrl', 'meta']) expect(typeof e[flag], flag).toBe('boolean');
  }
  expect(first).toMatchObject({ scale: 1.25, rotation: expect.closeTo((10 * Math.PI) / 180, 9), x: expect.closeTo(0.5, 1), y: expect.closeTo(0.5, 1), shift: false, meta: false });
  expect(second).toMatchObject({ scale: 1.5, rotation: expect.closeTo(Math.PI / 6, 9), x: expect.closeTo(0.52, 1), y: expect.closeTo(0.25, 1), shift: true, alt: false, ctrl: false, meta: true });
  await expect.poll(() => latest(page, 'scale')).toBe(1.5);
  expect(await latest(page, 'rotation')).toBeCloseTo(Math.PI / 6, 9);
  expect(await gesture(page, 'gestureend', { fx: 0.5, fy: 0.5, scale: 1.5, rotation: 30 })).toBe(true);
  // gestureend isn't a stream type: Scale and Rotation hold the gesture's last values.
  expect(await latest(page, 'scale')).toBe(1.5);

  // The fingers lift: their slots are free and Width and Height read 0.
  await touch(page, 'pointerup', { fx: 0.31, fy: 0.5, pointerId: 21, button: 0, buttons: 0, pressure: 0, width: 36, height: 40 });
  await touch(page, 'pointerup', { fx: 0.7, fy: 0.5, pointerId: 22, button: 0, buttons: 0, pressure: 0, width: 30, height: 10 });
  await expect.poll(() => latest(page, 'width')).toBe(0);
  expect(await latest(page, 'height')).toBe(0);
  expect((await contacts(page)).map((c) => c.id)).toEqual([null, null]);

  await page.evaluate(() => (window as unknown as { unwatch: (() => void)[] }).unwatch.forEach((stop) => stop()));
  await page.screenshot({ path: 'test-results/touch.png' });

  // A patch without Touch extras leaves gestures to the browser.
  await page.goto('/?patch=click-notes');
  await expect(page.getByTestId('compile-status')).toHaveText('7 nodes compiled');
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) expect(await gesture(page, type, { fx: 0.5, fy: 0.5, scale: 2, rotation: 0 }), type).toBe(false);
  expect(errors).toEqual([]);
});
