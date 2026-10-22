# Flow Patcher — Design Document

Oct 20, 2026 · @Chris Riebschlager

## Overview

Flow Patcher is a new browser-based node editor for music and visuals. You wire canvas input events, musical generators, synths, effects and a live fluid simulation into an instrument of your own. It is a new project. The original Flow app stays as it is and supplies the parts: sampled voices, synthesized percussion, the effects and output chain, the fluid solver and renderers, and its music-theory helpers.

The pitch: **the canvas is the controller, the patch is the instrument.** Every pointer, touch, key and wheel event on the performance canvas is available as an event source node. Tinkerers decide what each one does. A mousedown can strike a chord, a drag can sweep a filter, a pinch can charge a bloom, and the fluid's own currents can send notes back into the music.

The nearest relatives are TouchDesigner, cables.gl, Max/MSP, Pure Data, VCV Rack and Bitwig Grid. What sets this one apart: a fluid simulation is part of the graph. Music can push it, and it can feed signals back into the music.

## Audience and principles

The audience is tinkerers: people who want to plug odd things together, turn knobs and see what happens. They will read port labels and open an inspector. They don't need the zero-setup guidance that the original Flow was built around.

1. **Everything is patchable.** No behavior is hidden in app code. If the original Flow did something, a tinkerer can rebuild it from nodes and then break it in an interesting way.
2. **Input events are first-class sources.** Canvas events are not a fixed control scheme. They are a palette of event nodes, as raw or as refined as the patch wants.
3. **Hot patching, no compile step.** Changes to cables and knobs take effect on the next scheduling window, while sound keeps playing. Nothing requires a restart.
4. **Knobs everywhere.** Every numeric parameter is a knob with a range, a unit and a modulation input. Any parameter can be driven by a cable.
5. **Nothing silent or invisible is mysterious.** Every cable shows activity (event flashes, signal levels), and any port can be probed.
6. **Weird is allowed; broken is not.** Strange patches should produce strange results, never crashes, runaway feedback, clipped output or a frozen tab. Safety limits live in the runtime, not in the user's patch.
7. **Small, composable nodes beat big, smart ones.** Prefer Euclidean + Rotate + Probability over one "drum machine" node. Big nodes can exist later as saved subpatches.

## Core concepts

A **patch** is a graph of **nodes** joined by **cables**. Each node has typed input and output **ports**, plus **parameters** (knobs, menus, toggles) that are also inputs you can modulate. Port types, and their colors in the editor, decide what can connect to what.

| Port type | Carries | Rate | Examples |
| --- | --- | --- | --- |
| Event | Timestamped discrete messages with a payload (time, channel, fields) | Audio-clock time, sample-accurate | pointerdown, a Euclidean hit, a note |
| Note | An Event subtype: pitch, velocity, duration, plus optional articulation (attack, pan, filter) | Audio-clock time | Arpeggio output, chord-tone picker output |
| Signal | A continuous number, sampled whenever it is needed | Control rate, about 60 Hz, interpolated for audio | Pointer x, LFO, fluid density at a point |
| Audio | A Web Audio signal | Audio rate | Voice output, effect sends, the master bus |
| Field | A 2D grid shared by reference (velocity plus dye). Writers feed the Fluid through their Write output into its Writers input | Frame rate | The fluid simulation, a Splat's Write |
| Value | Data that changes rarely, read at each event's time and never scheduled. Its source answers for any time it has already been queried up to | Read at event times | The current chord, a scale, a palette |

Rules for connections:

- **Adapters do conversions.** Event → Signal is Sample & Hold or Envelope; Signal → Event is Threshold or Change. The editor offers to insert one when you drag an incompatible cable.
- **Every Event, Note and Signal port carries channels.** A pointer is really N pointers: up to 5 touches plus a mouse and a pen. Each event has a `channel` id and nodes keep per-channel state. Merge and Split nodes combine and separate channels. This is built in from day one, because adding it later would mean rewriting every node.
- **One output can feed many inputs.** Several cables can feed one Event input; their events merge in time order. Several cables into a Signal input are summed. Into a parameter, the cable is added to the knob's base value and scaled by a per-cable depth attenuator, as in modular synths.
- **Parameters are numbers or text.** Most are knobs and menus. Some are text, such as a chord string, and a preset menu can fill a text parameter; editing the text by hand sets the menu back to Custom.
- **Subpatches** wrap a group of nodes as one node with exposed ports and knobs. Presets and the node library build on them.

