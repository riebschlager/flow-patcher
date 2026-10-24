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
  await dragBy(page, hits, 60);
  const turned = Number(await hits.getAttribute('data-value'));
  expect(turned).toBeGreaterThan(5);
  // The running plan has the new value.
  expect(await page.evaluate(() => window.flowPatcher!.paramAt('euclid', 'hits'))).toBe(turned);
  await undo(page).click();
  await expect(hits).toHaveAttribute('data-value', '5');

  // Previews are throttled to one per animation frame: 50 moves and the drop in one task make one swap, the drop's.
  // Unthrottled, each new snapped value (about ten over 50 px) would swap.
  const box = (await hits.boundingBox())!;
  const swaps = (await stats(page)).swaps;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(({ x, y }) => {
    for (let i = 1; i <= 50; i++) window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: x + i, clientY: y }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: x + 50, clientY: y }));
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await page.mouse.up();
  expect((await stats(page)).swaps - swaps).toBe(1);
  expect(Number(await hits.getAttribute('data-value'))).toBeGreaterThan(5);
  const delivered = (await stats(page)).delivered;
  await expect.poll(async () => (await stats(page)).delivered, { timeout: 6000 }).toBeGreaterThan(delivered);

  // Each drag was one undo step: back to 5, and nothing left to undo.
  await undo(page).click();
  await expect(hits).toHaveAttribute('data-value', '5');
  await expect(undo(page)).toBeDisabled();
  expect(await page.evaluate(() => window.flowPatcher!.paramAt('euclid', 'hits'))).toBe(5);

  // Shift is finer: the same drag moves it less. Double-click types; right-click resets to the default.
  await page.keyboard.down('Shift');
  await dragBy(page, hits, 60);
  await page.keyboard.up('Shift');
  // It moved at all: React Flow's selection pane used to take the Shift press for a selection box (#104).
  await expect.poll(async () => Number(await hits.getAttribute('data-value'))).toBeGreaterThan(5);
  expect(Number(await hits.getAttribute('data-value'))).toBeLessThan(turned);
  await hits.dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('9');
  await page.keyboard.press('Enter');
  await expect(hits).toHaveAttribute('data-value', '9');
  await hits.click({ button: 'right' });
  await expect(hits).toHaveAttribute('data-value', '4');
  // Escape throws typed text away; the keyboard steps the slider.
  await hits.dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('20');
  await page.keyboard.press('Escape');
  await expect(hits).toHaveAttribute('data-value', '4');
  await hits.focus();
  await page.keyboard.press('ArrowRight');
  await expect(hits).toHaveAttribute('data-value', '5');
  await expect(hits).toHaveAttribute('aria-valuetext', '5');
  // Enter types, and focus comes back to the slider; Tab moves on to the next param instead of opening the palette.
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('6');
  await page.keyboard.press('Enter');
  await expect(hits).toHaveAttribute('data-value', '6');
  await expect(hits).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(field(page, 'euclid', 'steps')).toBeFocused();
  await expect(page.getByTestId('node-palette')).toHaveCount(0);

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
  // The chip shrank and re-centred under the drag: point at it again before it hides.
  await page.mouse.move(hover.x, hover.y);
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

