import { devices, expect, test, type Page } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
  }
}

// Seeing what's happening (#32): the adapter offer in both directions, probes
// on hover and pinned, node warnings for an event cap and a voice steal, the
// "no transport" hint, and cables flashing on events. Screenshots on desktop
// and tablet emulation go in the PR.

const handle = (page: Page, node: string, port: string) => page.locator(`.react-flow__handle[data-nodeid="${node}"][data-handleid="${port}"]`);
const card = (page: Page, node: string) => page.locator(`.react-flow__node[data-id="${node}"]`);

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

/** Drags a cable from one handle onto another in steps, as a hand would. */
async function cable(page: Page, from: { node: string; port: string }, to: { node: string; port: string }) {
  const a = (await handle(page, from.node, from.port).boundingBox())!, b = (await handle(page, to.node, to.port).boundingBox())!;
  const x0 = a.x + a.width / 2, y0 = a.y + a.height / 2, x1 = b.x + b.width / 2, y1 = b.y + b.height / 2;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12);
  await page.mouse.up();
}

const cableIds = (page: Page) => page.getByTestId('cable').evaluateAll((els) => els.map((el) => el.getAttribute('data-cable')));

type FixtureNode = { id: string; type: string; params?: Record<string, unknown>; x: number; y: number };
const VERSIONS: Record<string, number> = { clock: 3, 'make-note': 2, 'simple-synth': 2, output: 2, progression: 1 };

/** A patch file built here, so these checks need no example patch or golden. */
function fixture(nodes: FixtureNode[], cables: [string, string, string, string][]) {
  return {
    format: 'flowpatch',
    version: 1,
    seed: 32,
    nodes: nodes.map(({ id, type, params = {}, x, y }) => ({ id, type, typeVersion: VERSIONS[type], params, position: { x, y } })),
    cables: cables.map(([a, from, b, to]) => ({ from: { node: a, port: from }, to: { node: b, port: to } })),
  };
}

async function open(page: Page, name: string, patch: object) {
  await page.goto('/?patch=new');
  await page.getByTestId('open-file').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(patch)) });
  await expect(page.getByTestId('compile-status')).toContainText('compiled');
}

/** The fastest a Clock ticks: 300 bpm × 4, on 1/32 notes (160 a second, about 19 per 120 ms window). */
const FAST = { bpm: 300, rate: 4, division: '1/32' };

/** 14 fast Clocks into one Make Note: about 270 events per 120 ms window, over the 256 cap. */
const capped = fixture(
  [...Array.from({ length: 14 }, (_, i) => ({ id: `clock-${i + 1}`, type: 'clock', params: FAST, x: (i % 2) * 220, y: Math.floor(i / 2) * 60 })), { id: 'note', type: 'make-note', x: 520, y: 160 }],
  Array.from({ length: 14 }, (_, i): [string, string, string, string] => [`clock-${i + 1}`, 'tick', 'note', 'trigger']),
);

/** A fast Clock playing 4 s notes: 640 voices wanted, 64 to go round. */
const stealing = fixture(
  [
    { id: 'clock', type: 'clock', params: FAST, x: 0, y: 100 },
    { id: 'note', type: 'make-note', params: { length: 4, velocity: 0.2 }, x: 240, y: 100 },
    { id: 'synth', type: 'simple-synth', params: { level: 0.05 }, x: 480, y: 100 },
    { id: 'out', type: 'output', x: 720, y: 100 },
  ],
  [['clock', 'tick', 'note', 'trigger'], ['note', 'note', 'synth', 'note'], ['synth', 'audio', 'out', 'audio']],
);

