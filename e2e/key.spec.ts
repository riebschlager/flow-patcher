import { expect, test, type Page } from '@playwright/test';
import type { EngineEvent } from '@flow-patcher/engine';
import type { LivePatch } from '../packages/editor/src/live';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
    /** Every Key event a probe showed, by port, kept past the probe's history. */
    keySeen?: Record<string, EngineEvent[]>;
    /** Every keydown the page saw, caught before the canvas's handler, to read `defaultPrevented` after it. */
    keyLog?: KeyboardEvent[];
  }
}

// Key node (#76): the canvas's keydowns and keyups reach Key while it has focus. examples/key-piano.flowpatch
// has a Key in Keyboard → Note mode (Octave 3: Z is C3) with Held keys "Space" gating a Clock's pulse.

const PORTS = ['down', 'up', 'all', 'note'] as const;
type Port = (typeof PORTS)[number];

async function follow(page: Page) {
  await page.evaluate((ports) => {
    const seen: Record<string, EngineEvent[]> = (window.keySeen = {});
    const same = (a: EngineEvent, b: EngineEvent) => a.time === b.time && a.channel === b.channel && a.phase === b.phase && a.repeat === b.repeat;
    for (const port of ports) {
      seen[port] = [];
      window.flowPatcher!.watchProbe('key', port, 'out', port === 'note' ? 'note' : 'event', () => {
        for (const event of window.flowPatcher!.probe('key', port)?.events ?? []) if (!seen[port]!.some((e) => same(e, event))) seen[port]!.push(event);
      });
    }
    window.flowPatcher!.watchProbe('key', 'held', 'out', 'signal', () => {});
  }, PORTS);
}
const seen = (page: Page, port: Port) => page.evaluate((p) => window.keySeen![p]!, port);
const held = (page: Page) => page.evaluate(() => window.flowPatcher!.probe('key', 'held')?.value);

