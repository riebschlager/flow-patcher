import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// Every example patch opens in the editor (#118): it compiles and the page throws nothing.
// Headless runs build audio after compile; the editor builds it inside a swap, so this
// is the only check that a node's audio setup survives being swapped in. The AudioContext
// stays suspended here, so automate/schedule aren't exercised: only build-time and frame-time errors.

const root = fileURLToPath(new URL('../examples', import.meta.url));

function flowpatches(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return flowpatches(path);
    return entry.name.endsWith('.flowpatch') ? [path] : [];
  });
}

for (const file of flowpatches(root).sort()) {
  const name = relative(root, file).replace(/\\/g, '/').replace(/\.flowpatch$/, '');
  const nodes = (JSON.parse(readFileSync(file, 'utf8')) as { nodes: unknown[] }).nodes.length;

  test(`example ${name} opens and compiles`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/?patch=${encodeURIComponent(name)}`);
    // The first test may wait on Vite optimising deps cold (CI).
    await expect(page.getByTestId('compile-status')).toHaveText(`${nodes} nodes compiled`, { timeout: 15_000 });
    // Two frames, so a throw on the first frame (the Fluid, the renderer) is caught too.
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    expect(errors).toEqual([]);
  });
}
