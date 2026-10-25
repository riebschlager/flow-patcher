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
    // Only what comes after this: a probe's history still holds the press that started audio.
    const since = window.flowPatcher!.clock.currentTime;
    for (const [node, port, type] of list) {
      const key = `${node}.${port}`;
      seen[key] = [];
      window.flowPatcher!.watchProbe(node, port, 'out', type, () => {
        for (const event of window.flowPatcher!.probe(node, port)?.events ?? []) {
          if (event.time >= since && !seen[key]!.some((e) => e.time === event.time && e.channel === event.channel && e.pitch === event.pitch)) seen[key]!.push(event);
        }
      });
    }
  }, outputs);
}
const count = (page: Page, key: string) => page.evaluate((k) => window.modeSeen![k]!.length, key);
/** The count once it has held for two 300 ms gaps: notes still in the scheduler or the probe are in. */
async function settled(page: Page, key: string): Promise<number> {
  let last = -1, same = 0;
  for (;;) {
    const now = await count(page, key);
    same = now === last ? same + 1 : 0;
    if (same === 2) return now;
    last = now;
    await page.waitForTimeout(300);
  }
}
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

/** Presses at `from` and moves to `to` in `steps`, `stepMs` apart; `lead` first jumps that far toward `to`. */
async function drag(page: Page, from: [number, number], to: [number, number], steps: number, stepMs: number, lead = 0) {
  const at = await canvasAt(page);
  await page.mouse.move(...at(...from));
  await page.mouse.down();
  if (lead > 0) {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    from = [from[0] + ((to[0] - from[0]) * lead) / length, from[1] + ((to[1] - from[1]) * lead) / length];
    await page.mouse.move(...at(...from));
  }
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(...at(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps));
    await page.waitForTimeout(stepMs);
  }
  await page.mouse.up();
}

test('Paint: strokes play a note each Spacing of travel, fast or slow, and a held press blooms', async ({ page }) => {
  const errors = await open(page, 'paint');
  await start(page);
  await follow(page, [['paint', 'note', 'note'], ['moving', 'out', 'event'], ['bloom1', 'note', 'note'], ['hold', 'release', 'event']]);
  // Drag Spacing 0.07 in canvas units; the strokes run along x, so travel is in canvas-width units.
  const SPACING = 0.07;

  // Fast: 0.6 across in about half a second.
  await drag(page, [0.15, 0.6], [0.75, 0.6], 30, 16, 0.03);
  const fast = await settled(page, 'moving.out');
  expect(fast).toBeGreaterThanOrEqual(Math.floor(0.6 / SPACING) - 2);
  expect(fast).toBeLessThanOrEqual(Math.ceil(0.6 / SPACING));

  // Slow (Flow's ribbon): 0.4 across in about 3 s, still above the Gate's Level 0.04, so it plays, by distance.
  // Its first step leaves Hold's 0.025 radius at once: a loaded page that delivers the first moves late
  // would otherwise leave the press still long enough for Hold to charge and claim it, as it should.
  await drag(page, [0.2, 0.8], [0.6, 0.8], 75, 40, 0.04);
  const slow = (await settled(page, 'moving.out')) - fast;
  // Neither stroke was ever still long enough for Hold to take it.
  expect(await count(page, 'hold.release')).toBe(0);
  expect(slow).toBeGreaterThanOrEqual(Math.floor(0.4 / SPACING) - 2);
  expect(slow).toBeLessThanOrEqual(Math.ceil(0.4 / SPACING));
  // Each stroke's press plays too.
  expect(await settled(page, 'paint.note')).toBe(1 + fast + 1 + slow);

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
  // At Flow's default Amount: cutoff 18 kHz × 2^(−3.7·y), pan 0.65·(x − 0.5).
  // Low right, (0.9, 0.9): about 1.8 kHz, pan +0.26.
  await expect.poll(() => param(page, 'filter', 'cutoff')).toBeLessThan(2500);
  await expect.poll(() => param(page, 'pan', 'pan')).toBeGreaterThan(0.2);
  // High left, (0.2, 0.3): about 8.3 kHz, pan −0.2. Cutoff from x or pan from y would fail one of the two.
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(...at(0.9 - i * 0.035, 0.9 - i * 0.03));
    await page.waitForTimeout(20);
  }
  await expect.poll(() => param(page, 'filter', 'cutoff')).toBeGreaterThan(6000);
  await expect.poll(() => param(page, 'filter', 'cutoff')).toBeLessThan(11000);
  await expect.poll(() => param(page, 'pan', 'pan')).toBeLessThan(-0.15);
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
  // Room: 0.05 + 0.6·(1 − y); echoes: 0.585·x. Top right, (0.92, 0.1): room 0.59, echoes 0.54.
  await expect.poll(() => param(page, 'space', 'mix')).toBeGreaterThan(0.45);
  await expect.poll(() => param(page, 'echo', 'mix')).toBeGreaterThan(0.4);
  // Bottom right, (0.92, 0.9): echoes stay, the room goes. Swapped axes would fail here.
  for (let i = 1; i <= 16; i++) {
    await page.mouse.move(...at(0.92, 0.1 + i * 0.05));
    await page.waitForTimeout(20);
  }
  await expect.poll(() => param(page, 'space', 'mix')).toBeLessThan(0.25);
  expect(await param(page, 'echo', 'mix')).toBeGreaterThan(0.4);
  await page.mouse.up();
  await expect.poll(() => param(page, 'space', 'mix'), { timeout: 5000 }).toBeLessThan(roomAt + 0.05);
  await expect.poll(() => param(page, 'echo', 'mix'), { timeout: 5000 }).toBeLessThan(echoAt + 0.05);
  expect(errors).toEqual([]);
});

