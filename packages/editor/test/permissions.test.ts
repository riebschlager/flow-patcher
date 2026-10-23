// Permission prompts on first play, and the blocked state a denial leaves on the node's card (Platform rules).
import { describe, expect, it } from 'vitest';
import { blockedStatus, type NodeDefinition, type StatusContext } from '@flow-patcher/engine';
import { neededPermissions, Permissions } from '../src/permissions';

/** A requester whose answer the test gives, counting how often it was asked. */
function requester() {
  const r = { asked: 0, answer: (_granted: boolean) => {}, fail: (_error: Error) => {} };
  const ask = () => {
    r.asked++;
    return new Promise<boolean>((resolve, reject) => {
      r.answer = resolve;
      r.fail = reject;
    });
  };
  return { r, ask };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A stand-in for MIDI In: a source behind the MIDI permission whose card shows the blocked state. */
const stub: NodeDefinition = {
  type: 'stub-midi',
  version: 1,
  label: 'Stub MIDI',
  category: 'canvas-sources',
  description: '',
  ports: [],
  params: [],
  permission: 'midi',
  status: (ctx) => blockedStatus('midi', ctx.permission),
};

const statusOf = (permissions: Permissions) =>
  stub.status!({ nodeId: 'm', params: {}, audio: {} as StatusContext['audio'], services: {}, permission: permissions.of(stub) });

/** A node with no permission, such as Clock. */
const plain: NodeDefinition = { ...stub, type: 'stub-plain', permission: undefined, status: undefined };

describe('Permissions', () => {
  it('asks once, and goes from unasked through pending to granted', async () => {
    const { r, ask } = requester();
    const permissions = new Permissions({ midi: ask });
    expect(permissions.state('midi')).toBe('unasked');
    permissions.request(['midi']);
    expect(permissions.state('midi')).toBe('pending');
    permissions.request(['midi']);
    expect(r.asked).toBe(1);
    r.answer(true);
    await settle();
    expect(permissions.state('midi')).toBe('granted');
    expect(statusOf(permissions)).toBeNull();
  });

  it('shows the blocked state when the browser denies it', async () => {
    const { r, ask } = requester();
    const permissions = new Permissions({ midi: ask });
    let changes = 0;
    permissions.subscribe(() => changes++);
    permissions.request(['midi']);
    expect(statusOf(permissions)).toBeNull();
    r.fail(new DOMException('denied', 'NotAllowedError'));
    await settle();
    expect(permissions.state('midi')).toBe('denied');
    expect(changes).toBe(2);
    expect(statusOf(permissions)).toEqual({ kind: 'blocked', message: 'MIDI blocked — Allow in browser settings' });
    // Denied stays denied for the session: playing again doesn't ask again.
    permissions.request(['midi']);
    expect(r.asked).toBe(1);
  });

  it('counts a requester that throws as denied', async () => {
    const permissions = new Permissions({ midi: () => { throw new Error('SecurityError'); } });
    permissions.request(['midi']);
    await settle();
    expect(permissions.state('midi')).toBe('denied');
  });

  it('is unsupported when the browser has no API for it', () => {
    const permissions = new Permissions({});
    permissions.request(['midi']);
    expect(permissions.state('midi')).toBe('unsupported');
    expect(statusOf(permissions)).toEqual({ kind: 'blocked', message: "MIDI isn't available in this browser" });
  });

  it("doesn't ask for anything until a patch that needs it plays", () => {
    const { r, ask } = requester();
    const permissions = new Permissions({ midi: ask });
    permissions.request([]);
    expect(r.asked).toBe(0);
    expect(statusOf(permissions)).toBeNull();
  });

  it("passes a node's own permission to its status hook, and nothing for a node without one", async () => {
    const permissions = new Permissions({ midi: () => Promise.resolve(false) });
    expect(permissions.of(plain)).toBeUndefined();
    expect(permissions.of(stub)).toBe('unasked');
    permissions.request(['midi']);
    await settle();
    expect(permissions.of(stub)).toBe('denied');
    expect(permissions.of(plain)).toBeUndefined();
  });

  it('lists the permissions a plan needs, each once', () => {
    expect(neededPermissions([{ definition: plain }])).toEqual([]);
    expect(neededPermissions([{ definition: stub }, { definition: plain }, { definition: stub }])).toEqual(['midi']);
  });
});
