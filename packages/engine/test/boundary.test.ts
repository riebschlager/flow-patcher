// The engine/editor boundary (ADR 0013) is enforced by lint. These tests prove
// the rule fires on a deliberate violation and stays quiet on the real code.
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../../test-support/golden';

const eslint = new ESLint({ cwd: ROOT });
const ENGINE_FILE = join(ROOT, 'packages/engine/src/__boundary_fixture__.ts');
const NODE_FILE = join(ROOT, 'packages/nodes/src/__boundary_fixture__.ts');

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.map((m) => m.ruleId ?? m.message);
}

describe('engine boundary', () => {
  it.each([
    ["import React from 'react';\nexport const x = React;", 'no-restricted-imports'],
    ["import { ReactFlow } from '@xyflow/react';\nexport const x = ReactFlow;", 'no-restricted-imports'],
    ["import { readFileSync } from 'node:fs';\nexport const x = readFileSync;", 'no-restricted-imports'],
    ["import { nodeRegistry } from '@flow-patcher/nodes';\nexport const x = nodeRegistry;", 'no-restricted-imports'],
    ["import { x } from '../../../spike/thing';\nexport const y = x;", 'no-restricted-imports'],
    ['export const el = document.createElement("canvas");', 'no-restricted-globals'],
    ['export const w = window.innerWidth;', 'no-restricted-globals'],
    ['export const ctx = new AudioContext();', 'no-restricted-globals'],
    ['export const id = requestAnimationFrame(() => {});', 'no-restricted-globals'],
    ['export const r = Math.random();', 'no-restricted-properties'],
    ['const { random } = Math;\nexport const r = random();', 'no-restricted-properties'],
    ['export const r = crypto.getRandomValues(new Uint32Array(1));', 'no-restricted-globals'],
  ])('rejects %s', async (code, rule) => {
    expect(await ruleIds(code, ENGINE_FILE)).toContain(rule);
  });

  it('accepts plain engine code', async () => {
    expect(await ruleIds("import { randomAt } from './rng';\nexport const r = randomAt(1, 'a');", ENGINE_FILE)).toEqual([]);
  });

  it('passes on the real engine source', async () => {
    const results = await eslint.lintFiles(['packages/engine/src']);
    expect(results.flatMap((r) => r.messages.map((m) => `${r.filePath}: ${m.ruleId} ${m.message}`))).toEqual([]);
  });
});

describe('node rules', () => {
  it.each([
    ['export const t = setInterval(() => {}, 25);', 'no-restricted-globals'],
    ['export const r = Math.random();', 'no-restricted-properties'],
    ['const { random } = Math;\nexport const r = random();', 'no-restricted-properties'],
    ['export const id = crypto.randomUUID();', 'no-restricted-globals'],
    ["import React from 'react';\nexport const x = React;", 'no-restricted-imports'],
  ])('rejects %s', async (code, rule) => {
    expect(await ruleIds(code, NODE_FILE)).toContain(rule);
  });

  // Seeded RNG everywhere (M1 scope): the rules hold on the real node source too.
  it('passes on the real node source', async () => {
    const results = await eslint.lintFiles(['packages/nodes/src']);
    expect(results.flatMap((r) => r.messages.map((m) => `${r.filePath}: ${m.ruleId} ${m.message}`))).toEqual([]);
  });
});