## Timing and evaluation

The graph runs on one clock, the Web Audio clock. Musical nodes are pure functions queried one window at a time. Every other choice in this document depends on this one.

**Window queries.** A single scheduler wakes every 25 ms. It asks the graph for every event in the next window, from `now` to `now + 120 ms` (the lookahead Flow already uses). Each Event node implements `query(t0, t1, inputs) → events[]`, similar to Strudel/Tidal patterns. A node never owns a timer. Generators such as Clock, Euclidean and Arpeggio compute their events from absolute time, so seeking, looping and live edits are deterministic.

**Live input is already in the past.** A pointerdown arrives at `now`, while the scheduler is working 120 ms ahead. Input events are stamped with `ctx.currentTime` plus a small safety offset (5 ms) and pushed straight down their cables. The scheduler does not wait for them. They pass through the same node code with `query` called on a zero-width window (stateful nodes downstream also re-run, below). As a result, a tap is scheduled within 20 ms of the touch: the offset plus the platform's input delay, which the M0 spike measured at up to about 11 ms on Android. Generated material keeps its full lookahead ([ADR 0017](decisions/0017-immediate-offset-and-catch-up.md)).

**Live and scheduled events meet out of order.** Immediate events carry times earlier than the scheduler's horizon, so a node fed by both a Clock and live input sees time go backwards. Stateless nodes don't care. For stateful nodes the engine rewinds: it snapshots their state at window boundaries, and when an immediate event lands at time t it restores the latest snapshot before t, replays the affected downstream nodes up to t to rebuild their state, re-runs them from t to the horizon with the event included, and replaces the events they had scheduled after t. Results then depend only on event times, not on when the scheduler woke, so recordings replay exactly. Node authors write nothing special, but node state must be cloneable plain data. If re-running breaks the tap budget, the fallback is to apply live state changes from the next window and accept that replays may differ ([ADR 0019](decisions/0019-live-events-rewind.md)).

**The transport.** Clock has a Transport output: a Value carrying the beat position for any queried time. Progression, and anything else counting beats, has a Transport input and reads it at an event's time. Two Clocks are fine, since each reader follows its own cable. A reader with no Transport cable stays at beat 0 (Progression holds its first chord) and shows a "no transport" hint. When the tempo or division changes, the beat and Phase re-anchor at the change time, and keep the old anchor for reads before that time, so a Phase read never jumps ([ADR 0018](decisions/0018-transport-on-a-cable.md)).

**Signals are sampled, not streamed.** When an Event node needs a Signal input (a velocity knob modulated by pointer y), it samples the Signal at each event's timestamp. Frame-rate signals (pointer, fluid) are held and linearly interpolated. Audio-param targets get `setTargetAtTime` ramps.

**Visual nodes run on the frame clock.** Each animation frame, the visual graph reads the events whose timestamps fell in the frame interval. That includes events scheduled earlier, so a splash appears as its note sounds. It then steps the fluid and renders. The frame clock runs behind `currentTime` by the output latency, so splashes land when their notes are heard, not when they are rendered. Immediate-path events skip that shift and reach visual nodes at once, so a tap's own splash appears under the finger ([ADR 0020](decisions/0020-tap-splash-skips-latency-shift.md)).

**The main thread stays free.** No main-thread task runs longer than about 4 ms *(tune)* while a patch plays, so a pointerdown never waits long for its handler. Fluid solving and coloring run off the main thread ([ADR 0016](decisions/0016-main-thread-budget.md)).

**Feedback is explicit.** Cycles are allowed, but each cycle must pass through a delay edge. Any Field → Signal read (for example Fluid Probe) counts as one implicitly: it returns the previous frame's value. The other is the Delay Edge node: a fixed delay of at least 10 ms, and the runtime never queries a window wider than it, so a cycle gives the same events however time is split into windows. A cycle with no delay is rejected when you connect it, and the cable flashes red.

**Lifetimes.** Hidden tabs extend the lookahead to 1.25 s, as Flow does now. A wake up to 100 ms past its horizon queries the stretch it missed and plays it late, moved to start now so its events keep their spacing. Longer stalls skip their windows rather than bursting them ([ADR 0017](decisions/0017-immediate-offset-and-catch-up.md)). The runtime limits polyphony (64 voices), events per window, feedback gain and output peak, whatever the patch asks for.

## Canvas event sources