test('Orbit: circling starts an orbit and drives echoes and resonance above a still press', async ({ page }) => {
  const errors = await open(page, 'orbit');
  await start(page);
  await follow(page, [['circle', 'start', 'event']]);
  const box = (await page.getByTestId('performance-canvas').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2, r = box.height * 0.25;
  await page.mouse.move(cx + r, cy);
  await page.mouse.down();
  // A still press first: orbit 0.5, so echoes 0.26 and Q 0.6 once Smooth (0.12 s rise) has caught up.
  await page.waitForTimeout(700);
  const echoStill = await param(page, 'echo', 'mix'), qStill = await param(page, 'filter', 'q');
  expect(echoStill).toBeGreaterThan(0.2);
  let echo = 0, q = 0;
  for (let i = 1; i <= 90; i++) {
    const a = (i / 45) * Math.PI * 2;
    await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
    await page.waitForTimeout(16);
    if (i > 45 && i % 5 === 0) {
      echo = Math.max(echo, await param(page, 'echo', 'mix'));
      q = Math.max(q, await param(page, 'filter', 'q'));
    }
  }
  await page.mouse.up();
  await expect.poll(() => count(page, 'circle.start')).toBe(1);
  // orbit = 0.5 + 0.5·energy, smoothed: echoes 0.52·orbit, Q 0.4 + 0.39·orbit. Circling raises both above the
  // still press by how fast it goes, and a loaded runner circles slower, so the margins are small: 0.1 of energy.
  expect(echo).toBeGreaterThan(echoStill + 0.026);
  expect(q).toBeGreaterThan(qStill + 0.0195);
  expect(errors).toEqual([]);
});

test('?canvas=full: a mode fills a phone-sized window and plays from a press', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Compile status lives in the editor's bar, which this mode hides.
  await page.goto('/?patch=modes/paint&canvas=full');
  const canvas = page.getByTestId('performance-canvas');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  // The whole window but the preview's status bar.
  expect(box.width).toBe(390);
  expect(box.height).toBeGreaterThan(844 - 40);
  await expect(page.locator('.app__bar')).toBeHidden();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  await follow(page, [['paint', 'note', 'note']]);
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.7);
  await expect.poll(() => count(page, 'paint.note')).toBe(1);
  expect(errors).toEqual([]);
});