test('a cable dropped on a port of the wrong type offers the adapter, in both directions, and inserts it wired in one undo step', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?patch=chord-progression');
  const before = await cableIds(page);

  // Event into Signal, dragged from the output: Sample & Hold.
  await cable(page, { node: 'sweep', port: 'tick' }, { node: 'tone', port: 'position' });
  const prompt = page.getByTestId('adapter-prompt');
  await expect(prompt).toContainText('Event into Signal');
  await expect(page.getByTestId('adapter-option')).toHaveText([/^Sample & Hold/]);
  await page.getByTestId('adapter-option').click();
  await expect(prompt).toHaveCount(0);
  await expect(card(page, 'sample-and-hold-1')).toBeVisible();
  expect(await cableIds(page)).toEqual([...before, 'sweep.tick→sample-and-hold-1.trigger', 'sample-and-hold-1.out→tone.position']);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(card(page, 'sample-and-hold-1')).toHaveCount(0);
  expect(await cableIds(page)).toEqual(before);

  // Signal into Event, dragged from the input end: Threshold / Change.
  await cable(page, { node: 'tone', port: 'trigger' }, { node: 'sweep', port: 'phase' });
  await expect(prompt).toContainText('Signal into Event');
  await page.getByTestId('adapter-option').filter({ hasText: 'Threshold / Change' }).click();
  expect(await cableIds(page)).toEqual([...before, 'sweep.phase→threshold-change-1.in', 'threshold-change-1.out→tone.trigger']);
  await expect(page.getByTestId('compile-status')).toHaveText('7 nodes compiled');

  // Escape closes the offer and changes nothing; so does a drop with no adapter (Value into Signal).
  await cable(page, { node: 'clock', port: 'tick' }, { node: 'tone', port: 'position' });
  await expect(prompt).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await cable(page, { node: 'clock', port: 'transport' }, { node: 'tone', port: 'position' });
  await expect(prompt).toHaveCount(0);
  expect((await cableIds(page)).length).toBe(before.length + 2);
  expect(errors).toEqual([]);
});

test('an adapter that would close a loop with no delay is not offered', async ({ page }) => {
  // Make Note's Note back into its own Pitch, through Sample & Hold, would loop.
  await open(page, 'loop.flowpatch', fixture(
    [{ id: 'clock', type: 'clock', x: 0, y: 0 }, { id: 'note', type: 'make-note', x: 260, y: 0 }],
    [['clock', 'tick', 'note', 'trigger']],
  ));
  await cable(page, { node: 'note', port: 'note' }, { node: 'note', port: 'param:pitch' });
  await expect(page.getByTestId('adapter-prompt')).toHaveCount(0);
  // The same drop from another node's events is offered.
  await cable(page, { node: 'clock', port: 'tick' }, { node: 'note', port: 'param:pitch' });
  await expect(page.getByTestId('adapter-prompt')).toBeVisible();
});

