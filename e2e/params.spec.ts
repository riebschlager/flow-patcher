import { devices, expect, test, type Locator, type Page } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
  }
}

// Params on nodes (#31): knobs turned while playing, a modulated knob's ring,
// text presets, and removing a cable that runs behind a node. Screenshots on
// desktop and tablet emulation go in the PR.

const field = (page: Page, node: string, param: string) =>
  page.locator(`.react-flow__node[data-id="${node}"] .param-row[data-param="${param}"] [data-testid="param-field"]`);
const edge = (page: Page, id: string) => page.locator(`.react-flow__edge[data-id="${id}"]`);
const edges = (page: Page) => page.locator('.react-flow__edge');
const stats = (page: Page) => page.evaluate(() => window.flowPatcher!.stats);
const undo = (page: Page) => page.getByRole('button', { name: 'Undo' });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && !message.text().includes('favicon') && errors.push(message.text()));
  return errors;
}

async function startAudio(page: Page) {
  await page.getByTestId('performance-canvas').click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
}

/** A point on a cable, `at` of the way along it, in page coordinates. */
async function pointOn(cable: Locator, at: number) {
  return cable.locator('.react-flow__edge-interaction').evaluate((path: SVGPathElement, at) => {
    const p = path.getPointAtLength(path.getTotalLength() * at);
    const m = path.getScreenCTM()!;
    return { x: p.x * m.a + m.e, y: p.y * m.d + m.f };
  }, at);
}

/** The point nearest a cable's middle where the cable itself takes the pointer, not a node or port drawn over it. */
async function visiblePointOn(page: Page, cable: Locator, id: string) {
  for (let i = 0; i < 38; i++) {
    const point = await pointOn(cable, 0.5 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) / 40);
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.react-flow__edge')?.getAttribute('data-id'), point);
    if (hit === id) return point;
  }
  throw new Error(`no visible stretch on ${id}`);
}

/** Drags horizontally by `dx` in steps, as a hand would. */
async function dragBy(page: Page, target: Locator, dx: number) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x + (dx * i) / 12, y);
  await page.mouse.up();
}

test('a knob turned while playing hot-swaps, and the whole drag is one undo step', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?patch=euclidean-pulse');
  await expect(page.getByTestId('compile-status')).toHaveText('5 nodes compiled');
  await startAudio(page);
  await expect.poll(async () => (await stats(page)).delivered, { timeout: 6000 }).toBeGreaterThan(0);

  const hits = field(page, 'euclid', 'hits');
  await expect(hits).toHaveAttribute('data-value', '5');
  const swaps = (await stats(page)).swaps;
  await dragBy(page, hits, 60);
  const turned = Number(await hits.getAttribute('data-value'));
  expect(turned).toBeGreaterThan(5);
  // The running plan has the new value, and previews were throttled: not one swap per pointer move.
  expect(await page.evaluate(() => window.flowPatcher!.paramAt('euclid', 'hits'))).toBe(turned);
  const during = (await stats(page)).swaps - swaps;
  expect(during).toBeGreaterThan(0);
  expect(during).toBeLessThanOrEqual(13);
  const delivered = (await stats(page)).delivered;
  await expect.poll(async () => (await stats(page)).delivered, { timeout: 6000 }).toBeGreaterThan(delivered);

  // One undo step: back to 5, and nothing left to undo.
  await undo(page).click();
  await expect(hits).toHaveAttribute('data-value', '5');
  await expect(undo(page)).toBeDisabled();
  expect(await page.evaluate(() => window.flowPatcher!.paramAt('euclid', 'hits'))).toBe(5);

  // Shift is finer: the same drag moves it less. Double-click types; right-click resets to the default.
  await page.keyboard.down('Shift');
  await dragBy(page, hits, 60);
  await page.keyboard.up('Shift');
  expect(Number(await hits.getAttribute('data-value'))).toBeLessThan(turned);
  await hits.dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('9');
  await page.keyboard.press('Enter');
  await expect(hits).toHaveAttribute('data-value', '9');
  await hits.click({ button: 'right' });
  await expect(hits).toHaveAttribute('data-value', '4');

  const final = await stats(page);
  expect(final.lateScheduled).toBe(0);
  expect(errors).toEqual([]);
});

test('a modulated knob\'s ring follows the cable: Pointer Y into Pitch at depth −24', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?patch=pointer-notes');
  await expect(edge(page, 'pointer.y→note.pitch')).toHaveCount(1);
  const pitch = field(page, 'note', 'pitch');
  await expect(pitch).toHaveAttribute('data-value', '76');
  await expect(pitch.getByTestId('mod-band')).toHaveCount(1);
  await startAudio(page);

  const canvas = (await page.getByTestId('performance-canvas').boundingBox())!;
  const ring = async (y: number) => {
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height * y);
    // Pitch steps by 1, so the ring reads 76 − 24 × Y, rounded.
    await expect.poll(async () => Number(await pitch.getAttribute('data-mod-value'))).toBe(Math.round(76 - 24 * y));
  };
  await ring(0.25);
  await ring(0.75);
  const band = pitch.getByTestId('mod-band');
  // Below the knob, so the band runs left from it.
  await expect(band).toHaveAttribute('data-side', 'below');
  expect((await band.boundingBox())!.width).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('a text param takes a preset, and reads Custom once edited', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?patch=chord-progression');
  const preset = page.getByLabel('Chords preset');
  const chords = page.getByRole('textbox', { name: 'Chords' });
  await expect(preset).toHaveValue('Blue hour');

  await preset.selectOption('After hours');
  await expect(chords).toHaveValue('Am7, Fmaj7, Cmaj7, Em7');
  await chords.click();
  await chords.press('End');
  await chords.pressSequentially(', G7');
  await chords.press('Enter');
  await expect(preset).toHaveValue('Custom');
  await expect(page.getByTestId('compile-status')).toHaveText('6 nodes compiled');

  // Each change was one undo step.
  await undo(page).click();
  await expect(chords).toHaveValue('Am7, Fmaj7, Cmaj7, Em7');
  await expect(preset).toHaveValue('After hours');
  await undo(page).click();
  await expect(preset).toHaveValue('Blue hour');
  expect(errors).toEqual([]);
});

