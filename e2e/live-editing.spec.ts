import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { nodeDefinitions } from '@flow-patcher/nodes';
import type { LivePatch } from '../packages/editor/src/live';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
  }
}

// Live editing (#30): build a patch from the palette while it plays, edit it,
// undo, save, and open the file again in a fresh page.

/** Picks `type` from the open palette after searching for `search`. */
async function pick(page: Page, search: string, type: string) {
  const palette = page.getByTestId('node-palette');
  await expect(palette).toBeVisible();
  await page.keyboard.type(search);
  await palette.locator(`[data-node-type="${type}"]`).click();
  await expect(palette).toHaveCount(0);
}

const handle = (page: Page, node: string, port: string, kind: 'source' | 'target') =>
  page.locator(`.react-flow__handle[data-nodeid="${node}"][data-handleid="${port}"].${kind}`);

/** Drags a cable from one handle to another, or to a point on the canvas. */
async function cable(page: Page, from: ReturnType<typeof handle>, to: ReturnType<typeof handle> | { x: number; y: number }) {
  const a = (await from.boundingBox())!;
  const b = 'x' in to ? { x: to.x, y: to.y, width: 0, height: 0 } : (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 30, { steps: 8 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
}

const edges = (page: Page) => page.locator('.react-flow__edge');
const stats = (page: Page) => page.evaluate(() => window.flowPatcher!.stats);

test('builds a patch from the palette while it plays, edits, undoes, saves and opens it again', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && !message.text().includes('favicon') && errors.push(message.text()));

  await page.goto('/?patch=new');
  await expect(page.getByTestId('compile-status')).toHaveText('0 nodes compiled');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();

  // Nodes from the palette: double-click and Tab, searched by name.
  await page.mouse.dblclick(80, 440);
  // Unsearched, it's the whole catalog, grouped by family.
  await expect(page.getByTestId('node-palette').locator('[data-node-type]')).toHaveCount(nodeDefinitions.length);
  await expect(page.getByTestId('node-palette').locator('.palette__group').first()).toHaveText('Sources');
  await pick(page, 'clock', 'clock');
  await page.mouse.move(320, 440);
  await page.keyboard.press('Tab');
  await pick(page, 'eucl', 'euclidean');
  await page.mouse.dblclick(560, 440);
  await expect(page.getByRole('textbox', { name: 'Search nodes' })).toBeFocused();
  await page.keyboard.type('make note');
  await page.keyboard.press('Enter');
  await page.mouse.dblclick(1040, 440);
  await pick(page, 'output', 'output');
  await expect(page.getByTestId('patch-node')).toHaveCount(4);

  await cable(page, handle(page, 'clock-1', 'tick', 'source'), handle(page, 'euclidean-1', 'tick', 'target'));
  await cable(page, handle(page, 'euclidean-1', 'hit', 'source'), handle(page, 'make-note-1', 'trigger', 'target'));
  // A cable dropped on empty canvas opens the palette filtered to what takes it, and wires the pick.
  await cable(page, handle(page, 'make-note-1', 'note', 'source'), { x: 800, y: 560 });
  await expect(page.getByTestId('palette-accepts')).toHaveText('Accepts note');
  await expect(page.getByTestId('node-palette').locator('[data-node-type="clock"]')).toHaveCount(0);
  await pick(page, 'sampled', 'sampled-voice');
  await cable(page, handle(page, 'sampled-voice-1', 'audio', 'source'), handle(page, 'output-1', 'audio', 'target'));
  await expect(edges(page)).toHaveCount(4);
  await expect(page.getByTestId('compile-status')).toHaveText('5 nodes compiled');

  // Incompatible ports don't connect.
  await cable(page, handle(page, 'clock-1', 'phase', 'source'), handle(page, 'output-1', 'audio', 'target'));
  await expect(edges(page)).toHaveCount(4);
  // A loop without a Delay Edge is refused, and the refused cable shows why.
  await cable(page, handle(page, 'euclidean-1', 'hit', 'source'), handle(page, 'euclidean-1', 'tick', 'target'));
  await expect(page.getByTestId('cable-refused')).toHaveCount(1);
  await expect(page.getByText('Needs a Delay Edge')).toBeVisible();
  await expect(page.getByTestId('cable-refused')).toHaveCount(0);
  await expect(edges(page)).toHaveCount(4);
  await page.screenshot({ path: 'test-results/live-editing-built.png' });

  // Play: the first tap starts audio, and the patch reaches the voice.
  await page.getByTestId('performance-canvas').click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  // Euclidean's default 4 of 16 on quarter notes hits every 2 s.
  await expect.poll(async () => (await stats(page)).delivered, { timeout: 6000 }).toBeGreaterThan(0);
  expect((await stats(page)).swaps).toBeGreaterThan(0);

  // Edit while it plays: remove the Euclidean → Make Note cable, then undo and redo it.
  const swaps = (await stats(page)).swaps;
  const edge = page.locator('.react-flow__edge[data-id="euclidean-1.hit→make-note-1.trigger"]');
  await edge.click({ force: true });
  await page.keyboard.press('Delete');
  await expect(edges(page)).toHaveCount(3);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(edges(page)).toHaveCount(4);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(edges(page)).toHaveCount(3);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(edges(page)).toHaveCount(4);
  expect((await stats(page)).swaps).toBe(swaps + 4);
  // Removing a node takes its cables, and undo puts all of it back.
  await page.locator('.react-flow__node[data-id="make-note-1"]').click();
  await page.keyboard.press('Backspace');
  await expect(page.getByTestId('patch-node')).toHaveCount(4);
  await expect(edges(page)).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('patch-node')).toHaveCount(5);
  await expect(edges(page)).toHaveCount(4);
  await expect(page.getByTestId('compile-status')).toHaveText('5 nodes compiled');
  // An arrow-key nudge is an undo step of its own.
  const clock = page.locator('.react-flow__node[data-id="clock-1"]');
  const before = await clock.boundingBox();
  await clock.click();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await clock.boundingBox())!.x).toBeGreaterThan(before!.x);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await clock.boundingBox())!.x).toBe(before!.x);
  await page.screenshot({ path: 'test-results/live-editing-edited.png' });

  // Save, open the file in a fresh page, and save again: the same document.
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save' }).click();
  const first = await readFile((await (await saved).path())!, 'utf8');
  expect(JSON.parse(first).nodes.map((n: { type: string }) => n.type)).toEqual(['clock', 'euclidean', 'make-note', 'output', 'sampled-voice']);

  await page.goto('/?patch=new');
  await expect(page.getByTestId('patch-node')).toHaveCount(0);
  // A file that wouldn't run is refused whole.
  const broken = JSON.parse(first);
  broken.nodes[0].type = 'no-such-node';
  await page.getByTestId('open-file').setInputFiles({ name: 'broken.flowpatch', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(broken)) });
  await expect(page.getByTestId('compile-status')).toContainText("Couldn't open broken.flowpatch");
  await expect(page.getByTestId('patch-node')).toHaveCount(0);
  // A loop with no delay (the one the editor refused above) opens, so it can be fixed: its nodes say why it isn't running.
  const loop = JSON.parse(first);
  loop.cables.push({ from: { node: 'euclidean-1', port: 'hit' }, to: { node: 'euclidean-1', port: 'tick' } });
  await page.getByTestId('open-file').setInputFiles({ name: 'loop.flowpatch', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(loop)) });
  await expect(page.getByTestId('compile-status')).toHaveText('A loop has no delay: still playing the last patch that ran');
  await expect(page.getByTestId('patch-node')).toHaveCount(5);
  await expect(page.locator('.react-flow__node[data-id="euclidean-1"] [data-testid="node-status"]')).toContainText('In a loop with no delay');
  await expect(page.locator('[data-testid="node-status"][data-status="error"]')).toHaveCount(1);
  // Taking the node out of the loop fixes it.
  await page.locator('.react-flow__node[data-id="euclidean-1"] .patch-node__header').click();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('compile-status')).toHaveText('4 nodes compiled');
  await expect(page.locator('[data-testid="node-status"][data-status="error"]')).toHaveCount(0);
  await page.getByTestId('open-file').setInputFiles({ name: 'patch.flowpatch', mimeType: 'application/json', buffer: Buffer.from(first) });
  await expect(page.getByTestId('patch-node')).toHaveCount(5);
  await expect(edges(page)).toHaveCount(4);
  await expect(page.getByTestId('compile-status')).toHaveText('5 nodes compiled');
  const again = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save' }).click();
  expect(await readFile((await (await again).path())!, 'utf8')).toBe(first);
  await page.screenshot({ path: 'test-results/live-editing-reopened.png' });

  expect(errors).toEqual([]);
});

