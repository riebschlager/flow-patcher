import { expect, test } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
  }
}

// Gate check First touch (docs/milestones.md, M2): on a fresh page, the first
// pointerdown both resumes the AudioContext and produces its note.
test('First touch: the first pointerdown starts audio and still sounds', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/?patch=pointer-notes');
  await expect(page.getByTestId('compile-status')).toHaveText('4 nodes compiled');
  await expect(page.getByTestId('audio-state')).toHaveText('tap to start');
  expect(await page.evaluate(() => window.flowPatcher!.status.audio)).not.toBe('running');

  const box = (await page.getByTestId('performance-canvas').boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  await expect.poll(() => page.evaluate(() => window.flowPatcher!.taps[0]?.note ?? null)).not.toBeNull();
  await page.mouse.up();

  const [first] = await page.evaluate(() => window.flowPatcher!.taps);
  expect(first!.cold).toBe(true);
  expect(errors).toEqual([]);
});

test('the canvas keeps touches and, once played, the keyboard; Escape returns to the editor', async ({ page }) => {
  await page.goto('/?patch=pointer-notes');
  await expect(page.getByTestId('compile-status')).toHaveText('4 nodes compiled');
  const canvas = page.getByTestId('performance-canvas');
  expect(await canvas.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
  // No source here reads right-clicks, so the browser's context menu stays (suppressing it is tested with Click, #75).
  const suppressed = await canvas.evaluate((el) => !el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })));
  expect(suppressed).toBe(false);

  // Select a node, then play the canvas: Backspace goes to the canvas, not to the editor's delete.
  const nodes = page.getByTestId('patch-node');
  await expect(nodes).toHaveCount(4);
  await nodes.first().locator('.patch-node__header').click();
  await canvas.click({ position: { x: 40, y: 40 } });
  await expect(canvas).toBeFocused();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Tab');
  await expect(nodes).toHaveCount(4);
  await expect(page.getByTestId('node-palette')).toHaveCount(0);

  // Keyup still reaches the document, where React Flow tracks held keys (Space to pan, Shift to select).
  const keyups = await page.evaluateHandle(() => {
    const seen: string[] = [];
    document.addEventListener('keyup', (event) => seen.push(event.key));
    return seen;
  });
  await canvas.focus();
  await page.keyboard.press('Shift');
  expect(await keyups.evaluate((seen) => seen)).toEqual(['Shift']);

  // Escape hands the keys back: the editor's delete works again.
  await canvas.focus();
  await page.keyboard.press('Escape');
  await expect(canvas).not.toBeFocused();
  await nodes.first().locator('.patch-node__header').click();
  await page.keyboard.press('Backspace');
  await expect(nodes).toHaveCount(3);
});
