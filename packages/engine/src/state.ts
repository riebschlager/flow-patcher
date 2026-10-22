// Node state snapshots for rewind and re-query (ADR 0019).
//
// The engine snapshots the state of every node with a `query()` at each
// window boundary, and restores it when a live event lands in a window it has
// already queried. That only works if the state is plain data, so cloning is
// strict: anything that isn't plain data throws, naming the node and the path,
// instead of being shared between the live state and the snapshot.
import type { NodeState } from './definition';

/** Thrown when a node's state holds something a snapshot can't copy. */
export class StateCloneError extends Error {}

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

function clone(value: unknown, path: string, seen: Set<object>): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'number':
    case 'string':
    case 'boolean':
      return value;
    case 'object':
      break;
    default:
      throw new StateCloneError(`${path} is a ${typeof value}; node state must be plain data`);
  }
  const object = value as object;
  if (seen.has(object)) throw new StateCloneError(`${path} refers back to itself; node state must be a tree`);
  if (ArrayBuffer.isView(object) && !(object instanceof DataView)) {
    return (object as unknown as { slice(): unknown }).slice();
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) return object.map((item, i) => clone(item, `${path}[${i}]`, seen));
    if (!isPlainObject(object)) {
      const name = (object as { constructor?: { name?: string } }).constructor?.name ?? 'object';
      throw new StateCloneError(`${path} is a ${name}; node state must be plain data`);
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) out[key] = clone(item, `${path}.${key}`, seen);
    return out;
  } finally {
    seen.delete(object);
  }
}

/**
 * A deep copy of plain data: numbers, strings, booleans, null, undefined,
 * arrays, plain objects and typed arrays. Throws a StateCloneError for
 * anything else (functions, class instances, Maps, cycles), with `label` as
 * the root of the path in the message.
 */
export function clonePlain<T>(value: T, label = 'state'): T {
  return clone(value, label, new Set()) as T;
}

/** Replaces the contents of `state` in place with a copy of `snapshot`, so the
 *  node's context keeps pointing at the same object. */
export function restoreState(state: NodeState, snapshot: NodeState): void {
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, clonePlain(snapshot));
}