test('the palette scrolls to the row the arrow keys pick, and a Signal dropped on the canvas can go into a knob', async ({ page }) => {
  await page.goto('/?patch=new');
  const palette = page.getByTestId('node-palette');

  // Arrow keys far past the rows that fit: the picked row is scrolled into view, and Enter inserts it.
  await page.mouse.dblclick(200, 300);
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
  const picked = palette.locator('[aria-selected="true"]');
  await expect(picked).toBeInViewport();
  const type = await picked.getAttribute('data-node-type');
  await page.keyboard.press('Enter');
  await expect(page.locator(`.react-flow__node[data-id="${type}-1"]`)).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('patch-node')).toHaveCount(0);

  // Filter takes a Signal only on its Cutoff knob; the palette still offers it and wires the knob.
  await page.mouse.dblclick(200, 300);
  await pick(page, 'pointer', 'pointer');
  await cable(page, handle(page, 'pointer-1', 'x', 'source'), { x: 700, y: 320 });
  await expect(page.getByTestId('palette-accepts')).toHaveText('Accepts signal');
  await pick(page, 'filter', 'filter');
  await expect(handle(page, 'filter-1', 'param:cutoff', 'target')).toBeVisible();
  await expect(edges(page)).toHaveCount(1);
  await expect(page.getByTestId('rf__edge-pointer-1.x→filter-1.cutoff')).toHaveCount(1);
});
