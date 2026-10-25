# Milestones

Seven milestones. Each one starts only after the previous gate passes. The source is the roadmap in [design.md](design.md#milestones). M0–M2 are kept as written when they passed. After M2 the project refocused ([ADR 0036](decisions/0036-refocus-after-m2.md)): from M3 on, a gate is a feature checklist with tests, and Chris decides when the instrument is good enough to move on.

**Current milestone: M3 · Jam basics.**

## How to use this file

- Work only on the current milestone. If a task needs something from a later milestone, stop and say so instead of building it.
- A gate passes when every check is green in CI and Chris has signed off. Tick the boxes here in the same PR that passes the gate, and update "Current milestone" above.
- The harness (`pnpm check`, `pnpm e2e`, `pnpm run-patch`, the engine-boundary lint rule and CI) was built ahead of M0, so it exists in every milestone. It doesn't cover `spike/`. See `AGENTS.md`.
- Thresholds marked *(tune)* are starting points. Change them only with a note in the PR saying why.
- Flow Patcher is independent of Flow. No check compares against Flow's files or output; borrowed code is tested against golden files generated in this repo.
- **Reference setup:** desktop Chrome on Chris's Mac, with a MIDI controller. M0–M2 also checked an Android phone and a Surface tablet; from M3 on, phones and tablets aren't targets.
- **Catalog nodes** not listed in a milestone land when a patch needs them. The rest of the catalog, ★ or not, isn't scheduled ([Parked](#parked)).

---

## M0 · Spike

**Goal:** find out whether patching is fun before any engine work.

**Scope**
- Eight node types in one patch: Pointer, Clock, Euclidean, Progression, Chord Tone, Sampled Voice, Output, and Fluid with Splat and Renderer.
- A minimal editor that can add nodes, connect cables and turn knobs while sound plays.
- The immediate path for live input (stamp with `ctx.currentTime` + ~10 ms) and window queries for the Clock/Euclidean path, because those are the two timing ideas the spike has to test.

**Rules**
- Throwaway code. It lives in `spike/` and nothing in `packages/` imports from it.
- No harness for spike/, no persistence, no undo, no channels beyond one pointer. Move fast. `pnpm spike` serves it on the LAN for the reference devices.
- Flow modules may be copied in raw; clean porting happens in M3.

**Gate: patching feels fun, and taps sound immediately** — passed 2026-10-21; measurements in [spike-notes.md](spike-notes.md).

Automated
- [x] None required.

Measured (logged in the spike and written into the notes below)
- [x] Tap-to-sound latency: the note's scheduled time minus the pointerdown's audio-clock time is ≤ 20 ms on every reference device.
- [x] Rewiring a cable while the Clock runs causes no audible gap (listen test plus a console count of skipped windows).

Human
- [x] Chris patches for a session, rewires live, and wants to keep going.
- [x] Taps feel immediate on every reference device.
- [x] `docs/spike-notes.md` lists what the spike taught and any design changes it implies. Those changes go into `design.md` before M1 starts.

---

## M1 · Engine core

**Goal:** the engine the rest of the product is built on, with the harness that lets agents check their own work.

**Scope**
1. **Harness** (setup guide Step 2): already built before M0 (monorepo, `pnpm check`, `pnpm e2e`, `pnpm run-patch`, the engine-boundary lint rule, CI). M1 extends it as the gate checks below need.
2. **Types and channels:** the six port types, per-event `channel`, fan-in rules (Event merge in time order, Signal sum, parameter = base + depth × cable).
3. **Graph compiler:** topologically sorted plan, delay edges marked, cycles without a delay edge rejected.
4. **Scheduler:** 25 ms wake, 120 ms lookahead, 1.25 s when the tab is hidden; a wake up to 100 ms past its horizon catches up, keeping its events' spacing, and longer stalls skip missed windows; immediate path for input events at `currentTime + 5 ms` ([ADR 0017](decisions/0017-immediate-offset-and-catch-up.md), [0027](decisions/0027-immediate-notes-within-one-clock-step.md)).
5. **Hot patching:** plan swap at the next window boundary; node state kept when the id survives; future events from removed or changed nodes cancelled; sounding notes finish their release.
6. **Runtime limits:** 256 events per node and 2,048 per patch per window, excess dropped with a warning on the node; seeded RNG, no `Math.random` in engine or nodes.
7. **Patch format v1:** load/save. Patches record the format version and each node's type version from the start, but migrations and placeholders wait for M4. Until then, a breaking node change updates the example patches and fixtures instead.
8. **Editor:** typed port colors, connection rules, adapter offer on incompatible cables, knobs with modulation rings, text params with preset menus, port hit areas larger than drawn, a cable remove control that stays reachable behind nodes, probes (hover value, pinned history), undo/redo on document diffs.
9. **Nodes:** the M0 set rebuilt properly (Fluid on the CPU solver in a Worker for now, with its colorizer, per [ADR 0016](decisions/0016-main-thread-budget.md)), plus Delay Edge, Probability, Make Note, and Sample & Hold and Threshold/Change so the adapter offer has one adapter in each direction. The Milestone column in `docs/nodes/` lists them. Other nodes follow the unstarred-node rule above.

**Gate: live edits never glitch the audio**

Automated
- [x] `pnpm check` and `pnpm e2e` are green in CI.
- [x] **Determinism:** the same patch and seed, run twice headless, gives byte-identical event logs.
- [x] **Window independence:** querying 0–10 s in 25 ms steps, in 100 ms steps and in one call gives identical events for every generator node.
- [x] **Hot swap:** a headless run of a Clock → Euclidean → Probability → Make Note → Sampled Voice patch with 100 scripted edits (knob change, cable add/remove, node add/remove) shows no duplicated events, no missing events from nodes the edit didn't touch, no events from removed nodes after the swap, and preserved state for surviving ids.
- [x] **No late events:** across the e2e edit run, no scheduled event is handed to Web Audio with `time < ctx.currentTime`, and a tap's own note is at most one audio clock step late ([ADR 0027](decisions/0027-immediate-notes-within-one-clock-step.md)).
- [x] **Stalls:** a simulated 500 ms main-thread stall skips the missed windows; no burst of more than one window's events afterwards.
- [x] **Catch-up:** a simulated 150 ms stall loses no events, and no two caught-up events from one stream land on the same time.
- [x] **Offline audio:** an `OfflineAudioContext` render of a sustained patch with edits applied via `suspend()` has no silent gap longer than 5 ms *(tune)* and no peak above the Output ceiling.
- [x] **Immediate path:** a scripted pointerdown produces a note at `currentTime + 5 ms ± 2 ms` *(tune)*, without waiting for the next scheduler wake.
- [x] **Immediate path under load:** with a Fluid stepping and a Renderer drawing, the worst of 30 scripted taps is ≤ offset + 7 ms from pointerdown to the note's time *(tune)*. That bound fails if the fluid runs on the main thread ([ADR 0016](decisions/0016-main-thread-budget.md)).
- [x] **Transport:** across a tempo change mid-run, Phase is continuous and the beat count never repeats or skips; Progression gives the same chords queried in 25 ms windows and in one call.
- [x] **Output guard:** in an offline render of a hot patch (four full-scale saws), under 0.1 % of samples reach the Output ceiling *(tune)*.
- [x] **Compiler:** a cycle with no delay edge is rejected; the same cycle through Delay Edge compiles.
- [x] **Limits:** a node emitting 1,000 events per window is capped at 256 with a warning; a patch over 2,048 is capped.
- [x] **Format:** every example patch survives save → load → save byte-identical, with format and node type versions present.
- [x] **Boundary:** the lint rule fails on a deliberate DOM import in `packages/engine` (tested), and passes on the real code.

Human
- [x] Chris edits a playing patch in the editor for 10 minutes and hears no glitch.

---

## M2 · Canvas event sources

**Goal:** the canvas becomes the controller: every raw source, every payload field, and recognizers that can share a pointer.

**Scope**
- Every raw source node: Pointer, Pointer (high rate), Click, Wheel, Pen, Touch extras, Key, Canvas, and Web MIDI in (v1 decision), each with every payload field in the design.
- All recognizers: Drag, Tap, Hold, Flick, Circle, Pinch, Stroke, Dwell, Zone, Modifier Router, each with a Pass output, claim and Cancel.
- Platform rules: `touch-action: none`, pointer capture, context menu suppressed only when a patch uses right-click, the first pointerdown unlocks audio and still sounds, keyboard focus rules, permission prompts on first play with a blocked state on the node.
- **Input stream format:** timestamped canvas events as JSON ([ADR 0029](decisions/0029-input-stream-format.md)). Tests use it now; M4 recordings reuse it.
- Recognizers chain on one phase-tagged stream, and a claim is a Cancel on Pass ([ADR 0028](decisions/0028-recognizers-pass-claim-cancel.md)).
- Port `gestures.js` / `performance.js` tests where they map onto a recognizer.
- The nodes the mode patches need: Switch/Select, Filter, Pan/Gain/Mixer, Math/Map Range/Curve/Smooth, Get Field and Force (unstarred, so they land here), and the ★ nodes Reverb, Delay and Orbit Rings, brought forward from M3 because Space and Orbit need them.

**Gate: Flow's Paint, Conduct, Space and Orbit rebuilt from recognizers**

Automated
- [x] Four example patches, `examples/modes/{paint,conduct,space,orbit}.flowpatch`, use only catalog node types (checked by a test that rejects any node type not in `packages/nodes`).
- [x] Each mode patch has scripted input streams and an expected event log, and replay matches it exactly, twice in a row.
- [x] **Ownership:** a stream that starts painting and then pinches with a second finger yields no paint events from the claimed channels after the claim, and exactly one Cancel per claimed channel downstream of Pass ([ADR 0028](decisions/0028-recognizers-pass-claim-cancel.md)).
- [x] **Payload:** Playwright drives synthetic mouse, touch, pen, wheel and key input; every source node emits every documented field, with `x`, `y` in 0–1 and `y = 0` at the top.
- [x] **First touch:** in e2e, the first pointerdown on a fresh page both resumes the AudioContext and produces its note.
- [x] **Permissions:** with MIDI denied, the MIDI node shows its blocked state and the rest of the patch plays.
- [x] Every new node has a unit test and an example patch.

Human
- [x] Chris plays each mode patch on every reference device, and each one does the job of its Flow mode well enough that Chris would play it.

---

## M3 · Jam basics

**Goal:** open a patch, map a controller to it, and leave it drifting for a long time.

**Scope**
- **Local library:** save, load, rename and delete patches in IndexedDB; download and upload `.flowpatch` files. Migrations start here: a migration function per node type version, and unknown node types load as inert placeholders that keep their cables. From here on, changing a node's params needs a migration and a test.
- **MIDI learn:** any knob can learn a MIDI CC (right-click → Learn, then move a control). The mapping is saved in the patch, works whichever node is selected, and shows on the knob. Builds on MIDI In's access and permission handling.
- **Slow time:** LFO (tempo-synced or free, periods up to many minutes), Random as a seeded smooth drift, and a Ramp that runs over bars or minutes. Pure `query()` nodes, deterministic for a seed and transport.
- **Drones and pads:** Atmosphere ★, and a sustained source with several detuned oscillators and slow movement (a Drone node, or Simple Synth extended, decided in the issue).
- **Housekeeping:** #119 (swap build leak), #122 (Pointer same-stamp up+down), Chris's decision on [ADR 0035](decisions/0035-retired-audio-chains-ring-out-together.md); millisecond timing e2e bounds that flake on CI loosened or quarantined, with the headless determinism, hot-swap and offline-audio tests kept as they are.

**Gate: a drifting patch that's mine to keep**
- [ ] `pnpm check` and `pnpm e2e` are green in CI.
- [ ] Library e2e: a patch is saved, the page reloads, the patch opens from the library and its event log over 10 s matches the log before saving. Download → upload gives the same file.
- [ ] Migrations: a fixture patch at an older node type version migrates and plays; an unknown node type round-trips unchanged with its cables.
- [ ] MIDI learn: with a mocked MIDI input in e2e, a learned CC moves its knob, and the mapping survives save and reload.
- [ ] Slow-time nodes are window-independent (the M1 check) and an LFO's phase is continuous across a tempo change.
- [ ] `examples/drift.flowpatch` uses slow-time modulators on a drone; every new node has a unit test and an example patch.
- [ ] Chris plays the drift patch with a controller and signs off.

---

## M4 · Scenes

**Goal:** a patch moves through states on its own.

**Scope**
- **Scenes:** capture the current knob values as a numbered scene; recall one, or morph to it over a set time. Scenes are saved in the patch. A morph is knob edits on the engine's existing in-place path, not a plan swap.
- **Scene node:** chooses the scene. Inputs: an Event that advances, and a Select. Rules: advance after N bars, with a probability, or by Markov-style weights from one scene to the next. Outputs the current scene as a Value and an Event on each change, so the patch can react. Seeded and pure, like every generator.
- **Subpatches and macro knobs:** collapse a selection into a subpatch and choose which ports and knobs it exposes; save it to the library to reuse. A macro knob drives several params, each with its own depth.
- **Modulated effects:** Chorus, Phaser, Flanger, Saturation and a Filter Bank, every main param modulatable.
- **Musical ★ nodes:** Step Sequencer, Quantize, Humanize, and Arpeggio checked against the catalog.

**Gate: the patch plays itself through scenes**
- [ ] `pnpm check` and `pnpm e2e` are green in CI.
- [ ] A Scene node patch replays twice to identical event logs, through at least four scene changes.
- [ ] A morph between scenes has no silent gap and no peak above the ceiling in an offline render (the M1 offline-audio check, applied to morphs).
- [ ] A subpatch round-trips through save and load, and through the library into another patch.
- [ ] Every new node has a unit test and an example patch, including `examples/scenes.flowpatch`.
- [ ] Chris leaves the scenes patch running for 20 minutes and signs off.

---

## M5 · Texture

**Goal:** the sound gets rich.

**Scope**
- **Granular:** grain clouds from the sampled instruments, with position, density, grain size, pitch spray and pan spray all modulatable, inside the voice budget.
- **Drum Voice ★**, and further sources or effects jamming shows a need for (for example a resonator or shimmer), each decided in its own issue.

**Gate: texture within budget**
- [ ] `pnpm check` and `pnpm e2e` are green in CI.
- [ ] A dense granular patch runs a 5-minute headless session with ≤ 64 voices and no event-cap warnings, and an offline render stays under the Output ceiling.
- [ ] Every new node has a unit test and an example patch.
- [ ] Chris signs off.

---

## M6 · Look

**Goal:** visuals that don't all look the same, for little effort.

**Scope:** decided when M6 starts. Candidates: Palette ★, a few cheap overlays from the catalog (Ripple, Halo), visuals that show the music's structure (the current scene, voices), or a local-only Shader node.

**Gate:** set with the scope.

---

## Parked

Not on the roadmap. Each can come back as a milestone if jamming shows a need.

- GPU fluid ([ADR 0003](decisions/0003-gpu-fluid-one-node.md)); the CPU solver in a Worker is the fluid on desktop.
- Flow as a patch: `examples/flow.flowpatch`, and the ★ nodes no milestone above names (Droplet, Motes, Text, Lighting, Stir, the full Renderer).
- Fluid readers beyond Get Field (Probe, Region Stats, Density Onset) until a patch needs them.
- Play view and pinned-knob strip, the starter patch on open, phones and tablets.
- Input recordings, WAV and video export.
- Community: publish, browse, remix.
- Live resampling, microphone and camera input.
