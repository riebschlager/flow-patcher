# Milestones

Six milestones. Each one starts only after the previous gate passes. The source is the roadmap in [design.md](design.md#milestones); this file turns each gate into checks an agent can run, plus a human sign-off for the parts no test can judge.

**Current milestone: M2.**

## How to use this file

- Work only on the current milestone. If a task needs something from a later milestone, stop and say so instead of building it.
- A gate passes when every **Automated** check is green in CI and Chris has signed off on every **Human** check. Tick the boxes here in the same PR that passes the gate, and update "Current milestone" above.
- The harness (`pnpm check`, `pnpm e2e`, `pnpm run-patch`, the engine-boundary lint rule and CI) was built ahead of M0, so it exists in every milestone. It doesn't cover `spike/`. See `AGENTS.md`.
- Thresholds marked *(tune)* are starting points. Change them only with a note in the PR saying why.
- Flow Patcher is independent of Flow. No check compares against Flow's files or output; borrowed code is tested against golden files generated in this repo.
- **Reference devices** for every touch or "on device" check: desktop Chrome, Chris's Android phone and Chris's Surface tablet.
- **Unstarred nodes** (Scale, Burst, LFO, Filter, Simple Synth, Trace and the rest of the catalog without ★) land in the first milestone whose gate needs them. M3 finishes any left over, so the v1 catalog is complete before Play view.

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
- **Input stream format:** timestamped canvas events as JSON. Tests use it now; M4 recordings reuse it.
- Port `gestures.js` / `performance.js` tests where they map onto a recognizer.

**Gate: Flow's Paint, Conduct, Space and Orbit rebuilt from recognizers**

Automated
- [ ] Four example patches, `examples/modes/{paint,conduct,space,orbit}.flowpatch`, use only catalog node types (checked by a test that rejects any node type not in `packages/nodes`).
- [ ] Each mode patch has scripted input streams and an expected event log, and replay matches it exactly, twice in a row.
- [ ] **Ownership:** a stream that starts painting and then pinches with a second finger yields no paint events from the claimed channels after the claim, and exactly one Cancel downstream of Pass.
- [ ] **Payload:** Playwright drives synthetic mouse, touch, pen, wheel and key input; every source node emits every documented field, with `x`, `y` in 0–1 and `y = 0` at the top.
- [ ] **First touch:** in e2e, the first pointerdown on a fresh page both resumes the AudioContext and produces its note.
- [ ] **Permissions:** with MIDI denied, the MIDI node shows its blocked state and the rest of the patch plays.
- [ ] Every new node has a unit test and an example patch.

Human
- [ ] Chris plays each mode patch on every reference device, and each one does the job of its Flow mode well enough that Chris would play it.

---

## M3 · Flow as a patch

**Goal:** the acceptance test for the whole design. If today's Flow can't be rebuilt from nodes, the vocabulary is wrong: fix the vocabulary (and `design.md`) before going on. This tests the vocabulary, not compatibility: the patch has to feel like Flow, not match it.

**Scope**
- Port every ★ node with its Flow tests, following the Reuse-from-Flow table and adapting the code freely: Euclidean, Step Sequencer, Probability, Quantize, Humanize, Progression, Chord Tone, Arpeggio, Sampled Voice, Drum Voice, Atmosphere, Reverb, Delay, Output, Ripple, Droplet, Halo, Motes, Orbit Rings, Text, Palette, Lighting, Renderer.
- Fluid on the GPU (WebGL2 passes) with the CPU solver kept as the test reference and fallback; Splat, Force, Stir, Clear/Fade; Probe, Region Stats, Density Onset with async readback one frame late.
- Rewrite `ArpEngine` / `RhythmEngine` logic as pure `query()` nodes.
- Every unstarred catalog node not built yet, so the v1 catalog is complete.
- `examples/flow.flowpatch`, the flagship, plus the one-idea examples: "tap to play chords", "drag to sweep a filter", "Euclidean drums that stir the fluid", "the fluid plays itself".

**Gate: the Flow patch feels like Flow**

Automated
- [ ] Tests brought in with ported modules pass: bit-exact CPU fluid frames, byte-exact palette renders, offline audio renders, against golden files generated in this repo.
- [ ] GPU fluid matches the CPU reference within tolerance (tolerance set when first measured, then fixed).
- [ ] **Budgets:** the Flow patch runs a 5-minute scripted session with ≤ 64 voices, no event-cap warnings, and fluid step time logged against the budget.
- [ ] `flow.flowpatch` and every example use only catalog node types; every example has a scripted input stream and expected event log that replays exactly.
- [ ] Every ★ node has a unit test and an example patch.

Human
- [ ] Chris plays the Flow patch on every reference device and it captures what Flow feels like to play.
- [ ] Any node or behavior added to make the Flow patch work is a general-purpose node recorded in `design.md`, not a Flow-specific special case.

---

## M4 · Play and keep

**Goal:** a finished patch can be played, saved, recorded, exported and handed to someone else.

**Scope**
- Play view (full-window canvas, pinned-knob strip, renamed pins); phones get Play view only.
- The app opens with a starter patch already playing.
- Local library in IndexedDB; download/upload `.flowpatch` files.
- Patch migrations: a migration function per node type version, and unknown node types load as inert placeholders that keep their cables. From here on, changing a node's params needs a migration.
- Input recordings (patch + input streams), with Flow-style note capture as the fallback for MIDI, mic, motion and fluid-feedback paths.
- WAV and video export, rendered locally in real time.

**Gate: someone else can open a shared file, play it and remix it**

Automated
- [ ] **Hand-off e2e:** save a patch → download `.flowpatch` → upload it in a fresh browser profile → it opens in Play view and a scripted input stream produces the expected event log → switch to Patch view, edit, save as new → the original file is unchanged.
- [ ] **Recording round trip:** record a scripted performance, reload it in a fresh profile, replay → identical event log.
- [ ] **Fallback:** a patch with a MIDI source records emitted notes, and playback reproduces them.
- [ ] **Migrations:** fixture patches with an older node type version migrate and play; an unknown node type round-trips unchanged with its cables.
- [ ] **Export:** a WAV export of a reference patch matches its offline render within a loudness tolerance *(tune)*; a video export has the expected duration and frame count.
- [ ] **Mobile:** in Playwright mobile emulation, a shared patch opens in Play view with no editor UI.

Human
- [ ] Someone other than Chris receives a `.flowpatch` file and plays and remixes it without help.

---

## M5 · Community

**Goal:** publish, browse, play and remix patches online. Comes after v1.

**Scope**
- Backend on Workers + D1/R2, as Flow uses.
- Publish with title, author name and optional recording; browse; play in Play view; open in Patch view; remix with credit to the parent.
- Flow's text moderation gates, quotas and server-side canonicalization.
- Server validates every node type and parameter against the catalog generated from node definitions and strips unknown fields. Shared patches never contain executable code.

**Done when** (last milestone, so no gate)

Automated
- [ ] Ported moderation and quota tests pass.
- [ ] The server rejects unknown node types and out-of-range parameters, and strips unknown fields.
- [ ] A remix records its parent, and the parent's page lists it.
- [ ] End-to-end: publish → browse → play → remix → publish the remix, as two different users.

Human
- [ ] Chris publishes, and someone else finds, plays and remixes the patch.
