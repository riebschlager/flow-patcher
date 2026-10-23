// Browser permissions for source nodes (MIDI In; later motion and mic). Each is
// asked at most once a session, the first time a patch containing such a node
// plays, and a denial shows as the node's blocked state (Platform rules;
// docs/nodes/canvas-sources.md, Permissions).
import type { Permission, PermissionState } from '@flow-patcher/engine';

/** Asks the browser for one permission: resolves true when granted. Missing when the browser has no such API. */
export type PermissionRequesters = Partial<Record<Permission, () => Promise<boolean>>>;

/** The real browser APIs behind each permission. */
export function browserRequesters(): PermissionRequesters {
  return {
    midi: typeof navigator.requestMIDIAccess === 'function' ? () => navigator.requestMIDIAccess().then(() => true) : undefined,
  };
}

export class Permissions {
  private readonly states = new Map<Permission, PermissionState>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly requesters: PermissionRequesters) {}

  state(permission: Permission): PermissionState {
    return this.states.get(permission) ?? 'unasked';
  }

  /** Asks for each permission not asked yet. A request that throws or rejects counts as denied. */
  request(permissions: Iterable<Permission>): void {
    for (const permission of permissions) {
      if (this.state(permission) !== 'unasked') continue;
      const ask = this.requesters[permission];
      if (!ask) {
        this.set(permission, 'unsupported');
        continue;
      }
      this.set(permission, 'pending');
      let asked: Promise<boolean>;
      try {
        asked = ask();
      } catch {
        asked = Promise.resolve(false);
      }
      asked.then(
        (granted) => this.set(permission, granted ? 'granted' : 'denied'),
        () => this.set(permission, 'denied'),
      );
    }
  }

  /** Calls `listener` whenever a permission's state changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(permission: Permission, state: PermissionState): void {
    this.states.set(permission, state);
    for (const listener of this.listeners) listener();
  }
}
