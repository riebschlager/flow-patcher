import { expect, test, type Page } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
    /** Every Canvas event a probe showed, by port: the times, kept past the probe's history. */
    canvasSeen?: Record<string, number[]>;
  }
}

// Canvas node (#76): the host sends the preview canvas's size, its focus and blur, and the page's
// visibility to the Canvas node. examples/canvas-lifecycle.flowpatch has a Canvas.

const EVENT_PORTS = ['focus', 'blur', 'hidden', 'visible'] as const;

async function follow(page: Page) {
  await page.evaluate((ports) => {
    const seen: Record<string, number[]> = (window.canvasSeen = {});
    for (const port of ports) {
      seen[port] = [];
      window.flowPatcher!.watchProbe('canvas', port, 'out', 'event', () => {
        for (const event of window.flowPatcher!.probe('canvas', port)?.events ?? []) if (!seen[port]!.includes(event.time)) seen[port]!.push(event.time);
      });
    }
    for (const port of ['width', 'height', 'aspect']) window.flowPatcher!.watchProbe('canvas', port, 'out', 'signal', () => {});
  }, EVENT_PORTS);
}
const count = (page: Page, port: string) => page.evaluate((p) => window.canvasSeen![p]!.length, port);
const signal = (page: Page, port: string) => page.evaluate((p) => window.flowPatcher!.probe('canvas', p)?.value, port);
/** The canvas's CSS-pixel size, as a ResizeObserver reports it. */
const cssSize = (page: Page) => page.getByTestId('performance-canvas').evaluate((el) => {
  const box = el.getBoundingClientRect();
  return { width: box.width, height: box.height };
});
/** Pretends the page was hidden or shown: the visibility the Canvas node reads, without the scheduler's hidden mode. */
const setVisibility = (page: Page, state: 'hidden' | 'visible') => page.evaluate((s) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
  document.dispatchEvent(new Event('visibilitychange'));
}, state);

async function dragGrip(page: Page, dx: number, dy: number) {
  const grip = page.getByLabel('Resize preview');
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
}

test('Canvas follows the preview\'s size, its focus and blur, and the page\'s visibility', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

  await page.goto('/?patch=canvas-lifecycle');
  await expect(page.getByTestId('compile-status')).toHaveText('8 nodes compiled');
  await follow(page);
  const canvas = page.getByTestId('performance-canvas');

  // Before audio runs, resizes and focus changes are kept, not pushed: no rewinds pile up.
  await dragGrip(page, -30, 20);
  await canvas.focus();
  await canvas.blur();
  expect(await page.evaluate(() => window.flowPatcher!.stats.pushes)).toBe(0);

  // The first tap focuses the canvas and starts audio; then the size and a Focus catch up.
  await canvas.click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  let size = await cssSize(page);
  await expect.poll(() => signal(page, 'width'), { timeout: 5000 }).toBeCloseTo(size.width, 3);
  await expect.poll(() => signal(page, 'height')).toBeCloseTo(size.height, 3);
  await expect.poll(() => signal(page, 'aspect')).toBeCloseTo(size.width / size.height, 3);
  await expect.poll(() => count(page, 'focus')).toBe(1);
  expect(await count(page, 'blur')).toBe(0);

  // Resizing the pane while playing moves Width, Height and Aspect.
  await dragGrip(page, -120, 60);
  const resized = await cssSize(page);
  expect(resized.width).toBeGreaterThan(size.width + 100);
  size = resized;
  await expect.poll(() => signal(page, 'width')).toBeCloseTo(size.width, 3);
  await expect.poll(() => signal(page, 'height')).toBeCloseTo(size.height, 3);
  await expect.poll(() => signal(page, 'aspect')).toBeCloseTo(size.width / size.height, 3);

  // Escape returns the keyboard to the editor: a Blur. Focusing again: a Focus.
  await canvas.press('Escape');
  await expect.poll(() => count(page, 'blur')).toBe(1);
  await canvas.focus();
  await expect.poll(() => count(page, 'focus')).toBe(2);

  // The page hidden, then shown.
  await setVisibility(page, 'hidden');
  await expect.poll(() => count(page, 'hidden')).toBe(1);
  await setVisibility(page, 'visible');
  await expect.poll(() => count(page, 'visible')).toBe(1);

  // Each change came once.
  expect(await Promise.all(EVENT_PORTS.map((port) => count(page, port)))).toEqual([2, 1, 1, 1]);
  await page.getByTestId('preview').screenshot({ path: 'test-results/canvas.png' });

  // A Canvas added while playing is sent the size once its swap lands (#76 review): pushed at once,
  // the size usually reached a window the new node wasn't in yet, and Width stayed 0.
  // An empty spot on the editor: the first point on a grid where nothing covers the pane.
  const spot = await page.evaluate(() => {
    for (let y = window.innerHeight - 40; y > 80; y -= 40) {
      for (let x = 40; x < window.innerWidth; x += 40) if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
    }
    return null;
  });
  await page.mouse.dblclick(spot!.x, spot!.y);
  const palette = page.getByTestId('node-palette');
  await expect(palette).toBeVisible();
  await page.keyboard.type('canvas');
  await palette.locator('[data-node-type="canvas"]').click();
  await expect(page.getByTestId('compile-status')).toHaveText('9 nodes compiled');
  await page.evaluate(() => void window.flowPatcher!.watchProbe('canvas-1', 'width', 'out', 'signal', () => {}));
  await expect.poll(() => page.evaluate(() => window.flowPatcher!.probe('canvas-1', 'width')?.value), { timeout: 5000 }).toBeCloseTo(size.width, 3);
  expect(errors).toEqual([]);
});
