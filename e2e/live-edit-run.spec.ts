import { expect, test, type Locator, type Page } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';
import { installBurstProbe } from './audio-burst';
import { audioCallback, stepLog } from './audio-clock';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
    /** start() calls this spec saw with a time already in the past. */
    lateStarts?: { when: number; currentTime: number }[];
    starts?: number;
  }
}

// Gate check No late events (docs/milestones.md, M1): scripted edits on the
// playing M1 demo (knob changes, cable add/remove, node add/remove, and taps).
// No scheduled event is handed to Web Audio with time < currentTime, and an
// immediate-path event is at most one audio clock step late (ADR 0027). Two
// witnesses: the runtime's late counters (an event before the clock at
// hand-over is clamped and counted) and every AudioScheduledSourceNode.start()
// the page makes.

const ROUNDS = 7;

const field = (page: Page, node: string, param: string) =>
  page.locator(`.react-flow__node[data-id="${node}"] .param-row[data-param="${param}"] [data-testid="param-field"]`);
const handle = (page: Page, node: string, port: string, kind: 'source' | 'target') =>
  page.locator(`.react-flow__handle[data-nodeid="${node}"][data-handleid="${port}"].${kind}`);
const edge = (page: Page, id: string) => page.locator(`.react-flow__edge[data-id="${id}"]`);
const stats = (page: Page) => page.evaluate(() => window.flowPatcher!.stats);

/** Drags horizontally by `dx` in steps, as a hand would. */
async function dragBy(page: Page, target: Locator, dx: number) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x + (dx * i) / 12, y);
  await page.mouse.up();
}

