// Rules every node type follows, checked across the whole catalog.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compilePatch, parsePatch, serializePatch, type Patch } from '@flow-patcher/engine';
import { nodeDefinitions, nodeRegistry } from '../src';
import { ROOT } from '../../../test-support/golden';

const CATEGORIES = ['canvas-sources', 'gesture-recognizers', 'time-rhythm', 'harmony-pitch', 'control-logic', 'instruments', 'effects-mix', 'visual'];
const EXAMPLES = join(ROOT, 'examples');

function examples(): { file: string; text: string; patch: Patch }[] {
  const files = readdirSync(EXAMPLES, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.flowpatch'));
  return files.map((file) => {
    const text = readFileSync(join(EXAMPLES, file), 'utf8');
    const parsed = parsePatch(JSON.parse(text));
    if (!parsed.ok) throw new Error(`${file}: ${parsed.errors.join('; ')}`);
    return { file, text, patch: parsed.patch };
  });
}

describe('node catalog', () => {
  it('has unique type ids', () => {
    expect(nodeRegistry.size).toBe(nodeDefinitions.length);
  });

  for (const definition of nodeDefinitions) {
    describe(definition.type, () => {
      it('is well formed', () => {
        expect(definition.type).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(Number.isInteger(definition.version) && definition.version >= 1).toBe(true);
        expect(CATEGORIES).toContain(definition.category);
        expect(definition.query || definition.frame || definition.audio).toBeTruthy();
        for (const direction of ['in', 'out'] as const) {
          const names = definition.ports.filter((p) => p.direction === direction).map((p) => p.name);
          expect(new Set(names).size, `${direction} port names`).toBe(names.length);
        }
        const paramNames = definition.params.map((p) => p.name);
        expect(new Set(paramNames).size).toBe(paramNames.length);
        for (const param of definition.params) {
          if (param.kind === 'number') {
            expect(param.min).toBeLessThan(param.max);
            expect(param.default).toBeGreaterThanOrEqual(param.min);
            expect(param.default).toBeLessThanOrEqual(param.max);
          } else if (param.kind === 'enum') {
            expect(param.options).toContain(param.default);
          }
        }
      });

      it('has a unit test', () => {
        expect(existsSync(join(ROOT, 'packages/nodes/test', `${definition.type}.test.ts`)), `packages/nodes/test/${definition.type}.test.ts`).toBe(true);
      });

      it('appears in an example patch', () => {
        expect(examples().some(({ patch }) => patch.nodes.some((n) => n.type === definition.type)), `no example in examples/ uses ${definition.type}`).toBe(true);
      });
    });
  }
});

describe('example patches', () => {
  for (const { file, text, patch } of examples()) {
    it(`${file} compiles with catalog node types at their current versions`, () => {
      const compiled = compilePatch(patch, nodeRegistry);
      expect(compiled.ok ? [] : compiled.errors).toEqual([]);
      for (const node of patch.nodes) expect(node.typeVersion, `${node.id} (${node.type})`).toBe(nodeRegistry.get(node.type)!.version);
    });

    it(`${file} round-trips byte for byte`, () => {
      expect(serializePatch(patch)).toBe(text);
    });
  }
});