Every browser event that is useful on a performance canvas becomes a source node, and each event fires down its cables with its full payload. Source nodes are raw and don't interpret anything; gesture recognizers, a separate layer of nodes, sit on top. A patch can use either, or both.

### Raw source nodes

| Node | Browser events | Outputs |
| --- | --- | --- |
| Pointer | pointerdown, pointermove, pointerup, pointercancel, pointerenter, pointerleave | Down, Move, Up, Cancel events per channel; X, Y, Pressure, Speed signals per channel; Count of active pointers |
| Pointer (high rate) | `getCoalescedEvents()`, `pointerrawupdate` where supported | Every sub-frame move sample, for smooth strokes and fast flicks |
| Click | click, dblclick, auxclick, contextmenu | Click, Double, Middle, Right events with position |
| Wheel | wheel (including macOS trackpad pinch, sent as wheel + ctrlKey) | DeltaX, DeltaY, Zoom events; accumulated X/Y/Zoom signals with a decay knob |
| Pen | Pointer events filtered to `pointerType: pen` | Tilt X/Y, Altitude, Azimuth, Twist, Tangential pressure, Barrel button |
| Touch extras | Touch contact size; Safari `gesturechange` | Contact width/height; native Scale and Rotation (Safari only) |
| Key | keydown, keyup while the canvas has focus | Down/Up events with `key`, `code`, `repeat`; a Held signal for each chosen key; a Keyboard → Note mode (two-row piano layout) |
| Canvas | resize, focus, blur, visibilitychange | Size signals and Focus/Blur/Hidden/Visible events, so patches can fade or pause cleanly |

Web MIDI in (notes and CCs) ships in v1, behind its own permission. Later sources in the same family, each also behind a permission: Gamepad (buttons and axes, polled each frame), Device motion and orientation (tilt as a controller on phones), and Microphone (level, onset and pitch).

### Event payload

Every input event carries the same base fields, so any downstream node can read any of them through a Get Field node.

