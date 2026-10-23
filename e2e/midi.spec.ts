import { expect, test, type Page } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
    /** The fake MIDI device's input, granted path only: sends one message's bytes. */
    sendMidi?: (bytes: number[]) => void;
    /** How many times the fake input's port was opened. */
    midiOpened?: number;
    /** The page's AudioContext, captured as it's made, to suspend it. */
    audioContext?: AudioContext;
  }
}

// Gate check Permissions (docs/milestones.md, M2; ADR 0004): with MIDI denied,
// the MIDI In node shows its blocked state and the rest of the patch plays.
// examples/midi-in.flowpatch has MIDI In and a Clock → Make Note line into one synth.

/** Follows an output's Note (or Event) probe, so `notesOn` can read what sounded. */
async function follow(page: Page, node: string, port: string, type: 'note' | 'event' = 'note') {
  await page.evaluate(([n, p, t]) => void window.flowPatcher!.watchProbe(n!, p!, 'out', t as 'note' | 'event', () => {}), [node, port, type]);
}
const notesOn = (page: Page, node: string, port: string) => page.evaluate(([n, p]) => window.flowPatcher!.probe(n!, p!)?.events ?? [], [node, port]);

async function start(page: Page) {
  await page.goto('/?patch=midi-in');
  await expect(page.getByTestId('compile-status')).toHaveText('5 nodes compiled');
  // Nothing is asked before the patch first plays.
  await expect(page.locator('[data-node-type="midi-in"]').getByTestId('node-status')).toHaveCount(0);
  await follow(page, 'bass', 'note');
  await follow(page, 'midi', 'note');
  await follow(page, 'midi', 'midi', 'event');
  await page.getByTestId('performance-canvas').click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
}

test('Permissions: with MIDI denied, MIDI In shows its blocked state and the rest of the patch plays', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    (window as unknown as { midiAsks: number }).midiAsks = 0;
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: () => {
        (window as unknown as { midiAsks: number }).midiAsks++;
        return Promise.reject(new DOMException('MIDI access denied', 'SecurityError'));
      },
    });
  });
  await start(page);

  const card = page.locator('[data-node-type="midi-in"]');
  const status = card.getByTestId('node-status');
  await expect(status).toHaveAttribute('data-status', 'blocked');
  await expect(status).toHaveText('MIDI blocked — Allow in browser settings');
  await expect(card).toHaveClass(/patch-node--error/);
  expect(await page.evaluate(() => window.flowPatcher!.permissions.state('midi'))).toBe('denied');

  // The Clock line keeps sounding, more than a couple of beats of it.
  await expect.poll(async () => (await notesOn(page, 'bass', 'note')).length, { timeout: 5000 }).toBeGreaterThan(2);
  expect(await notesOn(page, 'midi', 'note')).toEqual([]);
  await card.screenshot({ path: testInfo.outputPath('midi-in-blocked.png') });

  // An edit while playing brings a new plan in, which asks for what its sources need; a denial isn't asked again.
  await card.getByLabel('Channel').selectOption('2');
  await expect.poll(() => page.evaluate(() => window.flowPatcher!.nodeStatus('midi')?.kind)).toBe('blocked');
  await expect(card.getByLabel('Channel')).toHaveValue('2');
  expect(await page.evaluate(() => (window as unknown as { midiAsks: number }).midiAsks)).toBe(1);
  await expect(status).toHaveAttribute('data-status', 'blocked');
  expect(errors).toEqual([]);
});

test('with MIDI granted, a note-on from a device plays as a Note on its MIDI channel + 1', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.midiOpened = 0;
    const input = Object.assign(new EventTarget(), { open: () => Promise.resolve(void window.midiOpened!++) });
    const Base = window.AudioContext;
    window.AudioContext = class extends Base {
      constructor(options?: AudioContextOptions) {
        super(options);
        window.audioContext = this;
      }
    };
    const access = Object.assign(new EventTarget(), { inputs: new Map([['fake', input]]), outputs: new Map() });
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: () => Promise.resolve(access) });
    window.sendMidi = (bytes) => input.dispatchEvent(Object.assign(new Event('midimessage'), { data: new Uint8Array(bytes) }));
  });
  await start(page);
  await expect.poll(() => page.evaluate(() => window.flowPatcher!.midi.listening)).toBe(1);
  // The host opens the port itself, not relying on the listener to.
  expect(await page.evaluate(() => window.midiOpened)).toBe(1);
  expect(await page.evaluate(() => window.flowPatcher!.permissions.state('midi'))).toBe('granted');
  await expect(page.locator('[data-node-type="midi-in"]').getByTestId('node-status')).toHaveCount(0);

  // A note-on on MIDI channel 3, and a clock message MIDI In doesn't read.
  const before = await page.evaluate(() => window.flowPatcher!.clock.currentTime);
  await page.evaluate(() => {
    window.sendMidi!([0xf8]);
    window.sendMidi!([0x92, 64, 127]);
  });
  await expect.poll(async () => (await notesOn(page, 'midi', 'note')).length, { timeout: 5000 }).toBe(1);
  const [note] = await notesOn(page, 'midi', 'note');
  expect(note).toMatchObject({ channel: 3, pitch: 64, velocity: 1, duration: 0.4 });
  // Stamped on the immediate path, just after the message.
  expect(note!.time).toBeGreaterThan(before);
  expect(note!.time).toBeLessThan(before + 0.2);
  // The Clock line plays alongside.
  await expect.poll(async () => (await notesOn(page, 'bass', 'note')).length, { timeout: 5000 }).toBeGreaterThan(0);

  // While audio is suspended (an iOS call, say), MIDI is dropped rather than held for a burst on resume.
  await page.evaluate(() => window.audioContext!.suspend());
  await page.evaluate(() => {
    for (let k = 0; k < 300; k++) window.sendMidi!([0xb0, 1, k % 128]);
    window.sendMidi!([0x90, 48, 100]);
  });
  await page.evaluate(() => window.audioContext!.resume());
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  await page.waitForTimeout(300);
  expect((await notesOn(page, 'midi', 'midi')).length).toBe(1);
  expect((await notesOn(page, 'midi', 'note')).length).toBe(1);
  // Once it runs again, MIDI plays again.
  await page.evaluate(() => window.sendMidi!([0x90, 50, 100]));
  await expect.poll(async () => (await notesOn(page, 'midi', 'note')).map((n) => n.pitch), { timeout: 5000 }).toEqual([64, 50]);
  expect(errors).toEqual([]);
});