test('Key sends Down, Up and All with key, code, repeat and modifiers, Held, and notes in Keyboard → Note', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

  // macOS, wherever the test runs: Cmd's keyup releases the keys pressed with it there (below).
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'MacIntel' }));
  await page.goto('/?patch=key-piano');
  await expect(page.getByTestId('compile-status')).toHaveText('5 nodes compiled');
  await follow(page);
  await page.evaluate(() => {
    const log: KeyboardEvent[] = (window.keyLog = []);
    window.addEventListener('keydown', (event) => log.push(event), true);
  });
  const prevented = (code: string) => page.evaluate((c) => window.keyLog!.filter((e) => e.code === c).map((e) => e.defaultPrevented), code);
  const canvas = page.getByTestId('performance-canvas');
  await canvas.focus();
  await expect(page.getByTestId('audio-state')).toHaveText('tap to start');

  // A lone modifier doesn't start audio. Its press is held for the start, but its auto-repeat is dropped.
  await page.keyboard.down('Shift');
  await page.keyboard.down('Shift');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(100);
  await expect(page.getByTestId('audio-state')).toHaveText('tap to start');
  expect(await page.evaluate(() => window.flowPatcher!.stats.pushes)).toBe(0);

  // A keydown starts audio, like the first tap, and still plays: Z is C3.
  await page.keyboard.down('KeyZ');
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  await expect.poll(() => seen(page, 'note'), { timeout: 5000 }).toEqual([expect.objectContaining({ channel: 26, pitch: 48, velocity: 0.8, duration: 0.3 })]);
  const down = (await seen(page, 'down')).find((e) => e.code === 'KeyZ');
  expect(down).toMatchObject({ channel: 26, key: 'z', code: 'KeyZ', repeat: false, shift: false, alt: false, ctrl: false, meta: false, age: 0 });

  // Auto-repeats reach Down with repeat: true, and stay off All and Note.
  // Spaced like real repeats (about 30 ms), so each has its own stamp.
  for (let i = 0; i < 2; i++) {
    await page.waitForTimeout(40);
    await page.keyboard.down('KeyZ');
  }
  await expect.poll(async () => (await seen(page, 'down')).filter((e) => e.repeat === true).length).toBe(2);
  await page.keyboard.up('KeyZ');
  await expect.poll(async () => (await seen(page, 'up')).filter((e) => e.code === 'KeyZ').length).toBe(1);
  const up = (await seen(page, 'up')).find((e) => e.code === 'KeyZ')!;
  expect(up).toMatchObject({ channel: 26, code: 'KeyZ', repeat: false });
  // Up's age: the seconds Z was held, over the two repeats' 80 ms.
  expect(up.age).toBeGreaterThan(0.07);
  expect((await seen(page, 'all')).filter((e) => e.channel === 26).map((e) => e.phase)).toEqual(['down', 'up']);
  // The cold Shift: one Down and its Up, reaching Key when audio started; its repeat never did.
  const shift = (await seen(page, 'down')).filter((e) => e.code === 'ShiftLeft');
  expect(shift.map((e) => e.repeat)).toEqual([false]);
  expect((await seen(page, 'up')).filter((e) => e.code === 'ShiftLeft').length).toBe(1);
  expect((await seen(page, 'note')).length).toBe(1);

  // Modifiers, on the key's own channel: Shift is a key too, and Shift+3 is '#' on Digit3 (D#4).
  await page.keyboard.down('Shift');
  await page.keyboard.down('Digit3');
  await page.keyboard.up('Digit3');
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await seen(page, 'note')).map((n) => [n.channel, n.pitch])).toEqual([[26, 48], [30, 63]]);
  const digit = (await seen(page, 'down')).find((e) => e.code === 'Digit3');
  expect(digit).toMatchObject({ channel: 30, key: '#', shift: true, repeat: false });
  expect((await seen(page, 'down')).find((e) => e.code === 'ShiftLeft')).toMatchObject({ channel: 57, key: 'Shift' });

  // Held follows Space (Held keys), and a key not on the piano plays no note.
  expect(await held(page)).toBe(0);
  await page.keyboard.down('Space');
  await expect.poll(() => held(page), { timeout: 5000 }).toBe(1);
  await page.keyboard.down('KeyA');
  await page.keyboard.up('KeyA');
  expect(await held(page)).toBe(1);
  await page.keyboard.up('Space');
  await expect.poll(() => held(page)).toBe(0);
  expect((await seen(page, 'note')).length).toBe(2);

  // Escape blurs the canvas and isn't sent; a key still down gets its Up then, so Held lets go.
  await page.keyboard.down('Space');
  await expect.poll(() => held(page)).toBe(1);
  await page.keyboard.press('Escape');
  await expect.poll(() => held(page)).toBe(0);
  await page.keyboard.up('Space');
  await expect.poll(async () => (await seen(page, 'all')).filter((e) => e.channel === 51).map((e) => e.phase)).toEqual(['down', 'up', 'down', 'up']);
  expect((await seen(page, 'down')).some((e) => e.code === 'Escape')).toBe(false);

  // Back on the canvas: Meta's keyup releases the keys pressed with it (macOS sends them no keyup).
  await canvas.focus();
  await page.keyboard.down('Meta');
  await page.keyboard.down('KeyX');
  await expect.poll(async () => (await seen(page, 'down')).find((e) => e.code === 'MetaLeft')).toMatchObject({ channel: 63, key: 'Meta', meta: true });
  expect((await seen(page, 'down')).find((e) => e.code === 'KeyX')).toMatchObject({ channel: 24, meta: true });
  await page.evaluate(() => {
    // The keyup macOS swallows: Meta comes up while X is still down, and X's own keyup never arrives.
    document.querySelector<HTMLCanvasElement>('[data-testid="performance-canvas"]')!.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', code: 'MetaLeft', bubbles: true }));
  });
  await expect.poll(async () => (await seen(page, 'up')).filter((e) => e.code === 'KeyX').length).toBe(1);
  // Playwright still holds them: their late keyups find nothing down, and are dropped.
  await page.keyboard.up('KeyX');
  await page.keyboard.up('Meta');

  // Keys stayed with the canvas: Delete on it deletes no node.
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await expect(page.getByTestId('compile-status')).toHaveText('5 nodes compiled');
  await expect.poll(async () => (await seen(page, 'up')).some((e) => e.code === 'Backspace')).toBe(true);

  // Ctrl and Alt reach Key as flags (and Ctrl+Z on the canvas undoes nothing in the editor).
  for (const modifier of ['Control', 'Alt']) {
    await page.waitForTimeout(40);
    await page.keyboard.down(modifier);
    await page.keyboard.press('KeyZ');
    await page.keyboard.up(modifier);
  }
  await expect.poll(async () => (await seen(page, 'down')).filter((e) => e.code === 'KeyZ' && !e.repeat).map((e) => [e.ctrl, e.alt])).toEqual([[false, false], [true, false], [false, true]]);
  await expect(page.getByTestId('compile-status')).toHaveText('5 nodes compiled');

  // With a Key in the patch, keys lose their page default, apart from Ctrl or Meta shortcuts, F-keys and Tab.
  await page.keyboard.press('F2');
  expect(await prevented('Space')).toEqual([true, true]);
  expect(await prevented('Slash')).toEqual([]);
  expect(await prevented('KeyZ')).toEqual([true, true, true, false, true]);
  expect(await prevented('KeyX')).toEqual([false]);
  expect(await prevented('F2')).toEqual([false]);
  // Tab moves focus on, as ever: its keyup comes from the blur.
  await page.keyboard.press('Tab');
  await expect(canvas).not.toBeFocused();
  expect(await prevented('Tab')).toEqual([false]);
  await expect.poll(async () => (await seen(page, 'up')).some((e) => e.code === 'Tab')).toBe(true);

  // Every Down that wasn't a repeat has its Up, and channels are fixed by code.
  const final = await seen(page, 'all');
  const open = new Map<number, number>();
  for (const e of final) open.set(e.channel, (open.get(e.channel) ?? 0) + (e.phase === 'down' ? 1 : -1));
  expect([...open.values()].every((n) => n === 0)).toBe(true);
  expect(Object.fromEntries(final.map((e) => [e.code, e.channel]))).toEqual({ KeyZ: 26, ShiftLeft: 57, Digit3: 30, Space: 51, KeyA: 1, MetaLeft: 63, KeyX: 24, Delete: 72, Backspace: 54, ControlLeft: 59, AltLeft: 61, F2: 78, Tab: 53 });
  expect((await seen(page, 'up')).filter((e) => e.code === 'KeyX' || e.code === 'MetaLeft').length).toBe(2);
  expect(errors).toEqual([]);
});
