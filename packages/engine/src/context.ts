// Builds the accessors a node reads its cables through (design.md, Core
// concepts: fan-in). The runtime and the node tests share this one
// implementation, so a rule proven in a test is the rule the runtime applies.
import { resolveParam, type FrameContext, type HostServices, type NodeContext, type NodeDefinition, type NodeState, type ParamValues } from './definition';

export type SignalSource = (t: number, channel: number) => number;
export type ValueSource = (t: number) => unknown;
export type FieldSource = () => unknown;

/** The non-Event cables into one node, keyed by input port (or param name for `mods`). */
export interface NodeWiring {
  /** Event and Note input ports that have a cable. */
  events?: readonly string[];
  signals?: Readonly<Record<string, readonly SignalSource[]>>;
  /** One cable per Value input; the compiler rejects a second. */
  values?: Readonly<Record<string, ValueSource>>;
  fields?: Readonly<Record<string, readonly FieldSource[]>>;
  /** Cables into number params, each scaled by its depth. */
  mods?: Readonly<Record<string, readonly { depth: number; signal: SignalSource }[]>>;
}

export interface NodeContextInit {
  nodeId: string;
  seed: number;
  definition: NodeDefinition;
  params: ParamValues;
  state: NodeState;
  /** The host's platform resources; none by default. */
  services?: HostServices;
}

const NO_SERVICES: HostServices = Object.freeze({});

/** A node's long-lived context; the runtime adds `inputs` and the window per call. */
export type BoundContext = NodeContext & Pick<FrameContext, 'fields'>;

export function createNodeContext({ nodeId, seed, definition, params, state, services = NO_SERVICES }: NodeContextInit, wiring: NodeWiring = {}): BoundContext {
  const specs = new Map(definition.params.map((spec) => [spec.name, spec]));
  const connected = new Set([
    ...(wiring.events ?? []),
    ...[wiring.signals, wiring.values, wiring.fields, wiring.mods].flatMap((group) =>
      Object.entries(group ?? {}).filter(([, v]) => !Array.isArray(v) || v.length).map(([port]) => port),
    ),
  ]);
  return {
    nodeId,
    seed,
    params,
    state,
    services,
    signal(port, t, channel = 0) {
      let sum = 0;
      // A non-finite cable counts as 0.
      for (const source of wiring.signals?.[port] ?? []) {
        const v = source(t, channel);
        if (Number.isFinite(v)) sum += v;
      }
      return sum;
    },
    value(port, t) {
      return wiring.values?.[port]?.(t);
    },
    param(name, t, channel = 0) {
      const spec = specs.get(name);
      if (spec?.kind !== 'number') return NaN;
      const base = params[name] as number;
      const cables = spec.modulatable === false ? undefined : wiring.mods?.[name];
      if (!cables?.length) return base;
      let sum = base;
      for (const { depth, signal } of cables) {
        const v = depth * signal(t, channel);
        if (Number.isFinite(v)) sum += v;
      }
      // Huge finite terms can still overflow; fall back to the knob, not the spec default.
      return Number.isFinite(sum) ? (resolveParam(spec, sum) as number) : base;
    },
    connected(port) {
      return connected.has(port);
    },
    fields(port) {
      return (wiring.fields?.[port] ?? []).map((source) => source()).filter((field) => field != null);
    },
  };
}
