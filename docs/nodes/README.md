# Node catalog

One file per node family. To build a node, read this file and the file for the node's family. Read [design.md](../design.md) only for the section a family file points to.

| Family | File | Milestone |
| --- | --- | --- |
| Canvas sources | [canvas-sources.md](canvas-sources.md) | M2 (Pointer in M1) |
| Gesture recognizers | [gesture-recognizers.md](gesture-recognizers.md) | M2 |
| Time and rhythm | [time-rhythm.md](time-rhythm.md) | M1 and M3 |
| Harmony and pitch | [harmony-pitch.md](harmony-pitch.md) | M1 and M3 |
| Control and logic | [control-logic.md](control-logic.md) | M1, M2, the rest by M3 |
| Instruments | [instruments.md](instruments.md) | M1 and M3 |
| Effects and mix | [effects-mix.md](effects-mix.md) | M1, M2 and M3 |
| Visual: fluid, overlays, look | [visual.md](visual.md) | M1, M2 and M3 |

**Milestone column in each family file.** M1 means the node is part of the engine-core set. Nodes marked ★ are borrowed from Flow and land in M3, except those an earlier gate needs (Reverb, Delay and Orbit Rings land in M2). Unstarred nodes land in the first milestone whose gate needs them, and M3 finishes any left over (see [milestones.md](../milestones.md)). M0 builds throwaway versions of a few nodes in `spike/`; they don't count.

**★ and "Flow source".** ★ means the node's internals are borrowed from Flow. The Flow source column names the module from the Reuse-from-Flow table in `design.md`. Where it says *locate*, the table doesn't name a module and you need to find it in Flow first. Borrowed code is ours to adapt ([ADR 0001](../decisions/0001-independent-from-flow.md)).

## What a node file contains

One file per node type in `packages/nodes`. The palette, inspector and (later) server validation are generated from it.

- **Type id and type version.** Bump the version when params or ports change. Before M4, update example patches instead of writing a migration; from M4 on, add a migration and a test ([ADR 0015](../decisions/0015-migrations-in-m4.md)).
- **Ports:** name, port type and direction.
- **Parameters:** every numeric parameter is a knob with a range, a unit, a default and a modulation input. Menus and toggles are parameters too.
- **`query(t0, t1, inputs) → events[]`** for Event and Note nodes, and/or **`frame()`** for visual nodes.
- **Tests and an example patch.** Every node has a unit test and an example patch in `examples/`.

## Port types

| Port type | Carries | Rate |
| --- | --- | --- |
| Event | Timestamped discrete messages with a payload (`time`, `channel`, fields) | Audio-clock time, sample-accurate |
| Note | An Event subtype: pitch, velocity, duration, plus optional articulation (attack, pan, filter) | Audio-clock time |
| Signal | A continuous number, sampled whenever it's needed | Control rate, about 60 Hz, interpolated for audio |
| Audio | A Web Audio signal | Audio rate |
| Field | A 2D grid shared by reference (velocity plus dye). Writers feed the Fluid through their Write output into its Writers input | Frame rate |
| Value | Data that changes rarely (the current chord, a scale, a palette), read at each event's time and never scheduled. Its source answers for any time it has already been queried up to | Read at event times |

## Rules every node follows

- **Pure window queries.** Events are computed from absolute time and inputs. No timers (`setInterval`, `setTimeout`, `requestAnimationFrame`) and no `Math.random`: use the seeded RNG ([ADR 0008](../decisions/0008-one-clock-window-queries.md)).
- **Live input uses the same code.** A pushed canvas event is merged into its source node's output, and that node and everything downstream re-run through ordinary `query` calls from the event's time to the scheduler's horizon ([ADR 0019](../decisions/0019-live-events-rewind.md)). Don't special-case them.
- **Channels.** Every Event, Note and Signal port carries channels, and per-channel state is keyed by `channel`. Test with more than one channel ([ADR 0009](../decisions/0009-channels-from-day-one.md)).
- **Signals are sampled, not streamed.** Sample a Signal input at each event's timestamp. Audio-param targets ramp, never jump ([ADR 0031](../decisions/0031-audio-automation-and-in-place-edits.md)):
  - A modulated param follows its cable in `AudioInstance.automate(t0, t1, clock)`, which the runtime calls every chunk. Sample on the absolute grid t = k / 60 (`automationTimes`), never at t0 or per chunk, so the result doesn't depend on window splits. Cancel from t0 and schedule again, keeping the ramp t0 falls in whole so a changed base never steps: rewinds and swaps call it again for a stretch already covered. A `paramAutomation` per param does all of it; pass `clock` to `follow`, so it keeps what the render thread may already be playing. Skip params with no cable (`connected(name)` on the setup context).
  - A knob edit can update the running instance instead of building a new one: list the params in `liveParams` and ramp them from the swap time in `AudioInstance.update` (an `editRamp` per param). Menus that change the Web Audio graph stay out of `liveParams`.
- **Fan-in.** Several cables into an Event input merge in time order. Several cables into a Signal input are summed. A cable into a parameter is added to the knob's base value, scaled by the cable's depth.
- **Adapters do conversions.** Event → Signal is Sample & Hold or Envelope; Signal → Event is Threshold or Change. Nodes don't accept the wrong port type.
- **Hot patching keeps state.** State lives in a per-node-instance store the engine keeps when the node's id survives an edit.
- **State is plain data and windowing-independent.** For any node with `query()`, the engine snapshots `ctx.state` at every window boundary and restores it when a live event rewinds the node ([ADR 0019](../decisions/0019-live-events-rewind.md)). Keep only numbers, strings, booleans, null, arrays, plain objects and typed arrays in it (no class instances, Maps, closures or audio handles), change it only in `query()`, and process inputs in time order so the state after two windows equals the state after one window covering both. The contract is spelled out on `NodeState` in `packages/engine/src/definition.ts`.
- **Weird is fine, broken isn't.** Any input values, including NaN, huge, negative or empty, must give a defined result, never an exception. Runtime limits are enforced by the engine ([ADR 0011](../decisions/0011-runtime-safety-limits.md)); don't duplicate them in nodes.
