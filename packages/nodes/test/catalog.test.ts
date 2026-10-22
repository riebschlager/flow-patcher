// Rules every node type follows, checked across the whole catalog.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compilePatch, CUSTOM_PRESET, parsePatch, PATCH_FORMAT, PATCH_VERSION, serializePatch, type Patch } from '@flow-patcher/engine';
import { nodeDefinitions, nodeRegistry } from '../src';
import { ROOT } from '../../../test-support/golden';
import { REWIND_SECONDS, rewindCheckable, rewindLogs, windowCheckable, windowLogs, WINDOW_SECONDS, WINDOW_STEPS } from '../../../test-support/window-independence';

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
          } else if (param.kind === 'text') {
            expect(typeof param.default).toBe('string');
            for (const text of [param.default, ...Object.values(param.presets ?? {})]) expect(param.check?.(text) ?? null, `${param.name}: "${text}"`).toBeNull();
            expect(Object.keys(param.presets ?? {})).not.toContain(CUSTOM_PRESET);
          }
        }
      });

      it('names no param like an input port, so a cable into a param is unambiguous', () => {
        const inputs = definition.ports.filter((p) => p.direction === 'in').map((p) => p.name);
        expect(definition.params.map((p) => p.name).filter((name) => inputs.includes(name))).toEqual([]);
      });

      // M1 gate: Window independence. Also proves the node's state can be snapshotted.
      it.runIf(windowCheckable(definition))(`gives the same events over 0–${WINDOW_SECONDS} s in ${WINDOW_STEPS.map((s) => s * 1000).join(' ms, ')} ms windows and one call`, () => {
        const [first, ...rest] = windowLogs(definition);
        for (const log of rest) expect(log).toBe(first);
      });

      // Rewind and re-query (ADR 0019): live events into its Event inputs give the same log however the scheduler woke.
      it.runIf(rewindCheckable(definition))(`gives the same events over 0–${REWIND_SECONDS} s with live input, whatever the wake timing`, () => {
        const { reference, rewound } = rewindLogs(definition);
        for (const { name, log, rewinds } of rewound) {
          expect(rewinds, name).toBeGreaterThan(0);
          expect(log, name).toBe(reference);
        }
      });

      if (definition.adapter) {
        it('is an adapter whose input and output ports have its from and to types', () => {
          const { from, to, input, output } = definition.adapter!;
          expect(from).not.toBe(to);
          expect(definition.ports.find((p) => p.direction === 'in' && p.name === input)?.type, `input ${input}`).toBe(from);
          expect(definition.ports.find((p) => p.direction === 'out' && p.name === output)?.type, `output ${output}`).toBe(to);
        });
      }

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

    // M1 gate: Format.
    it(`${file} survives save → load → save byte for byte, with format and node type versions present`, () => {
      const saved = serializePatch(patch);
      const loaded = parsePatch(JSON.parse(saved));
      expect(loaded.ok ? [] : loaded.errors).toEqual([]);
      if (!loaded.ok) return;
      expect(serializePatch(loaded.patch)).toBe(saved);
      const json = JSON.parse(saved);
      expect([json.format, json.version]).toEqual([PATCH_FORMAT, PATCH_VERSION]);
      for (const node of json.nodes) expect(Number.isInteger(node.typeVersion), `${node.id} typeVersion`).toBe(true);
    });
  }
});
