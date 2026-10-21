import { blip } from './nodes/blip';
import { clock } from './nodes/clock';
import { output } from './nodes/output';
import { tone } from './nodes/tone';

// The spike's node registry. Each node type declares its ports and knobs and
// builds its instance: Web Audio nodes for Audio ports, query() for Event and
// Note ports, functions of time for Signal ports. Later M0 tasks add theirs.

export type PortType = 'audio' | 'event' | 'note' | 'signal';
export type PortDef = { name: string; label: string; type: PortType };
export type KnobDef = { name: string; label: string; min: number; max: number; default: number; curve?: 'lin' | 'log'; step?: number; unit?: string };

/** A timestamped message on the audio clock. Fields beyond `time` depend on the source. */
export type SpikeEvent = { time: number; [field: string]: unknown };

/** What a node sees of its inputs during one query. */
export type Inputs = {
  /** This window's events on an Event/Note input, merged from every cable in time order. */
  events(port: string): SpikeEvent[];
  /** The summed Signal on an input, or null when nothing is cabled. */
  signal(port: string): ((t: number) => number) | null;
};

export type Instance = {
  inputs?: Record<string, AudioNode>;
  outputs?: Record<string, AudioNode>;
  /**
   * Events on each Event/Note output in [t0, t1), computed from absolute time; nodes never own timers.
   * Sinks schedule their sound here. A zero-width window is the immediate path for live input.
   */
  query?(t0: number, t1: number, inputs: Inputs): Record<string, SpikeEvent[]> | void;
  signals?: Record<string, (t: number) => number>;
  /** Set a knob's value live; audio params ramp, never jump. */
  set(knob: string, value: number): void;
  dispose(): void;
};

export type NodeType = {
  type: string;
  label: string;
  inputs: PortDef[];
  outputs: PortDef[];
  knobs: KnobDef[];
  create(ctx: AudioContext): Instance;
};

/** Which output types may feed which inputs. Notes are events too. */
export const canConnect = (from: PortType, to: PortType) => from === to || (from === 'note' && to === 'event');

export const registry: NodeType[] = [clock, blip, tone, output];
export const nodeType = (type: string) => registry.find((t) => t.type === type)!;
export const portOf = (type: string, dir: 'in' | 'out', name: string | null | undefined) =>
  nodeType(type)[dir === 'in' ? 'inputs' : 'outputs'].find((p) => p.name === name);
