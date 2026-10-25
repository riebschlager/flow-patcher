import { expect, test, type Page } from '@playwright/test';
import type { EngineEvent } from '@flow-patcher/engine';
import type { LivePatch } from '../packages/editor/src/live';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
    /** Every event a watched output showed, by "node.port", kept past the probe's history. */
    modeSeen?: Record<string, EngineEvent[]>;
  }
}

// #83: Flow's four tool modes, rebuilt as examples/modes/*.flowpatch, played live in the editor
// with the mouse. tools/modes.test.ts replays their scripted streams headless; this checks that
// live pushes reach them (Pointer's signals re-read after each push) and that each does its job.

async function open(page: Page, mode: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?patch=modes/${mode}`);
  await expect(page.getByTestId('compile-status')).toHaveText(/\d+ nodes compiled/);
  return errors;
}

async function follow(page: Page, outputs: [string, string, 'event' | 'note'][]) {
  await page.evaluate((list) => {
    const seen: Record<string, EngineEvent[]> = (window.modeSeen = {});
    for (const [node, port, type] of list) {
      const key = `${node}.${port}`;
      seen[key] = [];
      window.flowPatcher!.watchProbe(node, port, 'out', type, () => {
        for (const event of window.flowPatcher!.probe(node, port)?.events ?? []) {
          if (!seen[key]!.some((e) => e.time === event.time && e.channel === event.channel && e.pitch === event.pitch)) seen[key]!.push(event);
        }
      });
    }
  }, outputs);
}
const count = (page: Page, key: string) => page.evaluate((k) => window.modeSeen![k]!.length, key);
const param = (page: Page, node: string, name: string) => page.evaluate(([n, p]) => window.flowPatcher!.paramAt(n!, p!)!, [node, name]);

/** Canvas coordinates (0–1) to page pixels. */
async function canvasAt(page: Page) {
  const box = (await page.getByTestId('performance-canvas').boundingBox())!;
  return (x: number, y: number) => [box.x + x * box.width, box.y + y * box.height] as const;
}

/** Starts audio with a press in a corner. */
async function start(page: Page) {
  const at = await canvasAt(page);
  await page.mouse.click(...at(0.05, 0.05));
  await expect(page.getByTestId('audio-state')).toHaveText('live');
}

async function drag(page: Page, from: [number, number], to: [number, number], steps: number, stepMs: number) {
  const at = await canvasAt(page);
  await page.mouse.move(...at(...from));
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(...at(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps));
    await page.waitForTimeout(stepMs);
  }
  await page.mouse.up();
}

test('Paint: a fast stroke keeps playing, a slow one plays only its press, and a held press blooms', async ({ page }) => {
  const errors = await open(page, 'paint');
  await start(page);
  await follow(page, [['paint', 'note', 'note'], ['moving', 'out', 'event'], ['bloom1', 'note', 'note']]);

  await drag(page, [0.15, 0.7], [0.8, 0.35], 30, 16);
  await expect.poll(() => count(page, 'moving.out')).toBeGreaterThanOrEqual(4);
  const afterFast = await count(page, 'paint.note');
  expect(afterFast).toBeGreaterThanOrEqual(5);

  const moving = await count(page, 'moving.out');
  await drag(page, [0.3, 0.8], [0.36, 0.79], 30, 40);
  await page.waitForTimeout(300);
  expect(await count(page, 'moving.out')).toBe(moving);
  expect(await count(page, 'paint.note')).toBe(afterFast + 1);

  const at = await canvasAt(page);
  await page.mouse.move(...at(0.6, 0.55));
  await page.mouse.down();
  await page.waitForTimeout(1700);
  await page.mouse.up();
  await expect.poll(() => count(page, 'bloom1.note')).toBe(1);
  expect(errors).toEqual([]);
});

test('Conduct: low on the canvas closes the filter, sideways pans, and letting go opens it again', async ({ page }) => {
  const errors = await open(page, 'conduct');
  await start(page);
  const at = await canvasAt(page);
  await page.mouse.move(...at(0.5, 0.2));
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(...at(0.5 + i * 0.02, 0.2 + i * 0.035));
    await page.waitForTimeout(20);
  }
  // y = 0.9: 350·(18000/350)^0.1 ≈ 520 Hz once Smooth has caught up.
  await expect.poll(() => param(page, 'filter', 'cutoff')).toBeLessThan(800);
  await expect.poll(() => param(page, 'pan', 'pan')).toBeGreaterThan(0.3);
  await page.mouse.up();
  await expect.poll(() => param(page, 'filter', 'cutoff'), { timeout: 4000 }).toBeGreaterThan(15000);
  await expect.poll(() => param(page, 'pan', 'pan').then(Math.abs)).toBeLessThan(0.05);
  expect(errors).toEqual([]);
});

test('Space: up adds room, right adds echoes, and both fall away on release', async ({ page }) => {
  const errors = await open(page, 'space');
  await start(page);
  const roomAt = await param(page, 'space', 'mix'), echoAt = await param(page, 'echo', 'mix');
  const at = await canvasAt(page);
  await page.mouse.move(...at(0.9, 0.1));
  await page.mouse.down();
  await page.mouse.move(...at(0.92, 0.1));
  // Room: 0.05 + 0.7·(1 − y); echoes: 0.6·x.
  await expect.poll(() => param(page, 'space', 'mix')).toBeGreaterThan(0.5);
  await expect.poll(() => param(page, 'echo', 'mix')).toBeGreaterThan(0.45);
  await page.mouse.up();
  await expect.poll(() => param(page, 'space', 'mix'), { timeout: 5000 }).toBeLessThan(roomAt + 0.05);
  await expect.poll(() => param(page, 'echo', 'mix'), { timeout: 5000 }).toBeLessThan(echoAt + 0.05);
  expect(errors).toEqual([]);
});

test('Orbit: circling starts an orbit, adds echoes and room, and raises the resonance', async ({ page }) => {
  const errors = await open(page, 'orbit');
  await start(page);
  await follow(page, [['circle', 'start', 'event']]);
  const box = (await page.getByTestId('performance-canvas').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2, r = box.height * 0.25;
  await page.mouse.move(cx + r, cy);
  await page.mouse.down();
  let echo = 0, q = 0;
  for (let i = 1; i <= 90; i++) {
    const a = (i / 45) * Math.PI * 2;
    await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
    await page.waitForTimeout(16);
    if (i > 45) {
      echo = Math.max(echo, await param(page, 'echo', 'mix'));
      q = Math.max(q, await param(page, 'filter', 'q'));
    }
  }
  await page.mouse.up();
  await expect.poll(() => count(page, 'circle.start')).toBe(1);
  // orbit = 0.5 + 0.5·energy, smoothed: echoes 0.6·orbit, Q 0.4 + 0.6·orbit.
  expect(echo).toBeGreaterThan(0.25);
  expect(q).toBeGreaterThan(0.65);
  expect(errors).toEqual([]);
});
