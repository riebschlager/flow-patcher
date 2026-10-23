// What a push's rewind costs on real nodes, visible and hidden, and how well
// Runtime.rewindCost × a smoothed ms per query predicts it (ADR 0026).
//
//   pnpm exec tsx tools/bench-push.ts
//
// Each row: Pointer, and Clocks feeding chains of Probability nodes (chance 1),
// optionally through a 10 ms Delay Edge, into Make Note and an audio node that
// only records. 400 pushes at varied phases between wakes; the first 50 warm
// up. The fallback is off (hiddenPushBudgetMs: Infinity), so every push rewinds
// fully; "estimate" is what the scheduler's hidden budget would compare.
import { compilePatch, Runtime, Scheduler, type AudioContextLike, type NodeDefinition, type Patch } from '@flow-patcher/engine';
import { nodeRegistry } from '@flow-patcher/nodes';

const recorder: NodeDefinition = {
  type: 'bench-recorder', version: 1, label: 'Recorder', category: 'instruments', description: '',
  ports: [{ name: 'in', type: 'note', direction: 'in' }],
  params: [],
  audio: () => ({ schedule: () => {}, cancel: () => {} }),
};
const definitions = new Map([...nodeRegistry, [recorder.type, recorder]]);
const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: definitions.get(type)!.version, params, position: { x: 0, y: 0 } });
const cable = (a: string, ap: string, b: string, bp: string) => ({ from: { node: a, port: ap }, to: { node: b, port: bp } });

/** `width` chains of `depth` Probability nodes, each fed by the Pointer and every Clock. */
function build(depth: number, width: number, { delay, clocks = 1, rate = 1 }: { delay?: number; clocks?: number; rate?: number } = {}): Patch {
  const nodes = [node('p', 'pointer')], cables = [];
  for (let k = 0; k < clocks; k++) nodes.push(node(`clock${k}`, 'clock', { bpm: 240, division: '1/16', rate }));
  for (let w = 0; w < width; w++) {
    let prev = ['p', 'down'] as const as readonly [string, string];
    for (let d = 0; d < depth; d++) {
      const id = `prob${w}_${d}`;
      nodes.push(node(id, 'probability', { chance: 1 }));
      cables.push(cable(prev[0], prev[1], id, 'in'));
      if (d === 0) for (let k = 0; k < clocks; k++) cables.push(cable(`clock${k}`, 'tick', id, 'in'));
      prev = [id, 'out'];
    }
    if (delay) {
      nodes.push(node(`delay${w}`, 'delay-edge', { time: delay }));
      cables.push(cable(prev[0], prev[1], `delay${w}`, 'in'));
      prev = [`delay${w}`, 'out'];
    }
    nodes.push(node(`note${w}`, 'make-note'));
    cables.push(cable(prev[0], prev[1], `note${w}`, 'trigger'));
    nodes.push(node(`rec${w}`, recorder.type));
    cables.push(cable(`note${w}`, 'note', `rec${w}`, 'in'));
  }
  return { format: 'flowpatch', version: 1, seed: 1, nodes, cables } as Patch;
}

const at = (sorted: number[], f: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))]!;
const fmt = (x: number) => x.toFixed(2).padStart(6);

function run(name: string, patch: Patch, hidden: boolean): void {
  const compiled = compilePatch(patch, definitions);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  const runtime = new Runtime(compiled.plan);
  runtime.attachAudio({ currentTime: 0 } as unknown as AudioContextLike);
  let audio = 0;
  const scheduler = new Scheduler(runtime, {
    clock: { audioTime: () => audio, wallTime: () => performance.now(), hidden: () => hidden },
    hiddenPushBudgetMs: Infinity,
  });
  const wake = hidden ? 1 : 0.025;
  const ms: number[] = [], estimates: number[] = [];
  for (let i = 0; i < 400; i++) {
    audio += wake;
    scheduler.wake();
    // A tap somewhere between this wake and the next.
    audio += wake * ((i * 0.618) % 1);
    const queries = runtime.rewindCost('p', audio + 0.005);
    const perQuery = scheduler.stats.msPerQuery[hidden ? 'hidden' : 'visible'];
    const before = scheduler.stats.pushMsTotal;
    scheduler.push('p', 'down', { channel: 0, x: 0.5, y: 0.5 });
    if (i < 50) continue;
    ms.push(scheduler.stats.pushMsTotal - before);
    if (queries !== null && perQuery !== null) estimates.push(queries * perQuery);
  }
  ms.sort((a, b) => a - b);
  estimates.sort((a, b) => a - b);
  console.log(`${name.padEnd(30)} ${hidden ? 'hidden ' : 'visible'} ${String(patch.nodes.length).padStart(4)} nodes  ms median ${fmt(at(ms, 0.5))} p95 ${fmt(at(ms, 0.95))} max ${fmt(at(ms, 1))}  estimate ${fmt(at(estimates, 0))}–${fmt(at(estimates, 1))}`);
}

for (const hidden of [false, true]) {
  run('Pointer → 3 nodes', build(3, 1), hidden);
  run('chain of 20', build(20, 1), hidden);
  run('10 × 10', build(10, 10), hidden);
  run('10 × 10, 10 ms Delay Edge', build(10, 10, { delay: 0.01 }), hidden);
  run('10 × 30, 10 ms Delay Edge', build(10, 30, { delay: 0.01 }), hidden);
  run('chain of 20, 8 fast Clocks', build(20, 1, { clocks: 8, rate: 4 }), hidden);
}