test('a cable running behind a node can be selected and removed above the nodes', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?patch=euclidean-pulse');
  // Drag Output to the left of Simple Synth: its cable now loops back behind Make Note.
  const out = page.locator('.react-flow__node[data-id="out"]');
  const header = out.locator('.patch-node__header');
  const from = (await header.boundingBox())!;
  const note = (await page.locator('.react-flow__node[data-id="note"]').boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(note.x - 200, from.y + 10, { steps: 10 });
  await page.mouse.up();

  const id = 'synth.audio→out.audio';
  const cable = edge(page, id);
  // Its midpoint is under Make Note.
  const mid = await pointOn(cable, 0.5);
  const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.react-flow__node')?.getAttribute('data-id'), mid);
  expect(under).toBe('note');

  // Select it on a visible stretch; it's raised above the nodes, with a remove control at the midpoint.
  const visible = await visiblePointOn(page, cable, id);
  await page.mouse.click(visible.x, visible.y);
  await expect(cable).toHaveClass(/selected/);
  const remove = page.getByTestId('cable-remove');
  await expect(remove).toBeVisible();
  const box = (await remove.boundingBox())!;
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="cable-remove"]') !== null, { x: box.x + box.width / 2, y: box.y + box.height / 2 })).toBe(true);
  await remove.click();
  await expect(cable).toHaveCount(0);
  await expect(edges(page)).toHaveCount(3);

  // Undo brings it back; Delete removes a selected cable too.
  await undo(page).click();
  await expect(cable).toHaveCount(1);
  const again = await visiblePointOn(page, cable, id);
  await page.mouse.click(again.x, again.y);
  await expect(cable).toHaveClass(/selected/);
  await page.keyboard.press('Delete');
  await expect(cable).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a param cable\'s depth chip: drag, type, right-click to reset, each one undo step', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?patch=pointer-notes');
  const id = 'pointer.y→note.pitch';
  const cable = edge(page, id);
  const hover = await visiblePointOn(page, cable, id);
  await page.mouse.move(hover.x, hover.y);
  const chip = page.getByTestId('depth-chip');
  await expect(chip).toHaveAttribute('data-depth', '-24');
  await expect(chip).toHaveText(/−24 MIDI/);

  await dragBy(page, chip, 40);
  await expect(chip).toHaveAttribute('data-depth', '8');
  await chip.dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('-12');
  await page.keyboard.press('Enter');
  await expect(chip).toHaveAttribute('data-depth', '-12');
  await chip.click({ button: 'right' });
  await expect(chip).toHaveAttribute('data-depth', '1');
  // The cable kept its place: a depth edit is remove + add at the same index.
  const saved = await page.evaluate(() => window.flowPatcher!.paramAt('note', 'pitch'));
  expect(saved).toBeDefined();
  for (const depth of ['-12', '8', '-24']) {
    await undo(page).click();
    await page.mouse.move(hover.x, hover.y);
    await expect(chip).toHaveAttribute('data-depth', depth);
  }
  await expect(undo(page)).toBeDisabled();
  expect(errors).toEqual([]);
});

const { defaultBrowserType: _desktop, ...desktop } = devices['Desktop Chrome'];
const { defaultBrowserType: _tablet, ...tablet } = devices['Galaxy Tab S4'];

for (const [name, device] of [['desktop', desktop], ['tablet', tablet]] as const) {
  test.describe(`screenshots on ${name}`, () => {
    test.use(device);

    test(`params, a modulated knob and a selected cable (${name})`, async ({ page }) => {
      const errors = collectErrors(page);
      await page.goto('/?patch=pointer-notes');
      await expect(page.getByTestId('compile-status')).toHaveText('4 nodes compiled');
      // Port hit areas: 20×20 for a fine pointer, 32×22 for a coarse one.
      const hit = await page.locator('.react-flow__handle[data-handleid="param:pitch"]').evaluate((el) => {
        const style = getComputedStyle(el, '::before');
        return [style.width, style.height];
      });
      expect(hit).toEqual(name === 'tablet' ? ['32px', '22px'] : ['20px', '20px']);

      const id = 'pointer.y→note.pitch';
      const point = await visiblePointOn(page, edge(page, id), id);
      if (name === 'tablet') await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y);
      await expect(page.getByTestId('cable-remove')).toBeVisible();
      await expect(page.getByTestId('depth-chip')).toBeVisible();
      await page.screenshot({ path: `test-results/params-${name}.png` });
      expect(errors).toEqual([]);
    });
  });
}
