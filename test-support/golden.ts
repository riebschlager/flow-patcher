// Golden files live in golden/ and belong to this repo. Regenerate them with
// `pnpm golden:update` only when a change is meant to alter the output, and say
// why in the PR.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_DIR = join(ROOT, 'golden');
const updating = process.env.UPDATE_GOLDEN === '1';

export function sha256(data: ArrayBufferView | string): string {
  const bytes = typeof data === 'string' ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return createHash('sha256').update(bytes).digest('hex');
}

function goldenPath(name: string): string {
  return join(GOLDEN_DIR, `${name}.json`);
}

function readGolden<T>(name: string): T {
  const path = goldenPath(name);
  if (!existsSync(path)) throw new Error(`Missing golden file golden/${name}.json. Run \`pnpm golden:update\` to create it.`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeGolden(name: string, value: unknown): void {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  writeFileSync(goldenPath(name), JSON.stringify(value, null, 1) + '\n');
}

/** Exact match against golden/<name>.json. */
export function expectGolden(name: string, actual: unknown): void {
  if (updating) return writeGolden(name, actual);
  expect(actual).toEqual(readGolden(name));
}

/** Match within an absolute tolerance, for outputs that may vary across platforms. */
export function expectGoldenClose(name: string, actual: Record<string, number[]>, tolerance: number): void {
  if (updating) return writeGolden(name, actual);
  const golden = readGolden<Record<string, number[]>>(name);
  expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  for (const [key, values] of Object.entries(actual)) {
    const expected = golden[key]!;
    expect(values.length, key).toBe(expected.length);
    values.forEach((value, i) => {
      if (Math.abs(value - expected[i]!) > tolerance) {
        throw new Error(`${name}.${key}[${i}] = ${value}, golden ${expected[i]} (tolerance ${tolerance})`);
      }
    });
  }
}