test('a pinned probe keeps its history updating while the patch plays; hovering a port shows its last events', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?patch=chord-progression');
  await startAudio(page);

  // Clock Tick (Event): a timeline that fills as ticks sound. 144 bpm on 1/8 is one every 208 ms.
  await handle(page, 'clock', 'tick').click();
  const timeline = page.locator('[data-probe="clock.out.tick"] [data-testid="probe-timeline"]');
  await expect(timeline).toBeVisible();
  await expect.poll(async () => Number(await timeline.getAttribute('data-events')), { timeout: 5000 }).toBeGreaterThanOrEqual(6);
  // The history is 2 s long, and holds every tick in it: none lost between frames. A window the scheduler
  // skipped (a stall on a slow runner) loses its ticks for real, so the spacing is checked only without one.
  await expect.poll(async () => Number(await timeline.getAttribute('data-events'))).toBeGreaterThanOrEqual(8);
  const { ticks, skipped } = await page.evaluate(() => ({ ticks: window.flowPatcher!.probe('clock', 'tick')!.events.map((e) => e.time), skipped: window.flowPatcher!.stats.skipped }));
  const period = 60 / 144 / 2;
  for (let i = 1; i < ticks.length; i++) {
    const gap = (ticks[i]! - ticks[i - 1]!) / period;
    if (skipped === 0) expect(gap).toBeCloseTo(1, 6);
    else expect(gap).toBeCloseTo(Math.round(gap), 6);
  }

  // Sweep Phase (Signal): a scope that keeps changing.
  await handle(page, 'sweep', 'phase').click();
  const value = page.locator('[data-probe="sweep.out.phase"] [data-testid="probe-value"]');
  const first = await value.textContent();
  await expect.poll(() => value.textContent()).not.toBe(first);
  await expect.poll(async () => Number(await page.locator('[data-probe="sweep.out.phase"] [data-testid="probe-scope"]').getAttribute('data-samples'))).toBeGreaterThan(30);

  // Hover: the last few events, without pinning; leaving takes it away.
  await page.mouse.move(5, 300);
  await handle(page, 'tone', 'note').hover();
  const hover = page.getByTestId('probe-hover');
  await expect(hover).toContainText('Chord Tone · Note');
  await expect(hover.locator('li').first()).toContainText('pitch');
  await page.mouse.move(5, 300);
  await expect(hover).toHaveCount(0);

  // The pin unpins.
  await page.locator('[data-probe="clock.out.tick"]').getByRole('button', { name: 'Unpin probe' }).click();
  await expect(page.getByTestId('probe-pinned')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('every tap on the immediate path reaches a pinned probe and flashes its cable', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?patch=pointer-notes');
  const canvas = page.getByTestId('performance-canvas');
  await canvas.click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  await handle(page, 'pointer', 'down').click();
  const timeline = page.locator('[data-probe="pointer.out.down"] [data-testid="probe-timeline"]');
  await expect(timeline).toBeVisible();
  const cable = page.locator('[data-testid="cable"][data-cable="pointer.down→note.trigger"]');
  // Pushes land at currentTime + 5 ms, so a wake can stop retaining one before the next frame reads it
  // (test/event-track.test.ts pins that race down). Taps 250 ms apart, so each one's flash is over before the next.
  let flashed = 0;
  for (let i = 0; i < 8; i++) {
    await canvas.click({ position: { x: 60 + i * 10, y: 60 } });
    if (await cable.evaluate((el) => new Promise<boolean>((done) => {
      const until = performance.now() + 200;
      const look = () => (el.classList.contains('cable--firing') ? done(true) : performance.now() > until ? done(false) : requestAnimationFrame(look));
      look();
    }))) flashed++;
    // The probe's newest event is this tap's.
    await expect.poll(() => page.evaluate(() => {
      const live = window.flowPatcher!;
      return live.probe('pointer', 'down')!.events.at(-1)?.time === live.taps.at(-1)!.stamped;
    })).toBe(true);
    await page.waitForTimeout(250);
  }
  expect(flashed).toBe(8);
  expect(errors).toEqual([]);
});

test('cables flash while their output fires', async ({ page }) => {
  await page.goto('/?patch=chord-progression');
  await startAudio(page);
  const tick = page.locator('[data-testid="cable"][data-cable="clock.tick→tone.trigger"]');
  await expect(tick).toHaveClass(/cable--firing/);
  // And go dark between ticks (208 ms apart, lit for 120).
  await expect(tick).not.toHaveClass(/cable--firing/);
  // Signal cables carry no events, so they never flash.
  const phase = page.locator('[data-testid="cable"][data-cable="sweep.phase→tone.position"]');
  await page.waitForTimeout(500);
  await expect(phase).not.toHaveClass(/cable--firing/);
});

test('under reduced motion, a cable carrying a steady stream holds a steady tint instead of flashing', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?patch=chord-progression');
  await startAudio(page);
  const tick = page.locator('[data-testid="cable"][data-cable="clock.tick→tone.trigger"]');
  await expect(tick).toHaveClass(/cable--firing/);
  const lit = await tick.evaluate(async (el) => {
    const seen: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      seen.push(el.classList.contains('cable--firing'));
      await new Promise((r) => setTimeout(r, 40));
    }
    return seen;
  });
  expect(lit.every(Boolean)).toBe(true);
});

