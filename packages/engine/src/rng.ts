// Seeded randomness. Engine and node code never call Math.random (ADR 0008).
//
// Two shapes:
// - `createRng(seed)`: a sequential stream, for setup work that runs once;
//   `rngAt(seed, ...keys)` keys one the way `randomAt` keys a value.
// - `randomAt(seed, ...keys)`: a counter-based value keyed by what it is for
//   (node id, event time, channel). Window queries use this one, so the result
//   never depends on how time was split into windows or on what ran before.

/** 32-bit FNV-1a over a string. */
export function hashString(text: string, hash = 0x811c9dc5): number {
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mixes a 32-bit integer into a hash (murmur3 finalizer). */
export function mix32(hash: number, value: number): number {
  let h = (hash ^ value) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export type RandomKey = string | number;

/** Event times are keyed at microsecond resolution. */
export const timeKey = (time: number): number => Math.round(time * 1e6);

function keyHash(seed: number, keys: readonly RandomKey[]): number {
  let hash = mix32(0x9e3779b9, seed >>> 0);
  for (const key of keys) {
    if (typeof key === 'string') hash = mix32(hash, hashString(key));
    else {
      // Split into two 32-bit halves so large integers (microsecond times) stay distinct.
      const value = Number.isFinite(key) ? Math.trunc(key) : 0;
      hash = mix32(mix32(hash, value >>> 0), Math.floor(value / 0x100000000) >>> 0);
    }
  }
  return hash;
}

/** A deterministic value in [0, 1) for the given seed and keys. */
export function randomAt(seed: number, ...keys: RandomKey[]): number {
  return keyHash(seed, keys) / 0x100000000;
}

/**
 * A sequential stream (`createRng`) keyed like `randomAt`: the same seed and
 * keys give the same stream. For setup work that draws many values at once,
 * such as an audio node's generated buffer: `rngAt(seed, nodeId, 'impulse', channel)`.
 */
export function rngAt(seed: number, ...keys: RandomKey[]): Rng {
  return createRng(keyHash(seed, keys));
}

export interface Rng {
  /** Next value in [0, 1). */
  next(): number;
}

/** Sequential mulberry32 stream. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
    },
  };
}
