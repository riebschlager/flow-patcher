import { expect, test, type Page } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
  }
}

const PEN_FIELDS = ['tiltX', 'tiltY', 'altitudeAngle', 'azimuthAngle', 'twist', 'tangentialPressure', 'barrel'] as const;
const SIGNALS = ['tiltX', 'tiltY', 'altitudeAngle', 'azimuthAngle', 'twist', 'tangentialPressure', 'barrel', 'pressure'] as const;
type Seen = Record<string, number | string | boolean | undefined> & { time: number; channel: number; phase?: string };

const node = (id: string, type: string, typeVersion: number, x: number) => ({ id, type, typeVersion, params: {}, position: { x, y: 0 } });

/** Every event a node's All has sent over the last 2 s (the probe's history), stamped after `since`. */
const seen = (page: Page, id: string, since: number) =>
  page.evaluate(([n, s]) => (window.flowPatcher!.probe(n as string, 'all')?.events ?? []).filter((e) => e.time > (s as number)).map((e) => ({ ...e })), [id, since] as const) as Promise<Seen[]>;
/** A signal's latest sample (channel 0, once a frame). */
const latest = (page: Page, port: string) => page.evaluate((p) => window.flowPatcher!.probe('pen', p)?.value as number | undefined, port);

/**
 * Dispatches a synthetic pointer event on the canvas at (fx, fy) of its box. pointerId 1 is the mouse's,
 * the one pointer Chromium always has active, so the canvas can take capture of it on a down.
 * React's enter and leave come from pointerover and pointerout.
 */
type Init = { fx: number; fy: number } & Record<string, number | string | boolean>;
const dispatch = (page: Page, type: string, init: Init) =>
  page.evaluate(([t, { fx, fy, ...rest }]) => {
    const element = document.querySelector('[data-testid="performance-canvas"]')!;
    const r = element.getBoundingClientRect();
    element.dispatchEvent(new PointerEvent(t as string, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, ...(rest as PointerEventInit) }));
  }, [type, init] as const);