test('a node over the event cap shows its warning until dismissed', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, 'capped.flowpatch', capped);
  await startAudio(page);
  const warning = card(page, 'note').getByTestId('node-warning');
  await expect(warning.locator('[data-kind="node-event-limit"]')).toContainText(/Over 256 events in 120 ms: \d+ dropped/);
  expect((await page.evaluate(() => window.flowPatcher!.stats)).droppedNodeLimit).toBeGreaterThan(0);
  // The node keeps going over, so the warning can come back before a poll sees it gone:
  // watch the card for the warning's removal instead.
  await card(page, 'note').evaluate((el) => {
    const w = window as Window & { warningRemoved?: boolean };
    w.warningRemoved = false;
    const warning = el.querySelector('[data-testid="node-warning"]');
    new MutationObserver((records, observer) => {
      if (records.some((r) => [...r.removedNodes].some((n) => n === warning || (n instanceof Element && n.contains(warning))))) {
        w.warningRemoved = true;
        observer.disconnect();
      }
    }).observe(el, { childList: true, subtree: true });
  });
  await warning.getByTestId('dismiss-warnings').click();
  await expect.poll(() => page.evaluate(() => (window as Window & { warningRemoved?: boolean }).warningRemoved)).toBe(true);
  // It keeps going over, so the warning comes back.
  await expect(card(page, 'note').getByTestId('node-warning').locator('[data-kind="node-event-limit"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a voice steal warns on the node whose notes took the voices, and the readout counts it', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, 'stealing.flowpatch', stealing);
  const readout = page.getByTestId('voice-readout');
  await expect(readout).toHaveAttribute('data-steals', '0');
  await startAudio(page);
  await expect(card(page, 'synth').getByTestId('node-warning').locator('[data-kind="voice-steal"]')).toContainText(/Over 64 voices: \d+ stolen/);
  await expect(readout).toHaveAttribute('data-in-use', '64');
  await expect.poll(async () => Number(await readout.getAttribute('data-steals'))).toBeGreaterThan(0);
  await expect(readout).toContainText('64/64 voices');
  // ADR 0025: only the node whose claim went over the limit warns.
  for (const id of ['clock', 'note', 'out']) await expect(card(page, id).getByTestId('node-warning')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a Progression with no Transport cable says it holds its first chord, until one is wired', async ({ page }) => {
  await open(page, 'progression.flowpatch', fixture([{ id: 'clock', type: 'clock', x: 0, y: 0 }, { id: 'prog', type: 'progression', x: 260, y: 0 }], []));
  const hint = card(page, 'prog').getByTestId('node-warning').locator('[data-kind="unwired"]');
  await expect(hint).toHaveText('No transport: holding the first chord');
  // A hint has no dismiss: wiring the input is what clears it.
  await expect(card(page, 'prog').getByTestId('dismiss-warnings')).toHaveCount(0);
  await cable(page, { node: 'clock', port: 'transport' }, { node: 'prog', port: 'transport' });
  await expect(card(page, 'prog').getByTestId('node-warning')).toHaveCount(0);
});

// Screenshots for the PR: pinned probes on a playing patch, the adapter offer, and node warnings.
for (const [name, { defaultBrowserType: _, ...device }] of [['desktop', devices['Desktop Chrome']], ['tablet', devices['Galaxy Tab S4']]] as const) {
  test.describe(`on ${name}`, () => {
    test.use(device);

    test(`probes, adapter offer and warnings (${name})`, async ({ page }) => {
      const touch = name === 'tablet';
      const errors = collectErrors(page);
      await page.goto('/?patch=chord-progression');
      if (touch) await page.getByTestId('performance-canvas').tap({ position: { x: 40, y: 40 } });
      else await startAudio(page);
      await expect(page.getByTestId('audio-state')).toHaveText('live');
      for (const [node, port] of [['clock', 'tick'], ['sweep', 'phase']] as const) {
        if (touch) await handle(page, node, port).tap();
        else await handle(page, node, port).click();
      }
      await expect(page.getByTestId('probe-pinned')).toHaveCount(2);
      await expect.poll(async () => Number(await page.locator('[data-probe="clock.out.tick"] [data-testid="probe-timeline"]').getAttribute('data-events'))).toBeGreaterThanOrEqual(8);
      await page.screenshot({ path: `test-results/probes-${name}.png` });

      if (!touch) {
        await cable(page, { node: 'sweep', port: 'tick' }, { node: 'tone', port: 'position' });
        await expect(page.getByTestId('adapter-prompt')).toBeVisible();
        await page.screenshot({ path: `test-results/probes-adapter-${name}.png` });
        await page.keyboard.press('Escape');
      }

      await open(page, 'stealing.flowpatch', stealing);
      if (touch) await page.getByTestId('performance-canvas').tap({ position: { x: 40, y: 40 } });
      else await startAudio(page);
      await expect(card(page, 'synth').getByTestId('node-warning')).toBeVisible();
      await expect.poll(async () => Number(await page.getByTestId('voice-readout').getAttribute('data-steals'))).toBeGreaterThan(0);
      await page.screenshot({ path: `test-results/probes-warnings-${name}.png` });
      expect(errors).toEqual([]);
    });
  });
}