| Field | Meaning |
| --- | --- |
| `time` | Audio-clock time the event is scheduled at |
| `channel` | Stable id for this pointer, touch or key for the life of the contact |
| `x`, `y` | Canvas position, normalized 0–1, with y = 0 at the top (the fluid's convention) |
| `dx`, `dy`, `speed`, `angle` | Motion since the previous sample for this channel, in canvas units per second |
| `pressure`, `width`, `height` | Contact force and size, where the hardware reports them (mouse: 0.5 while pressed) |
| `pointerType` | mouse, touch or pen |
| `button`, `buttons` | Which buttons changed, and which are held |
| `shift`, `alt`, `ctrl`, `meta` | Modifier keys held |
| `age` | Seconds since this channel's down event |

### Gesture recognizers

Recognizers consume raw events and emit higher-level ones. They are ordinary nodes with knobs, so thresholds can be tuned or modulated.

| Node | Emits | Key knobs |
| --- | --- | --- |
| Drag | Start, Move, End with start point, delta, distance, duration | Minimum distance |
| Tap | Tap, Double tap, Long press | Max movement, max duration, long-press time |
| Hold | Charge signal rising while held still; Release with charge amount | Stillness radius, charge time (this is Flow's Gather) |
| Flick | Flick on release above a speed, with direction and speed | Speed threshold |
| Circle | Orbit start, Angle signal, Revolutions, Direction, Orbit end | Minimum radius, closure tolerance (Flow's Orbit, with unwrapped angle) |
| Pinch | Pinch in, Spread, Scale and Rotation signals, midpoint | Pair selection, thresholds |
| Stroke | Per-stroke path length, curvature, average speed; Silk/Rush classification | Speed split point |
| Dwell | Fires when a pointer hovers in one spot (mouse and pen only) | Radius, time |
| Zone | Splits events by canvas region: grid cells, left/right, rings, or a drawn mask | Rows, columns, shape |
| Modifier Router | Routes events to different outputs by button or modifier (right-drag → output 2) | Mapping table |

### Who owns a pointer

In the original Flow, a pinch shouldn't also paint and a right-drag shouldn't drop notes. In a graph, every recognizer has two outputs: its gesture events, and a **Pass** output carrying the raw events it did not claim. A recognizer claims a channel once it is confident, for example when a pinch passes its threshold. From then on, that channel's events stop flowing out of Pass, and a Cancel goes to everything downstream of Pass. Chaining recognizers through Pass outputs sets priority: Pinch → Circle → Paint means pinch wins, circle next, and painting gets what's left. Flow's tool modes (Paint, Conduct, Space, Orbit) become a Switch node fed by a menu, a key or a Modifier Router.

### Platform rules the runtime handles

- The canvas sets `touch-action: none` and takes pointer capture on down. It suppresses the context menu only when a patch uses right-click.
- The first pointerdown also unlocks the AudioContext. That event is delivered normally, so the first touch makes a sound.
- In Play view the canvas has keyboard focus. In Patch view, keys go to the editor unless the preview canvas is focused. Escape always returns to the editor.
- Sources that need permission (MIDI, motion, microphone) ask only when a patch containing them first plays, and show a clear blocked state on the node if denied.

## Node catalog

The v1 catalog has about 60 small nodes in eight families. Canvas sources and recognizers are listed above; the families below complete it. Nodes marked ★ are ported from Flow's existing code.

### Time and rhythm

| Node | What it does |
| --- | --- |
| Clock | BPM, swing and a rate multiplier; emits ticks at a chosen division and a Phase signal, and outputs the beat position on its Transport port |
| Euclidean ★ | Hits and steps knobs, Rotate; outputs hits on clock ticks |
| Step Sequencer ★ | 16-step grid with off/ghost/hit/accent velocities (Flow's beat studio lane) |
| Probability ★ | Passes each event with chance p, from a separate seeded random stream |
| Quantize ★ | Delays events to the next grid line (quarter to 1/32, triplets) |
| Delay / Repeat | Shifts events in time; Repeat makes echo trains with decay |
| Humanize ★ | Timing and velocity jitter |
| Divide / Every N | Passes every Nth event, with an offset |
| Burst | Turns one event into N events spread over a time span |

### Harmony and pitch

| Node | What it does |
| --- | --- |
| Progression ★ | Parses chord strings (maj9, m9, dim7, sus2…); outputs the current chord as a Value, changing on the beat of its Transport input |
| Scale | Root and mode; outputs a pitch set |
| Chord Tone ★ | Maps a Signal (such as pointer x) to a chord tone across an octave range (Flow's horizontal pitch) |
| Arpeggio ★ | Up, down, up/down, outside-in or random-without-repeat, over a pool of 1–16 notes |
| Transpose / Octave | Shifts pitch by a fixed amount or a Signal |
| Snap to Scale | Moves any pitch to the nearest note in a set |
| Make Note | Event + pitch + velocity + length → Note, every field modulatable |

### Control and logic

| Node | What it does |
| --- | --- |
| Gate | Passes events while a Signal or toggle is high |
| Switch / Select | Routes events to one of N outputs by index |
| Merge / Split Channels | Combines or separates per-pointer channels |
| Counter | Counts events; wraps at N; outputs count as a Signal |
| Random | Seeded random value per event, or a smooth random Signal |
| Sample & Hold | Captures a Signal's value at each event |
| Envelope | Event → ADSR Signal |
| LFO | Sine, triangle, saw, square or random; tempo-synced or free |
| Math / Map Range / Curve / Smooth | Arithmetic and shaping for Signals |
| Threshold / Change | Signal → Event when a level is crossed or a value changes |
| Get Field | Pulls one payload field out of an event as a Signal |
| Delay Edge | Explicit fixed delay that closes cycles |

### Instruments

| Node | What it does |
| --- | --- |
| Sampled Voice ★ | Any of Flow's 28 WebAudioFont instruments, with per-note envelope, glide and filter |
| Drum Voice ★ | Any of the 20 synthesized percussion voices, including the tuned objects |
| Atmosphere ★ | The five seeded environment beds (rain, shore, wind, night, hearth) |
| Simple Synth | Oscillator + filter + envelope, for sounds Flow never had |

### Effects and mix

| Node | What it does |
| --- | --- |
| Reverb ★ | Convolution with the generated impulse |
| Delay ★ | Tempo-synced filtered feedback delay, divisions from 1/64 to two bars; feedback capped at 0.42 |
| Filter | Low-pass, high-pass or band-pass; cutoff and Q modulatable |
| Pan / Gain / Mixer | Basic routing and levels |
| Output ★ | Makeup gain, limiter, soft-knee peak guard, master level. Always exactly one per patch |

## Visual system

Visuals use a fixed set of music-shaped building blocks, centered on one fluid field, not a general shader graph. That keeps v1 buildable and keeps the identity: what you see is the music moving a medium.

### The fluid field

The Fluid node owns Flow's solver, ported to the GPU as WebGL2 shader passes: semi-Lagrangian advection, 20 Gauss-Seidel pressure iterations, vorticity confinement, and the aspect-following grid capped at 35,000 cells on desktop. It outputs a Field. Other nodes write into it or read from it:

- **Writers:** Splat (dye + impulse at a point, from any Event with x/y; a tap's splash lands at once, a scheduled one with its sound, see Timing), Force (a continuous push following a Signal pair), Stir (Flow's percussion roll, sweep and eddy impulses), Clear / Fade.
- **Readers:** Probe (density, speed and curl at a point, as Signals), Region Stats (average density or motion over a zone), Density Onset (fires an Event when local density crosses a threshold). Readers return the previous frame's value; see Feedback, under Timing.
- **Knobs:** vorticity, dissipation (color persistence), viscosity, grid budget.

A patch has at most one Fluid node. Running the solver on the GPU frees the main thread for the editor and the scheduler. Until the GPU solver lands, and as the fallback on weak devices, the CPU solver and its colorizer run in a Worker that hands back colored pixels ([ADR 0016](decisions/0016-main-thread-budget.md)). The GPU simulation layer is shared, not Fluid-specific, so later field nodes such as a particle system can sit beside the one Fluid node.

### Overlay and look nodes

| Node | What it draws |
| --- | --- |
| Ripple ★ | Expanding rings at an event's position; size and life from velocity and duration |
| Droplet ★ | A falling drop that lands at the event's time (pairs with Quantize) |
| Halo ★ | Envelope-shaped glow tied to a note's sound |
| Motes ★ | Particles carried by the fluid's velocity |
| Trace | A line following a pointer channel, with persistence |
| Orbit Rings ★ | Flow's rotating ellipses, driven by an Angle signal |
| Text ★ | Dye lettering (Flow's title card) |
| Palette ★ | Four-color palette as a Value; also an Index → Color node for color-by-channel or color-by-voice |
| Lighting ★ | Chord atmosphere: color cast, light direction and energy, from a chord Value |
| Renderer ★ | WebGL2 display with bloom, refraction and grain, falling back to Canvas2D. One per patch |

Visual nodes read events by timestamp on the frame clock, so a Ripple fed by a note appears as the note is heard, even though the note was scheduled 120 ms earlier. A tap's own events skip that latency shift and appear at once (Timing). Every overlay obeys reduced-motion: it keeps color, drops added motion.

### Escape hatch, later

A GLSL Shader node (a fragment shader with the Field, palette and a few Signals as uniforms) is a post-v1 option. It stays local-only until there is a sandboxing story for shared patches.

## Editor and UX

The editor has two views of the same running patch, with a live preview always showing. Sound never stops when you switch views.

The visual language (colors, type, spacing, port shapes, motion and the component set) lives in the design system at [`.claude/skills/flow-patcher-design/`](../.claude/skills/flow-patcher-design/readme.md). Its UI kit (`ui_kits/flow-patcher/index.html`) is a click-through of both views.

- **Patch view:** the node graph fills the window. The performance canvas sits in a resizable preview pane that you can play directly. Like cables.gl, the preview is always live.
- **Play view:** the canvas goes full-window, and only the knobs you have pinned show, as a small performance strip. This is how a finished instrument is played, and how a shared patch opens for someone who just wants to play it.

### Working with nodes

- Double-click or press Tab for a searchable node palette. Dragging a cable into empty space opens the palette filtered to compatible nodes.
- Connecting incompatible types offers the matching adapter (Event → Signal via Sample & Hold, and so on).
- Ports have a hit area larger than their drawn size, larger still for a coarse pointer, so a finger can start a cable.
- A cable's remove control stays reachable when the cable runs behind a node: it draws above the nodes, and selecting a cable anywhere along its path lets you remove it.
- Knobs: drag to turn, Shift for fine control, double-click to type a value, right-click to reset. A modulated knob shows its base value and a live ring for the modulated value.
- Any knob can be **pinned** to the Play view strip and renamed there.
- Select nodes and collapse them into a subpatch; choose which ports and knobs to expose.
- Undo/redo covers every edit. Copy and paste works between patches.

### Seeing what's happening

- Cables flash on events and glow with signal level. Audio cables show a small meter.
- Hover any port to see its last value or the last few events. Clicking pins a probe with a scrolling history (an event timeline or a signal scope).
- Nodes show errors inline: a denied permission, an instrument still loading, a cycle with no delay.
- A CPU/budget readout shows fluid step time, voices in use and events per window, with the runtime's limits marked.

### Starting points

The biggest risk for a node tool is the empty canvas. The app opens with a starter patch already playing. A small library of example patches teaches one idea each: "tap to play chords", "drag to sweep a filter", "Euclidean drums that stir the fluid", "the fluid plays itself". The original Flow, rebuilt as a patch, ships as the flagship example.

## Reuse from Flow

Flow Patcher is an independent project. It has no file or behavior compatibility with Flow: it doesn't read `.flow` files, and nothing has to match Flow's output. Flow is a source of code to borrow, and borrowed code becomes this project's to change.

About half of Flow's code is worth borrowing. Its pure functions and audio/visual engines become node internals. The 58 KB `app.js` glue, the tab UI, the community backend and the session recorder do not carry over. Flow's code and samples are GPL-3.0, so the new project is GPL-3.0 too.

| Flow module | Becomes | Work needed |
| --- | --- | --- |
| `music.js`: `parseChord`, `pitchesForRange`, `pitchForPosition`, progressions, instrument table | Progression, Chord Tone, Scale data | Copy as is |
| `rhythm.js`: `euclidean`, `rotatePattern`, `varyPattern`, grooves, kits | Euclidean, Step Sequencer, kit presets | Copy as is |
| `arpeggiator.js`: `arpNotes`, `patternOrder`, `arpEnvelope`, `arpGlide` | Arpeggio, envelope and glide on Sampled Voice | Copy as is |
| `quantize.js`, `timing.js` | Quantize, Delay divisions | Copy as is |
| `ArpEngine`, `RhythmEngine` | Nothing directly; their logic moves into `query()` nodes | **Rewrite.** They own `setInterval` timers and `getConfig`/`getClock` closures, and decide and schedule notes in one loop. Split them into pure window queries plus the shared scheduler |
| `AmbientAudio` (WebAudioFont loading, voices, envelopes) | Sampled Voice node + a shared instrument cache | Extract voice playback from app-level state; keep lazy loading |
| `PercussionSynth` | Drum Voice | Light wrapper |
| `environment.js` | Atmosphere | Light wrapper |
| `output.js` | Output node | **Adapt.** Chrome's compressor adds automatic makeup gain, so Flow's limiter overshoots to 1.0–1.3 on hot input and the guard hard-clips. Compensate for the makeup gain or lower the threshold, and replace the hard clip with a soft knee |
| `fluid.js`, `fluid-viewport.js` | Fluid node | Port the solver to GPU passes; keep the CPU version as the test reference and fallback, run in a Worker; expose splat/force/probe as methods |
| `fluid-renderer.js`, `gpu-fluid-renderer.js`, `water-surface.js` | Renderer node | Copy; take palette and energy as inputs |
| `visible-sound.js`, `orbit-rings.js`, `percussion-visuals.js`, `chord-atmosphere.js`, `dye-text.js` | Halo, Motes, Orbit Rings, Stir, Lighting, Text | Moderate: separate drawing from Flow's state |
| `gestures.js`, `performance.js` | Recognizer nodes | Moderate: split the mode-based controller into separate recognizers with Pass outputs |
| `palettes.js` | Palette | Copy as is |
| `vendor/` WebAudioFont + FluidR3 samples | Instrument assets | Copy with their notices |

Flow's regression approach also carries over: bit-exact fluid frames, byte-exact palette renders, native offline audio renders. Bring each module in together with its existing tests. From then on the tests and their golden files belong to this project and change with the code; they don't have to keep matching Flow.

## Persistence and sharing

A patch is a small JSON document, usually a few kilobytes. Sharing a patch is the main way people share work. Recordings are optional and cheap, because they record inputs, not audio.

### Patch format

- `format: "flowpatch"`, a `version`, and a random `seed`.
- `nodes[]`: id, type, type version, parameter values, editor position, pinned knobs.
- `cables[]`: from node/port to node/port, with a depth for modulation cables.
- `subpatches{}`: reusable definitions, referenced by id.
- No code, no samples, no media. Instruments are referenced by name, as Flow's sessions do.

Every node type has its own version number and, from M4 on, a migration function. Old patches load, and unknown node types load as inert placeholders that keep their cables, so nothing is silently dropped.

### Performance recordings

All randomness is seeded and all generators are pure window queries. So a performance can be recorded as the patch plus its **input event streams**: pointer, key and wheel events with timestamps. Replaying the inputs through the same patch reproduces the performance. This needs no note capture, unlike Flow's session format. One exception: patches that use live sources from outside the canvas (MIDI, mic, motion) also record those streams, and any fluid-feedback path is non-deterministic across machines. For those, Flow's approach of capturing emitted notes stays available as a fallback. WAV and video export render locally in real time, as Flow does today.

### Storage and community

- Local first: patches live in IndexedDB, with download/upload as `.flowpatch` files.
- Community (later): publish a patch with a title, author name and optional recording. Others can play it in Play view, open it in Patch view, and **remix** it (Flow's fork, applied to patches). Remixes credit their parent.
- Flow's text moderation gates, quotas and server-side canonicalization carry over. The server validates every node type and parameter against the catalog and strips unknown fields.
- Shared patches never contain executable code. A future Shader node would be stripped from public uploads, or rendered only after an explicit warning.

## Technical architecture

The runtime is a framework-free TypeScript engine that can run with no editor. The editor is a React app that edits a patch document and sends diffs to the engine. Keeping them separate means playback, export and Play view use the exact code the editor drives.

**Runtime architecture: one scheduler drives all sound; visuals read the same events each frame.**

```
Editor ──────────── edits ───────────▶ Graph compiler
React Flow + patch store               sorted plan, delay edges marked,
sends patch diffs                      cycles checked
                                              │
                                              │ new plan at the next window
┌ Engine · runs without the editor ───────────┼──────────────────────────────────┐
│                                             ▼                                  │
│  Canvas sources                         Scheduler                Audio nodes   │
│  pointer, touch, key, wheel             wakes every 25 ms,       voices,       │
│  stamped now + 5 ms                     asks for next 120 ms     effects,      │
│        │                                      │                  Output on the │
│        │                                      │ query(t0, t1)    Web Audio     │
│        │                                      ▼                  clock         │
│        └──── immediate path ──────────▶ Event nodes ── notes ──▶      ▲        │
│                                         pure window queries ──────────┘        │
│                                         notes, hits, triggers                  │
│                                           │          ▲                         │
│                                    events │          ┆ Fluid Probe returns     │
│                                           ▼          ┆ the previous frame      │
│                                         Visual nodes ┘                         │
│                                         fluid field, overlays,                 │
│                                         Renderer, every frame                  │
└────────────────────────────────────────────────────────────────────────────────┘
```

Generated material goes through the scheduler's 120 ms lookahead. Canvas input takes the immediate path into the same event nodes. Feedback from the fluid always arrives one frame late, which is why cycles are safe.

### Stack

- **Build:** Vite + TypeScript, deployed as a static site first. A backend (Workers + D1/R2, as Flow uses) is needed only once Community starts.
- **Editor:** React with React Flow (xyflow) for the canvas, cables and minimap; a small store such as Zustand holds the patch document; undo/redo works on document diffs.
- **Engine:** plain TS modules. A graph compiler turns the patch into a topologically sorted plan, with delay edges marked. The scheduler runs window queries on the Web Audio clock. A frame loop steps visual nodes.
- **Node definitions:** one file per node type: ports, parameters (range, unit, default), `query()` or `frame()`, and its migration function. The palette, inspector and server validation are all generated from these definitions.
- **Audio:** Web Audio, with WebAudioFont for samples. AudioWorklet only for export capture, as in Flow.
- **Visuals:** the fluid solver on the GPU as WebGL2 shader passes, sharing a context with the display. The CPU solver, used until then and as the fallback, runs in a Worker. Readers (Probe, Region Stats, Density Onset) use an async readback one frame late, so the solver never stalls the main thread.

### Hot patching

An edit produces a new plan. The scheduler swaps plans at the next window boundary. Nodes keep their state when their id survives the edit: arpeggio position, held notes, per-channel recognizer state. Future events already scheduled from removed or changed nodes are cancelled; notes already sounding finish their release. Live input cancels and replaces scheduled events the same way when it rewinds a node's state (Timing).

### Budgets

| Resource | Limit | Enforced by |
| --- | --- | --- |
| Fluid step | GPU step target to be measured. CPU, in a Worker: about 8 ms at 35,000 cells on desktop, about 31 ms with coloring on the Surface; mobile capped at 16,128 cells | Grid budget knob, capped by device class |
| Main thread | No task over about 4 ms *(tune)* while a patch plays | Fluid work in a Worker or on the GPU; the immediate-path checks run with the Fluid stepping |
| Voices | 64 simultaneous, oldest stolen first | Runtime voice pool |
| Events per window | 256 per node, 2,048 per patch | Scheduler; excess dropped with a warning on the node |
| Feedback | Delay feedback at most 0.42; event cycles need a delay edge | Node limits, graph compiler |
| Output | Peak guard and limiter on the single Output node | Output node, which can't be removed |

## Milestones

There are six milestones, and each one starts only after the previous gate passes. M0 is a throwaway spike that tests whether patching is fun before any engine work begins.

**Roadmap: six milestones, each behind a gate; rebuilding Flow as a patch is the key test.**

| Milestone | Scope | Gate to pass before the next one |
| --- | --- | --- |
| M0 · Spike | Eight node types, one patch, throwaway code: Pointer, Clock, Euclidean, Progression, Chord Tone, Sampled Voice, Output, Fluid with Splat and Renderer | Patching feels fun, and taps sound immediately |
| M1 · Engine core | Typed ports and channels, graph compiler, window scheduler, hot patching, probes, undo/redo | Live edits never glitch the audio |
| M2 · Canvas event sources | Every raw source node and payload field, the recognizers with Pass and claim, Zone, Modifier Router | Flow's Paint, Conduct, Space and Orbit rebuilt from recognizers |
| M3 · Flow as a patch | Port every starred node with its tests; ship the original Flow as the flagship example patch | The Flow patch feels like Flow |
| M4 · Play and keep | Play view, pinned knobs, local library, input recordings, WAV and video export | Someone else can open a shared file, play it and remix it |
| M5 · Community | Publish, browse, play and remix patches, with Flow's moderation gates and quotas | — |

M3 is the acceptance test for the whole design: if today's Flow can't be rebuilt from nodes, the node vocabulary is wrong, so fix it before adding Play view or Community. It tests the vocabulary, not compatibility: the patch has to feel like Flow, not match it note for note.

## Risks and open questions

The biggest risk is scope: TouchDesigner and cables.gl took years. The fixed visual vocabulary and the milestone gates are the main defenses.

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Scope creep on visuals | "Any visual" turns into a shader IDE | Fixed set of building blocks in v1; Shader node is post-v1 and local-only |
| Window queries feel wrong for live input | Taps must feel immediate, not 120 ms late | Zero-width immediate path for input events (Timing). M0 measured a worst tap of 14.6–16.2 ms on the reference devices, and taps felt immediate |
| Bluetooth output latency | Over Bluetooth, a tap's sound and splash arrive 200+ ms late | Nothing the patch can fix for sound. A tap's own splash skips the output-latency shift and appears under the finger at once, so over Bluetooth it comes before its sound; scheduled splashes stay synced to theirs ([ADR 0020](decisions/0020-tap-splash-skips-latency-shift.md)) |
| Channel model is awkward | Most cables carry one channel, yet every node pays for N | Single-channel fast path; Merge/Split hidden until needed |
| Pointer ownership is confusing | Pinch also paints; right-drag also drops notes | Pass outputs with claim + Cancel; example patches that show the pattern |
| GPU readback stalls or weak mobile GPUs | Reader nodes need field values on the CPU; a synchronous read blocks the frame | Async readback one frame late; CPU solver as fallback on weak devices |
| Mobile | Node editing on a phone is hard | Phones get Play view only in v1; editing is desktop/tablet |

### Decisions

- [x] Name: the project is called Flow Patcher.
- [x] Flow Patcher is independent of Flow: no `.flow` file support and no output parity. Flow's code is borrowed and adapted freely.
- [x] Flow's tool modes (Paint, Conduct, Space, Orbit) don't ship as library subpatches; they are what people compose from nodes.
- [x] Web MIDI is in v1.
- [x] A patch has a single canvas.
- [x] Community comes after v1.
- [x] The transport travels on a cable from Clock; there is no patch-wide transport ([ADR 0018](decisions/0018-transport-on-a-cable.md)).
- [x] Live events rewind stateful nodes and re-query, so results depend only on event times ([ADR 0019](decisions/0019-live-events-rewind.md)).
- [x] A tap's own splash skips the output-latency shift ([ADR 0020](decisions/0020-tap-splash-skips-latency-shift.md)).
