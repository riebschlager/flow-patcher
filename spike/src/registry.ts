import { blip } from './nodes/blip';
import { chordTone } from './nodes/chord-tone';
import { clock } from './nodes/clock';
import { euclidean } from './nodes/euclidean';
import { output } from './nodes/output';
import { pointer } from './nodes/pointer';
import { progression } from './nodes/progression';
import { sampledVoice } from './nodes/sampled-voice';
import { tone } from './nodes/tone';

// The spike's node registry. Each node type declares its ports and knobs and
// builds its instance: Web Audio nodes for Audio ports, query() for Event and
// Note ports, functions of time for Signal and Value ports. Later M0 tasks add theirs.

/** Value: rarely changing data such as a chord, read at each event's time and never scheduled. */
export type PortType = 'audio' | 'event' | 'note' | 'signal' | 'value';
export type PortDef = { name: string; label: string; type: PortType };
export type KnobDef = {
  name: string; label: string; min: number; max: number; default: number;
  curve?: 'lin' | 'log'; step?: number; unit?: string;
  /** Makes this a menu: the value is an index into options. */
  options?: string[];
  /** Choosing option i also sets this node's text param `text` to values[i]; editing that text sets the menu back to 0. */
  fills?: { text: string; values: string[] };
};

/** A text param, such as a chord string. `check` returns an error message, or null when the text is usable. */
export type TextDef = { name: string; label: string; default: string; check?(text: string): string | null };

/** A timestamped message on the audio clock. Fields beyond `time` depend on the source. */
export type SpikeEvent = { time: number; [field: string]: unknown };

/** What a node sees of its inputs during one query. */
export type Inputs = {
  /** This window's events on an Event/Note input, merged from every cable in time order. */
  events(port: string): SpikeEvent[];
  /** The summed Signal on an input, or null when nothing is cabled. */
  signal(port: string): ((t: number) => number) | null;
  /** The Value on an input at time t (the last cable wins), or null when nothing is cabled. */
  value(port: string): ((t: number) => unknown) | null;
};

/** A pointer event on the performance canvas, normalized; y = 0 is the top. */
export type CanvasInput = {
  kind: 'down' | 'move' | 'up' | 'cancel';
  pointerId: number;
  x: number;
  y: number;
  pressure: number;
  pointerType: string;
  /** The pointerdown's time on the audio clock, the latency gate's reference point. */
  inputAt: number;
  /** True when this input had to start the AudioContext, so its latency includes startup. */
  cold: boolean;
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
  /** Value outputs as functions of time, valid for any time the node has already been queried up to. */
  values?: Record<string, (t: number) => unknown>;
  /** Source nodes turn canvas input into events on their output ports; they take the immediate path. */
  canvas?(input: CanvasInput): { port: string; fields: Record<string, unknown> }[];
  /** Set a knob's value live; audio params ramp, never jump. */
  set(knob: string, value: number): void;
  /** Set a text param; only called with text that passed its check. */
  setText?(name: string, text: string): void;
  dispose(): void;
};

export type NodeType = {
  type: string;
  label: string;
  inputs: PortDef[];
  outputs: PortDef[];
  knobs: KnobDef[];
  texts?: TextDef[];
  create(ctx: AudioContext): Instance;
};

/** Which output types may feed which inputs. Notes are events too. */
export const canConnect = (from: PortType, to: PortType) => from === to || (from === 'note' && to === 'event');

export const registry: NodeType[] = [pointer, clock, euclidean, progression, chordTone, sampledVoice, blip, tone, output];
export const nodeType = (type: string) => registry.find((t) => t.type === type)!;
export const portOf = (type: string, dir: 'in' | 'out', name: string | null | undefined) =>
  nodeType(type)[dir === 'in' ? 'inputs' : 'outputs'].find((p) => p.name === name);
