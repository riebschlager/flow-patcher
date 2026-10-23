// Browser permissions for source nodes (MIDI In; later motion and mic). Each is
// asked at most once a session, the first time a patch containing such a node
// plays, and a denial shows as the node's blocked state (Platform rules;
// docs/nodes/canvas-sources.md, Permissions).
import type { NodeDefinition, Permission, PermissionState } from '@flow-patcher/engine';

/** Asks the browser for one permission: resolves true when granted. Missing when the browser has no such API.
 *  A request can run outside a user gesture (an edit adds a source while the patch plays). That's fine
 *  for MIDI; a gesture-gated API (iOS motion) must wait for the next pointerdown instead of being denied. */
export type PermissionRequesters = Partial<Record<Permission, () => Promise<boolean>>>;

/** What a granted request hands over, so the host can use it without asking twice (MIDI In's MIDIAccess). */
export interface PermissionGrants {
  midi?(access: MIDIAccess): void;
}

/** The real browser APIs behind each permission. `granted` receives what each one gives when it's allowed. */
export function browserRequesters(granted: PermissionGrants = {}): PermissionRequesters {
  return {
    midi: typeof navigator.requestMIDIAccess === 'function'
      ? () => navigator.requestMIDIAccess().then((access) => {
        granted.midi?.(access);
        return true;
      })
      : undefined,
  };
}

/** The permissions a plan's nodes declare, each once, in plan order. */
export function neededPermissions(nodes: readonly { definition: NodeDefinition }[]): Permission[] {
  return [...new Set(nodes.flatMap((node) => node.definition.permission ?? []))];
}

export class Permissions {
  private readonly states = new Map<Permission, PermissionState>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly requesters: PermissionRequesters) {}

  state(permission: Permission): PermissionState {
    return this.states.get(permission) ?? 'unasked';
  }

  /** Where a node's permission stands, for its status hook (`StatusContext.permission`); undefined when it declares none. */
  of(definition: NodeDefinition): PermissionState | undefined {
    return definition.permission && this.state(definition.permission);
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
