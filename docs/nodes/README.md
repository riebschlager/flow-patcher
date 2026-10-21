# Node catalog

One file per node family. To build a node, read this file and the file for the node's family. Read [design.md](../design.md) only for the section a family file points to.

| Family | File | Milestone |
| --- | --- | --- |
| Canvas sources | [canvas-sources.md](canvas-sources.md) | M2 (Pointer in M1) |
| Gesture recognizers | [gesture-recognizers.md](gesture-recognizers.md) | M2 |
| Time and rhythm | [time-rhythm.md](time-rhythm.md) | M1 and M3 |
| Harmony and pitch | [harmony-pitch.md](harmony-pitch.md) | M1 and M3 |
| Control and logic | [control-logic.md](control-logic.md) | As needed, by M3 |
| Instruments | [instruments.md](instruments.md) | M1 and M3 |
| Effects and mix | [effects-mix.md](effects-mix.md) | M1 and M3 |
| Visual: fluid, overlays, look | [visual.md](visual.md) | M1 and M3 |

**Milestone column in each family file.** M1 means the node is part of the engine-core set. Nodes marked ★ are borrowed from Flow and land in M3. Unstarred nodes land in the first milestone whose gate needs them, and M3 finishes any left over (see [milestones.md](../milestones.md)). M0 builds throwaway versions of a few nodes in `spike/`; they don't count.

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
| Field | A 2D grid shared by reference (velocity plus dye) | Frame rate |
| Value | Static configuration that changes rarely (a chord, a scale, a palette) | When edited |

## Rules every node follows

- **Pure window queries.** Events are computed from absolute time and inputs. No timers (`setInterval`, `setTimeout`, `requestAnimationFrame`) and no `Math.random`: use the seeded RNG ([ADR 0008](../decisions/0008-one-clock-window-queries.md)).
- **Live input uses the same code.** Canvas events arrive through `query` on a zero-width window. Don't special-case them.
- **Channels.** Every Event, Note and Signal port carries channels, and per-channel state is keyed by `channel`. Test with more than one channel ([ADR 0009](../decisions/0009-channels-from-day-one.md)).
- **Signals are sampled, not streamed.** Sample a Signal input at each event's timestamp. Audio-param targets get `setTargetAtTime` ramps.
- **Fan-in.** Several cables into an Event input merge in time order. Several cables into a Signal input are summed. A cable into a parameter is added to the knob's base value, scaled by the cable's depth.
- **Adapters do conversions.** Event → Signal is Sample & Hold or Envelope; Signal → Event is Threshold or Change. Nodes don't accept the wrong port type.
- **Hot patching keeps state.** State lives in a per-node-instance store the engine keeps when the node's id survives an edit.
- **Weird is fine, broken isn't.** Any input values, including NaN, huge, negative or empty, must give a defined result, never an exception. Runtime limits are enforced by the engine ([ADR 0011](../decisions/0011-runtime-safety-limits.md)); don't duplicate them in nodes.