// Pen (#75): a pen's pointer events reach Pen with every pen field, on its own slot, with All tagging
// each with its phase; mice and touches reach Pointer only, without pen fields.
test('pen events reach Pen with tilt, angles, twist, tangential pressure and the barrel; mice and touches do not', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

  // The example patch loads and plays the canvas.
  await page.goto('/?patch=pen-tilt');
  await expect(page.getByTestId('compile-status')).toHaveText('4 nodes compiled');
  await expect(page.locator('.preview__hint')).toHaveCount(0);

  // Pen beside Pointer, both reading the same canvas.
  const patch = { format: 'flowpatch', version: 1, seed: 75, nodes: [node('pen', 'pen', 1, 0), node('p', 'pointer', 2, 260)], cables: [] };
  await page.getByTestId('open-file').setInputFiles({ name: 'pens.flowpatch', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(patch)) });
  await expect(page.getByTestId('compile-status')).toHaveText('2 nodes compiled');
  const canvas = page.getByTestId('performance-canvas');
  await page.evaluate((signals) => {
    const live = window.flowPatcher!;
    (window as unknown as { unwatch: (() => void)[] }).unwatch = [
      live.watchProbe('pen', 'all', 'out', 'event', () => {}),
      live.watchProbe('p', 'all', 'out', 'event', () => {}),
      ...signals.map((port) => live.watchProbe('pen', port, 'out', 'signal', () => {})),
    ];
  }, [...SIGNALS]);
  // A real mouse click starts audio, and reaches Pointer only.
  let since = await page.evaluate(() => window.flowPatcher!.clock.currentTime);
  await canvas.click({ position: { x: 30, y: 30 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  await expect.poll(async () => (await seen(page, 'p', since)).filter((e) => e.phase === 'up').length).toBeGreaterThanOrEqual(1);
  for (const e of await seen(page, 'p', since)) {
    expect(e.pointerType).toBe('mouse');
    for (const field of PEN_FIELDS) expect(e[field], field).toBeUndefined();
  }
  expect(await seen(page, 'pen', since)).toEqual([]);
  expect(await page.evaluate(() => window.flowPatcher!.stateOf('pen')?.contacts ?? [])).toEqual([]);
  // Before any pen, Pen's signals read a pen held upright.
  await expect.poll(() => latest(page, 'altitudeAngle')).toBeCloseTo(Math.PI / 2, 6);
  expect(await latest(page, 'barrel')).toBe(0);

  // A pen hovers in, tilted, with the angles the browser computes from tilt; presses the barrel in the
  // air (the first button, so a pointerdown with button 2 and no tip pressure, as browsers send it),
  // sending altitude and azimuth, so the browser computes the tilt (it prefers tilt when given both);
  // touches the tip down while holding it (a chorded button: a move with buttons 3) and drags; lets
  // both go; and leaves. Expected tilt: the spec's conversion, which Chromium
  // rounds to whole degrees. Pen's fields are also compared exactly with what Pointer saw raw.
  const tiltOf = (altitude: number, azimuth: number) => [Math.atan(Math.cos(azimuth) / Math.tan(altitude)) * 180 / Math.PI, Math.atan(Math.sin(azimuth) / Math.tan(altitude)) * 180 / Math.PI] as const;
  const [downX, downY] = tiltOf(1, 2.5), [dragX, dragY] = tiltOf(1.1, 2.6);
  since = await page.evaluate(() => window.flowPatcher!.clock.currentTime);
  const pen = { pointerType: 'pen' };
  await dispatch(page, 'pointerover', { fx: 0.05, fy: 0.5, ...pen, tiltX: 30, tiltY: 0 });
  await dispatch(page, 'pointermove', { fx: 0.1, fy: 0.5, ...pen, buttons: 0, pressure: 0, tiltX: 30, tiltY: 0, twist: 10 });
  await dispatch(page, 'pointerdown', { fx: 0.2, fy: 0.4, ...pen, button: 2, buttons: 2, pressure: 0, twist: 45, tangentialPressure: 0.5, altitudeAngle: 1, azimuthAngle: 2.5, width: 1, height: 1, shiftKey: true });
  await dispatch(page, 'pointermove', { fx: 0.3, fy: 0.4, ...pen, button: 0, buttons: 3, pressure: 0.7, twist: 50, tangentialPressure: -0.25, altitudeAngle: 1.1, azimuthAngle: 2.6 });
  // Mid-drag: the signals follow the pen's latest event.
  await expect.poll(() => latest(page, 'twist')).toBeCloseTo(50, 3);
  expect(await latest(page, 'tiltX')).toBeCloseTo(dragX, 0);
  expect(await latest(page, 'tiltY')).toBeCloseTo(dragY, 0);
  expect(await latest(page, 'altitudeAngle')).toBeCloseTo(1.1, 6);
  expect(await latest(page, 'azimuthAngle')).toBeCloseTo(2.6, 6);
  expect(await latest(page, 'tangentialPressure')).toBeCloseTo(-0.25, 3);
  expect(await latest(page, 'barrel')).toBe(1);
  expect(await latest(page, 'pressure')).toBeCloseTo(0.7, 3);
  await dispatch(page, 'pointerup', { fx: 0.3, fy: 0.4, ...pen, button: 2, buttons: 0, pressure: 0, tiltX: -20, tiltY: 10, twist: 50 });
  await dispatch(page, 'pointerout', { fx: 1.2, fy: 0.4, ...pen, tiltX: -20, tiltY: 10 });

  await expect.poll(async () => (await seen(page, 'pen', since)).map((e) => e.phase)).toEqual(['move', 'down', 'move', 'up']);
  const all = await seen(page, 'pen', since);
  for (const e of all) {
    expect(e.channel).toBe(1);
    expect(e.pointerType).toBe('pen');
    for (const field of PEN_FIELDS) expect(Number.isFinite(e[field]), `${e.phase} ${field}`).toBe(true);
    for (const flag of ['shift', 'alt', 'ctrl', 'meta']) expect(typeof e[flag]).toBe('boolean');
  }
  const [hover, down, drag, up] = all;
  // The hover: the browser's altitude and azimuth for tilt 30° along +x, no barrel.
  expect(hover).toMatchObject({ tiltX: 30, tiltY: 0, twist: 10, barrel: 0, buttons: 0, age: 0 });
  expect(hover!.altitudeAngle).toBeCloseTo(Math.PI / 3, 3);
  expect(hover!.azimuthAngle).toBeCloseTo(0, 3);
  expect(down!.tiltX).toBeCloseTo(downX, 0);
  expect(down!.tiltY).toBeCloseTo(downY, 0);
  // The barrel in the air: a Down with button 2 and the hover's pressure.
  expect(down).toMatchObject({ twist: 45, tangentialPressure: 0.5, barrel: 1, buttons: 2, button: 2, pressure: 0, shift: true, x: expect.closeTo(0.2, 1), y: expect.closeTo(0.4, 1) });
  expect(down!.altitudeAngle).toBeCloseTo(1, 6);
  expect(down!.azimuthAngle).toBeCloseTo(2.5, 6);
  expect(drag).toMatchObject({ twist: 50, barrel: 1, buttons: 3, button: 0 });
  expect(drag!.pressure).toBeCloseTo(0.7, 3);
  expect(drag!.tiltX).toBeCloseTo(dragX, 0);
  // Down and drag may share a render quantum's stamp, so age is 0 or more: their stamps' difference.
  expect(drag!.age).toBeCloseTo(drag!.time - down!.time, 9);
  expect(up).toMatchObject({ barrel: 0, pressure: 0 });
  // Pointer saw the pen too, with the fields as the browser sent them, on its own slot map.
  const pointerSaw = (await seen(page, 'p', since)).filter((e) => e.pointerType === 'pen');
  expect(pointerSaw.map((e) => e.phase)).toEqual(['move', 'down', 'move', 'up']);
  pointerSaw.forEach((raw, i) => {
    for (const field of PEN_FIELDS.filter((f) => f !== 'barrel')) expect(all[i]![field], `${raw.phase} ${field}`).toBe(raw[field]);
  });
  expect(pointerSaw[1]).toMatchObject({ twist: 45, tangentialPressure: 0.5 });
  expect(pointerSaw[1]!.barrel).toBeUndefined();
  // After the up the slot is free: no barrel, no airbrush.
  await expect.poll(() => latest(page, 'barrel')).toBe(0);
  expect(await latest(page, 'tangentialPressure')).toBe(0);
  // The angles hold the slot's last event, the up's.
  expect(await latest(page, 'tiltX')).toBe(-20);

  // A touch reaches Pointer only.
  since = await page.evaluate(() => window.flowPatcher!.clock.currentTime);
  const touch = { pointerType: 'touch', pressure: 0.5, width: 20, height: 20 };
  await dispatch(page, 'pointerdown', { fx: 0.6, fy: 0.6, ...touch, button: 0, buttons: 1 });
  await dispatch(page, 'pointerup', { fx: 0.6, fy: 0.6, ...touch, button: 0, buttons: 0, pressure: 0 });
  await expect.poll(async () => (await seen(page, 'p', since)).map((e) => e.phase)).toEqual(['down', 'up']);
  for (const e of await seen(page, 'p', since)) for (const field of PEN_FIELDS) expect(e[field], field).toBeUndefined();
  expect(await seen(page, 'pen', since)).toEqual([]);

  await page.evaluate(() => (window as unknown as { unwatch: (() => void)[] }).unwatch.forEach((stop) => stop()));
  await page.screenshot({ path: 'test-results/pen.png' });
  expect(errors).toEqual([]);
});
