import { getCtx } from './audio';
import { nodeType, type Instance } from './registry';

export type Cable = { id: string; source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null };

const FADE = 0.01; // seconds; each cable fades in and out so rewiring never clicks

/** The audio side of the patch: one Instance per node, one fading GainNode per cable. */
export class LivePatch {
  private nodes = new Map<string, Instance>();
  private cables = new Map<string, { from: AudioNode; fade: GainNode }>();

  addNode(id: string, type: string, values: Record<string, number>) {
    const instance = nodeType(type).create(getCtx());
    for (const [knob, value] of Object.entries(values)) instance.set(knob, value);
    this.nodes.set(id, instance);
  }

  /** Disconnect the node's cables first so they fade; dispose once the fades finish. */
  removeNode(id: string) {
    const instance = this.nodes.get(id);
    this.nodes.delete(id);
    if (instance) setTimeout(() => instance.dispose(), FADE * 3000);
  }

  set(id: string, knob: string, value: number) {
    this.nodes.get(id)?.set(knob, value);
  }

  connect(cable: Cable) {
    const from = this.nodes.get(cable.source)?.outputs[cable.sourceHandle ?? ''];
    const to = this.nodes.get(cable.target)?.inputs[cable.targetHandle ?? ''];
    if (!from || !to || this.cables.has(cable.id)) return;
    const ctx = getCtx();
    const fade = new GainNode(ctx, { gain: 0 });
    fade.gain.setTargetAtTime(1, ctx.currentTime, FADE / 3);
    from.connect(fade).connect(to);
    this.cables.set(cable.id, { from, fade });
  }

  disconnect(id: string) {
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
}
