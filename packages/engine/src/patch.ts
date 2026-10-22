// Patch format v1 (design.md, Persistence and sharing). Migrations and
// placeholders for unknown node types wait for M4 (ADR 0015).
import type { ParamValue } from './definition';

export const PATCH_FORMAT = 'flowpatch';
export const PATCH_VERSION = 1;

export interface PortRef {
  node: string;
  port: string;
}

export interface PatchCable {
  from: PortRef;
  to: PortRef;
  /** Modulation depth for cables into a parameter. */
  depth?: number;
}

export interface PatchNode {
  id: string;
  type: string;
  typeVersion: number;
  params: Record<string, ParamValue>;
  position: { x: number; y: number };
  pinned?: string[];
}

export interface Patch {
  format: typeof PATCH_FORMAT;
  version: typeof PATCH_VERSION;
  seed: number;
  nodes: PatchNode[];
  cables: PatchCable[];
  subpatches?: Record<string, unknown>;
}

export type ParseResult = { ok: true; patch: Patch } | { ok: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isParamValue = (value: unknown): value is ParamValue =>
  typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

function parsePortRef(value: unknown, where: string, errors: string[]): PortRef | null {
  if (!isRecord(value) || typeof value.node !== 'string' || typeof value.port !== 'string') {
    errors.push(`${where}: expected { node, port } strings`);
    return null;
  }
  return { node: value.node, port: value.port };
}

/** Structural validation only. Node types and ports are checked by the compiler. */
export function parsePatch(input: unknown): ParseResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['patch: expected an object'] };
  if (input.format !== PATCH_FORMAT) errors.push(`format: expected "${PATCH_FORMAT}"`);
  if (input.version !== PATCH_VERSION) errors.push(`version: expected ${PATCH_VERSION}`);
  if (typeof input.seed !== 'number' || !Number.isInteger(input.seed)) errors.push('seed: expected an integer');
  if (!Array.isArray(input.nodes)) errors.push('nodes: expected an array');
  if (!Array.isArray(input.cables)) errors.push('cables: expected an array');
  if (errors.length) return { ok: false, errors };

  const nodes: PatchNode[] = [];
  const ids = new Set<string>();
  (input.nodes as unknown[]).forEach((raw, i) => {
    const where = `nodes[${i}]`;
    if (!isRecord(raw)) return void errors.push(`${where}: expected an object`);
    const { id, type, typeVersion, params = {}, position, pinned } = raw;
    const errorsBefore = errors.length;
    if (typeof id !== 'string' || !id) return void errors.push(`${where}.id: expected a non-empty string`);
    if (ids.has(id)) errors.push(`${where}.id: duplicate id "${id}"`);
    ids.add(id);
    if (typeof type !== 'string' || !type) errors.push(`${where}.type: expected a string`);
    if (typeof typeVersion !== 'number' || !Number.isInteger(typeVersion)) errors.push(`${where}.typeVersion: expected an integer`);
    if (!isRecord(params) || !Object.values(params).every(isParamValue)) errors.push(`${where}.params: expected number/string/boolean values`);
    if (!isRecord(position) || !Number.isFinite(position.x) || !Number.isFinite(position.y)) errors.push(`${where}.position: expected { x, y } numbers`);
    if (pinned !== undefined && (!Array.isArray(pinned) || !pinned.every((p) => typeof p === 'string'))) errors.push(`${where}.pinned: expected strings`);
    if (errors.length > errorsBefore) return;
    const node: PatchNode = {
      id,
      type: type as string,
      typeVersion: typeVersion as number,
      params: params as Record<string, ParamValue>,
      position: { x: (position as { x: number }).x, y: (position as { y: number }).y },
    };
    if (pinned !== undefined) node.pinned = pinned as string[];
    nodes.push(node);
  });

  const cables: PatchCable[] = [];
  (input.cables as unknown[]).forEach((raw, i) => {
    const where = `cables[${i}]`;
    if (!isRecord(raw)) return void errors.push(`${where}: expected an object`);
    const from = parsePortRef(raw.from, `${where}.from`, errors);
    const to = parsePortRef(raw.to, `${where}.to`, errors);
    if (raw.depth !== undefined && (typeof raw.depth !== 'number' || !Number.isFinite(raw.depth))) errors.push(`${where}.depth: expected a number`);
    if (from && to) cables.push(raw.depth === undefined ? { from, to } : { from, to, depth: raw.depth as number });
  });

  if (errors.length) return { ok: false, errors };
  const patch: Patch = { format: PATCH_FORMAT, version: PATCH_VERSION, seed: input.seed as number, nodes, cables };
  if (isRecord(input.subpatches)) patch.subpatches = input.subpatches;
  return { ok: true, patch };
}

/** Plain JSON with every object's keys sorted, for data the format doesn't describe (subpatches until M4). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

/**
 * Canonical JSON: fixed key order (params and subpatches sorted by key), the
 * format, version and every node's type version written, two-space indent and
 * a trailing newline. Nodes, cables and pinned knobs keep their order, which
 * the plan's tie-breaks depend on. Save → load → save is byte-identical. Throws
 * on what wouldn't load back the same: a missing type version, or a number
 * JSON can't hold (NaN, Infinity). A user's save path must catch that and
 * report it rather than lose the save (M4's save will need to).
 */
export function serializePatch(patch: Patch): string {
  const canonical = {
    format: PATCH_FORMAT,
    version: PATCH_VERSION,
    seed: patch.seed,
    nodes: patch.nodes.map((node) => {
      if (!Number.isInteger(node.typeVersion)) throw new TypeError(`serializePatch: node "${node.id}" has no integer typeVersion (${node.typeVersion})`);
      return {
        id: node.id,
        type: node.type,
        typeVersion: node.typeVersion,
        params: sortKeys(node.params),
        position: { x: node.position.x, y: node.position.y },
        ...(node.pinned ? { pinned: [...node.pinned] } : {}),
      };
    }),
    cables: patch.cables.map((cable) => ({
      from: { node: cable.from.node, port: cable.from.port },
      to: { node: cable.to.node, port: cable.to.port },
      ...(cable.depth !== undefined ? { depth: cable.depth } : {}),
    })),
    ...(patch.subpatches ? { subpatches: sortKeys(patch.subpatches) } : {}),
  };
  return JSON.stringify(canonical, (key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError(`serializePatch: "${key}" is ${value}, which JSON can't hold`);
    return value;
  }, 2) + '\n';
}