/** Drags a cable from one handle to another. */
async function cable(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!, b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 30, { steps: 8 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
}

/** Waits for the edit's swap, so each edit is its own plan change. */
async function swapped(page: Page, before: number) {
  await expect.poll(async () => (await stats(page)).swaps).toBeGreaterThan(before);
}

test('scripted edits on the playing demo hand no scheduled event late, and no tap note more than one clock step late', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && !message.text().includes('favicon') && errors.push(message.text()));

  await page.addInitScript(() => {
    window.lateStarts = [];
    window.starts = 0;
    // AudioBufferSourceNode declares its own start(when, offset, duration), shadowing the base one.
    for (const proto of [AudioScheduledSourceNode.prototype, AudioBufferSourceNode.prototype]) {
      if (!Object.prototype.hasOwnProperty.call(proto, 'start')) continue;
      const start = proto.start as (this: AudioScheduledSourceNode, when?: number, ...rest: number[]) => void;
      proto.start = function (this: AudioScheduledSourceNode, when?: number, ...rest: number[]) {
        const now = this.context.currentTime;
        window.starts!++;
        // start(0) or no time means "now"; anything else before currentTime was handed over late.
        if (when !== undefined && when > 0 && when < now) window.lateStarts!.push({ when, currentTime: now });
        return start.call(this, when, ...rest);
      };
    }
  });

  await installBurstProbe(page);
  await page.goto('/?patch=m1-demo');
  await expect(page.getByTestId('compile-status')).toHaveText('12 nodes compiled');
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  const canvas = page.getByTestId('performance-canvas');
  await canvas.click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  await expect(page.locator('[data-node-type="sampled-voice"] [data-testid="node-status"]')).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(async () => (await stats(page)).delivered, { timeout: 6000 }).toBeGreaterThan(4);
  const first = await stats(page);

  let edits = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const sign = round % 2 ? -1 : 1;

    // Knob changes: tempo, the rhythm's hits and the beat's velocity.
    for (const [node, param, dx] of [['clock', 'bpm', 30], ['euclidean', 'hits', 25], ['beat-tone', 'velocity', 20]] as const) {
      const before = (await stats(page)).swaps;
      await dragBy(page, field(page, node, param), sign * dx);
      await swapped(page, before);
      edits++;
    }

    // Cable remove and add: the beat's Splat comes off its hit and goes back on.
    let before = (await stats(page)).swaps;
    await edge(page, 'euclidean.hit→beat-splat.at').click({ force: true });
    await page.keyboard.press('Delete');
    await expect(edge(page, 'euclidean.hit→beat-splat.at')).toHaveCount(0);
    await swapped(page, before);
    before = (await stats(page)).swaps;
    await cable(page, handle(page, 'euclidean', 'hit', 'source'), handle(page, 'beat-splat', 'at', 'target'));
    await expect(edge(page, 'euclidean.hit→beat-splat.at')).toHaveCount(1);
    await swapped(page, before);
    edits += 2;

    // Node add and remove: a Probability between the rhythm and the beat's Splat, wired, then deleted with its cables.
    before = (await stats(page)).swaps;
    // Empty canvas between Output and Fluid, wherever fitView put them.
    const above = (await page.locator('.react-flow__node[data-id="output"]').boundingBox())!;
    const below = (await page.locator('.react-flow__node[data-id="fluid"]').boundingBox())!;
    await page.mouse.dblclick(above.x + above.width / 2, (above.y + above.height + below.y) / 2);
    await expect(page.getByTestId('node-palette')).toBeVisible();
    await page.keyboard.type('probab');
    await page.getByTestId('node-palette').locator('[data-node-type="probability"]').click();
    const added = page.locator('.react-flow__node[data-id^="probability-"]');
    await expect(added).toHaveCount(1);
    const id = (await added.getAttribute('data-id'))!;
    await swapped(page, before);
    before = (await stats(page)).swaps;
    await cable(page, handle(page, 'euclidean', 'hit', 'source'), handle(page, id, 'in', 'target'));
    await swapped(page, before);
    before = (await stats(page)).swaps;
    await cable(page, handle(page, id, 'out', 'source'), handle(page, 'beat-splat', 'at', 'target'));
    await swapped(page, before);
    before = (await stats(page)).swaps;
    await added.locator('.patch-node__header').click();
    await page.keyboard.press('Delete');
    await expect(added).toHaveCount(0);
    await swapped(page, before);
    edits += 4;

    // A tap on the immediate path, mid-edit run.
    await canvas.click({ position: { x: 60 + round * 20, y: 60 } });
  }
  await expect(page.getByTestId('compile-status')).toHaveText('12 nodes compiled');
  // Let the last edits' windows play out.
  await page.waitForTimeout(500);

  const final = await stats(page);
  const audio = await page.evaluate(() => ({ starts: window.starts!, late: window.lateStarts! }));
  // One clock step (ADR 0027): the largest of baseLatency, the sampled step and the audio thread's largest burst.
  const steps = await audioCallback(page);
  const { step } = steps;
  // After hand-over, start() sees only the microseconds before the voice calls it; the runtime's clamp is the real lateness.
  const worstLate = Math.max(0, ...audio.late.map((s) => s.currentTime - s.when));
  console.log(
    `${edits} edits, ${final.swaps - first.swaps} swaps, ${final.pushes} pushes; ${final.delivered - first.delivered} events delivered, ${audio.starts} start() calls; ` +
      `late: ${final.lateScheduled} scheduled, ${final.lateImmediate} immediate (worst ${final.lateImmediateMaxMs.toFixed(2)} ms), ${final.lateCaughtUp} caught up (worst ${final.lateCaughtUpMaxMs.toFixed(2)} ms, its wake ran ${final.lateCaughtUpWakeMs.toFixed(2)} ms), ${audio.late.length} start() (worst ${(worstLate * 1000).toFixed(2)} ms); one step ${(step * 1000).toFixed(2)} ms (${stepLog(steps)}); ${final.skipped} windows skipped, ${final.pushFallbacks} push fallbacks`,
  );
  expect(edits).toBe(ROUNDS * 9);
  expect(final.swaps - first.swaps).toBeGreaterThanOrEqual(edits);
  expect(final.delivered).toBeGreaterThan(first.delivered);
  expect(audio.starts).toBeGreaterThan(0);
  expect(final.lateScheduled).toBe(0);
  // A tap's notes may reach Web Audio behind the clock, by at most one step (ADR 0027); Web Audio plays them at the next quantum.
  expect(final.lateImmediateMaxMs).toBeLessThanOrEqual(step * 1000 + 1e-3);
  // A caught-up event (any catch-up, the first tap's included; ADR 0033) may land behind the clock by a step plus its own wake's query and schedule().
  expect(final.lateCaughtUpMaxMs).toBeLessThanOrEqual(step * 1000 + final.lateCaughtUpWakeMs + 1e-3);
  expect(worstLate).toBeLessThanOrEqual(step + 1e-6);
  expect(final.skipped).toBe(0);
  expect(final.pushFallbacks).toBe(0);
  expect(final.uncancelled).toBe(0);

  await page.screenshot({ path: 'test-results/live-edit-run.png' });
  expect(errors).toEqual([]);
});