test('a log-scaled knob turns by ratio, types and reads in Hz, and its cable depth reads in octaves (ADR 0032)', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?patch=filter-sweep');
  await expect(page.getByTestId('compile-status')).toHaveText('6 nodes compiled');
  const cutoff = field(page, 'filter', 'cutoff');
  await expect(cutoff).toHaveAttribute('data-value', '300');
  await expect(cutoff.locator('.param-field__value')).toHaveText('300 Hz');
  // 20 Hz–20 kHz is a factor of 1000 across the field: the fill sits at log(300 / 20) / log(1000) of it, 39 %.
  const width = (await cutoff.boundingBox())!.width;
  const fill = (await cutoff.locator('.param-field__fill').boundingBox())!.width;
  expect(fill / width).toBeCloseTo(Math.log(15) / Math.log(1000), 2);

  // Two equal drags give equal ratios, not equal differences: each multiplies by 1000^(dx / width).
  const dx = 40, factor = 1000 ** (dx / width);
  const value = async () => Number(await cutoff.getAttribute('data-value'));
  await dragBy(page, cutoff, dx);
  await expect.poll(value).not.toBe(300);
  const first = await value();
  await dragBy(page, cutoff, dx);
  await expect.poll(value).not.toBe(first);
  const second = await value();
  // Snapped to three significant figures, so within 1 %.
  expect(first / 300).toBeCloseTo(factor, 1);
  expect(Math.abs(first / 300 / factor - 1)).toBeLessThan(0.01);
  expect(Math.abs(second / first / factor - 1)).toBeLessThan(0.01);
  // A linear knob would have added the same Hz twice: (dx / width) × 19,980 Hz each time.
  expect(second - first).toBeGreaterThan((first - 300) * 1.3);
  // Shift is five times finer, by ratio too.
  await page.keyboard.down('Shift');
  await dragBy(page, cutoff, -dx);
  await page.keyboard.up('Shift');
  await expect.poll(value).not.toBe(second);
  expect(Math.abs(second / (await value()) / factor ** 0.2 - 1)).toBeLessThan(0.01);

  // Typing stays in Hz: the field opens on the stored number, and takes Hz or kHz.
  const stored = await value();
  await cutoff.dblclick();
  const input = page.locator('.react-flow__node[data-id="filter"] .param-row[data-param="cutoff"] input');
  await expect(input).toHaveValue(String(stored));
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('440');
  await page.keyboard.press('Enter');
  await expect(cutoff).toHaveAttribute('data-value', '440');
  await expect(cutoff.locator('.param-field__value')).toHaveText('440 Hz');
  await cutoff.dblclick();
  await expect(input).toHaveValue('440');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('1.2 kHz');
  await page.keyboard.press('Enter');
  await expect(cutoff).toHaveAttribute('data-value', '1200');
  await expect(cutoff.locator('.param-field__value')).toHaveText('1.2 kHz');
  await expect(cutoff).toHaveAttribute('aria-valuetext', '1.2 kHz');

  // The modulated value's band runs from the knob to the value's place on the same log travel.
  await startAudio(page);
  const band = cutoff.getByTestId('mod-band');
  await expect.poll(async () => Number(await cutoff.getAttribute('data-mod-value'))).toBeGreaterThan(1200);
  const placed = await cutoff.evaluate((el) => {
    const box = el.getBoundingClientRect(), b = el.querySelector('[data-testid="mod-band"]')!.getBoundingClientRect();
    return { now: Number(el.getAttribute('data-mod-value')), left: (b.left - box.left) / box.width, right: (b.right - box.left) / box.width };
  });
  const at = (hz: number) => Math.log(hz / 20) / Math.log(1000);
  expect(placed.left).toBeCloseTo(at(1200), 2);
  // The band is redrawn every frame while the sweep moves, so its end can lag the attribute by a frame.
  expect(Math.abs(placed.right - at(placed.now))).toBeLessThan(0.03);
  await expect(band).toHaveAttribute('data-side', 'above');

  // The depth chip on the sweep's cable reads octaves, reaches ±log2(1000), and types in octaves.
  const id = 'sweep.phase→filter.cutoff';
  const hover = await visiblePointOn(page, edge(page, id), id);
  await page.mouse.move(hover.x, hover.y);
  const chip = page.getByTestId('depth-chip');
  await expect(chip).toHaveAttribute('data-depth', '3.17');
  await expect(chip).toHaveText(/\+3\.17 oct/);
  expect(Number(await chip.getAttribute('aria-valuemax'))).toBeCloseTo(Math.log2(1000), 6);
  // For the PR: the Filter with its log-scaled cutoff, the modulation band and the depth chip in octaves.
  const node = (await page.locator('.react-flow__node[data-id="filter"]').boundingBox())!, chipBox = (await chip.boundingBox())!;
  const left = Math.min(node.x, chipBox.x) - 24, top = node.y - 24;
  await page.screenshot({ path: 'test-results/log-knob.png', clip: { x: left, y: top, width: Math.max(node.x + node.width, chipBox.x + chipBox.width) + 24 - left, height: Math.max(node.y + node.height, chipBox.y + chipBox.height) + 24 - top } });
  await chip.dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('-1.5');
  await page.keyboard.press('Enter');
  await page.mouse.move(hover.x, hover.y);
  await expect(chip).toHaveAttribute('data-depth', '-1.5');
  await expect(chip).toHaveText(/−1\.50 oct/);
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
