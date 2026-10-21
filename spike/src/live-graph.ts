import { getCtx } from './audio';
import { nodeType, type CanvasInput, type Inputs, type Instance, type PortType, type SpikeEvent } from './registry';

export type Cable = { id: string; source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null };
type Wire = Cable & { type: PortType };

const FADE = 0.01; // seconds; each audio cable fades in and out so rewiring never clicks

/**
 * The live side of the patch: one Instance per node, one fading GainNode per audio cable,
 * and the Event/Note/Signal wires that run() walks each scheduler window.
 */
export class LivePatch {
  private nodes = new Map<string, Instance>();
  private cables = new Map<string, { from: AudioNode; fade: GainNode }>();
  private wires = new Map<string, Wire>();

  addNode(id: string, type: string, values: Record<string, number>, texts: Record<string, string> = {}) {
    const instance = nodeType(type).create(getCtx());
    for (const [knob, value] of Object.entries(values)) instance.set(knob, value);
    for (const [name, text] of Object.entries(texts)) instance.setText?.(name, text);
    this.nodes.set(id, instance);
  }

  /** Disconnect the node's cables first so they fade; dispose once the fades finish. */
  removeNode(id: string) {
    const instance = this.nodes.get(id);
    this.nodes.delete(id);
    for (const [wireId, w] of this.wires) if (w.source === id || w.target === id) this.wires.delete(wireId);
    if (instance) setTimeout(() => instance.dispose(), FADE * 3000);
  }

  set(id: string, knob: string, value: number) {
    this.nodes.get(id)?.set(knob, value);
  }

  setText(id: string, name: string, text: string) {
    this.nodes.get(id)?.setText?.(name, text);
  }

  /** Audio cables patch Web Audio now; other wires take effect at the next window, when run() next reads them. */
  connect(cable: Cable, type: PortType) {
    if (type !== 'audio') {
      this.wires.set(cable.id, { ...cable, type });
      return;
    }
    const from = this.nodes.get(cable.source)?.outputs?.[cable.sourceHandle ?? ''];
    const to = this.nodes.get(cable.target)?.inputs?.[cable.targetHandle ?? ''];
    if (!from || !to || this.cables.has(cable.id)) return;
    const ctx = getCtx();
    const fade = new GainNode(ctx, { gain: 0 });
    fade.gain.setTargetAtTime(1, ctx.currentTime, FADE / 3);
    from.connect(fade).connect(to);
    this.cables.set(cable.id, { from, fade });
  }

  disconnect(id: string) {
    this.wires.delete(id);
    const cable = this.cables.get(id);
    if (!cable) return;
    const { from, fade } = cable;
    this.cables.delete(id);
    const ctx = getCtx();
    fade.gain.cancelScheduledValues(ctx.currentTime);
    fade.gain.setTargetAtTime(0, ctx.currentTime, FADE / 3);
    setTimeout(() => {
      // The source may already be disposed with its node, which throws here.
      try { from.disconnect(fade); } catch { /* already detached */ }
      fade.disconnect();
    }, FADE * 3000);
  }

  /** True if an event or value wire from `source` to `target` would close a loop. Cycles need a delay edge, which the spike doesn't have. */
  wouldCycle(source: string, target: string) {
    const seen = new Set<string>();
    const stack = [target];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === source) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const w of this.wires.values()) if (w.source === id && w.type !== 'signal') stack.push(w.target);
    }
    return false;
  }

  /**
   * Query every event node for [t0, t1) in graph order, handing each node's outputs to the nodes cabled after it.
   * Value wires count for the order too, so a Value's source has heard this window's events before anyone reads it.
   * With `seed`, only the seed's downstream nodes run, fed the seed's events: the immediate path for live input.
   */
  run(t0: number, t1: number, seed?: { node: string; port: string; events: SpikeEvent[] }) {
    const eventWires = [...this.wires.values()].filter((w) => w.type !== 'signal');
    const outs = new Map<string, Record<string, SpikeEvent[]>>();
    const downstream = seed ? this.reachable(seed.node, eventWires) : null;
    if (seed) outs.set(seed.node, { [seed.port]: seed.events });
    for (const id of this.order(eventWires)) {
      const instance = this.nodes.get(id);
      if (!instance?.query || (downstream && (id === seed!.node || !downstream.has(id)))) continue;
      outs.set(id, instance.query(t0, t1, this.inputsOf(id, outs, eventWires)) ?? {});
    }
  }

  /** Hand a canvas pointer event to every source node; whatever they emit takes the immediate path. */
  canvas(input: CanvasInput) {
    for (const [id, instance] of this.nodes) {
      for (const { port, fields } of instance.canvas?.(input) ?? []) this.push(id, port, fields);
    }
  }

  /** Stamp a live input event and send it down its cables now, without waiting for the scheduler. */
  push(node: string, port: string, event: Omit<SpikeEvent, 'time'>) {
    const time = getCtx().currentTime + 0.01;
    this.run(time, time, { node, port, events: [{ ...event, time }] });
  }

  private inputsOf(id: string, outs: Map<string, Record<string, SpikeEvent[]>>, eventWires: Wire[]): Inputs {
    return {
      events: (port) =>
        eventWires
          .filter((w) => w.target === id && w.targetHandle === port)
          .flatMap((w) => outs.get(w.source)?.[w.sourceHandle ?? ''] ?? [])
          .sort((a, b) => a.time - b.time),
      signal: (port) => {
        const feeds = [...this.wires.values()]
          .filter((w) => w.type === 'signal' && w.target === id && w.targetHandle === port)
          .map((w) => this.nodes.get(w.source)?.signals?.[w.sourceHandle ?? ''])
          .filter((f) => f !== undefined);
        return feeds.length ? (t) => feeds.reduce((sum, f) => sum + f(t), 0) : null;
      },
      value: (port) => {
        const w = eventWires.findLast((w) => w.type === 'value' && w.target === id && w.targetHandle === port);
        return (w && this.nodes.get(w.source)?.values?.[w.sourceHandle ?? '']) ?? null;
      },
    };
  }

  /** Node ids in dependency order along event wires (Kahn's algorithm); wouldCycle keeps the graph acyclic. */
  private order(eventWires: Wire[]) {
    const indegree = new Map([...this.nodes.keys()].map((id) => [id, 0]));
    for (const w of eventWires) indegree.set(w.target, (indegree.get(w.target) ?? 0) + 1);
    const ready = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
    const order: string[] = [];
    while (ready.length) {
      const id = ready.shift()!;
      order.push(id);
      for (const w of eventWires) {
        if (w.source !== id) continue;
        const n = indegree.get(w.target)! - 1;
        indegree.set(w.target, n);
        if (n === 0) ready.push(w.target);
      }
    }
    return order;
  }

  private reachable(from: string, eventWires: Wire[]) {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      for (const w of eventWires) if (w.source === id && !seen.has(w.target)) { seen.add(w.target); stack.push(w.target); }
    }
    return seen;
  }
}
