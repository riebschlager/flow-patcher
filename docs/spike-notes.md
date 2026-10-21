# M0 spike notes

What the M0 spike (`spike/`, issues #2 and #4–#9) measured and taught, and the design changes that follow. The gate is in [milestones.md](milestones.md#m0--spike).

## How to measure

1. Run `pnpm spike` and open the LAN address it prints on the device.
2. Press **Demo**. It replaces the canvas with the full M0 patch, so every device measures the same graph:
   - The beat: Clock → Euclidean → Chord Tone (chords from Progression) → Sampled Voice → Output, with a coral Splat on each hit.
   - The tap: Pointer → a second Chord Tone, an octave up, into the same voice, and Pointer → a lilac Splat that paints the drag.
   - Splats → Fluid → Renderer.
3. Tap the canvas once to start audio. Then open **Report**, press **Reset** and close it.
4. Tap about 30 times, spread over the canvas.
5. Rewire about 10 times while the Clock plays. For example, remove the Euclidean → Chord Tone cable and drag it back, and listen for a gap.
6. Leave the patch running for 10 s. Then open **Report** and copy the text into the table below. The text is selectable, because the LAN page has no clipboard API.

The report measures:
- **Tap-to-sound**: the note's scheduled time minus the pointerdown's time on the audio clock, for warm taps only. A cold tap includes the AudioContext starting up, so it is left out. Output latency comes on top and is reported separately.
- **Rewiring**: windows skipped from the start of a cable drag until 1 s after any cable is added or removed.
- **Fluid step**: the solver's step time per frame, as a running average, p95 over the last 600 steps, and max.

## Measurements

Gate: tap-to-sound ≤ 20 ms on every reference device, and no audible gap while rewiring.

| Device | Taps (n) | Tap-to-sound median / worst | Output latency | Rewires, windows skipped | Fluid step avg / p95 / max (grid) |
| --- | --- | --- | --- | --- | --- |
| Headless Chromium 156, Playwright on Chris's Mac (provisional, two runs) | 30 + 30 | 15.5 / 20.2 ms; 16.1 / 21.7 ms | 216 ms (headless) | 20 edits, 0 skipped | 7.7 / 7.9 / 8.6 ms (149×233) |
| Desktop Chrome | | | | | |
| Android phone | | | | | |
| Surface tablet | | | | | |

The headless row is a stand-in until Chris fills in the reference devices. Headless output latency doesn't reflect real hardware.

### Tap latency and the fluid

On the same headless browser, the tap-to-sound worst case depends on whether the patch has a fluid:

| Patch | Median | Worst |
| --- | --- | --- |
| Pointer → Chord Tone → Sampled Voice → Output | 10.6 ms | 13.5 ms |
| Full demo patch (adds the Clock path, Fluid, two Splats and Renderer) | 16.1 ms | 21.7 ms |

The immediate path itself adds 10 ms by design. The rest is how long the pointerdown waited before its handler ran. With the fluid, a tap that arrives during a frame waits for that frame's solver step (about 8 ms) and render (about 1 ms) to finish. So the immediate path is fast enough, but a CPU fluid on the main thread uses up most of the gate's margin.

## What felt fun, and what didn't

*Chris, after a session with the demo patch on each device.*

- Fun:
- Not fun:
- Rewiring live:
- Taps on each device:

## What the spike taught

Timing
- **Window queries work for generated material.** Over several sessions, rewiring, knob turns, BPM, division and swing changes and adding or removing nodes never skipped a window or produced a late event (PRs #10, #12, #14, and this run). Euclidean and Progression gave identical notes whether queried as one window or as 25 ms and 17.3 ms windows.
- **The immediate path works.** Taps alone land at 10.6–13.5 ms (PR #11 and above). The only threat to the gate is other work on the main thread.
- **Live input is behind the scheduler.** `push()` stamps events at now + 10 ms, earlier than the scheduler's horizon. A stateful node fed by both a Clock and live input therefore sees time go backwards (PR #10).
- **Phase after a tempo change.** The re-anchor applies at the window start, up to 120 ms ahead, so a Phase reading for an earlier time jumps (PR #10).
- **Hidden tab.** While the tab is hidden, edits lag by up to 1.25 s, the hidden lookahead (PR #10).
- **Stalls skip cleanly.** A 500 ms stall skips 17 windows with no burst and nothing late (PR #10).

Ports and params
- **Value is a port type of its own.** A chord is rarely-changing data read at each event's time, not an event or a signal. The source keeps it only for windows already queried. The immediate path is still covered, because the scheduler is always ahead of a tap (PR #12).
- **The beat count wants a transport.** The spike puts a `beat` field on each Clock tick. A real engine probably wants a shared beat position instead (PR #12).
- **Text params.** A chord string, and presets that fill it, needed a second kind of param besides numeric knobs (PR #12).
- **Field writers.** Splat works best with a Write output feeding Fluid's Writers input, as the design kit draws it, not a Field input (PR #14).

Output
- **Flow's limiter overshoots.** Chrome's `DynamicsCompressorNode` adds automatic makeup gain, so the limiter reaches about 1.0–1.3 on hot input and the peak guard hard-clips. An offline render of four saws clipped 0.5 % of samples at 0.3 each and 2.4 % at full (PR #13). The demo patch, a piano at default levels, hit the guard in 18 polls over about 30 s.

Visuals
- **The CPU fluid costs about 8 ms a frame** at 35,000 cells, half the frame budget (PR #14, and above). It is also what pushes tap latency past the gate (above).
- **Syncing visuals to sound delays the tap's own splash.** The frame clock is shifted back by the output latency, so splashes land when notes are heard. That also delays a tap's own splash by the output latency, which could show on Bluetooth (PR #14).

Editor
- On a phone, the full patch only fits the graph pane at about 0.25 zoom, which is too small to edit. This supports [ADR 0014](decisions/0014-phones-play-view-only.md), Play view only on phones.

## Design changes this implies

Proposed. These go into [design.md](design.md) before M1 starts, after Chris has signed off on the measurements.

1. **Keep the main thread free during a frame (Timing, Technical architecture, Budgets).** Add a budget: no single main-thread task longer than about 4 ms while the patch plays, so a tap waits at most that long. For the fluid:
   - The GPU solver (ADR 0003) meets it.
   - M1's "Fluid on the CPU solver for now" doesn't, so M1 runs the CPU solver in a Worker and transfers the dye buffer each frame.
   - The CPU fallback on weak devices runs in a Worker too.
   - Add an M1 check: the immediate-path test runs with the Fluid stepping.
2. **Fix Output's limiter, don't copy it as is (Reuse from Flow, Effects and mix).** Change `output.js` in the Reuse table from "Copy as is" to "Adapt". Compensate for or disable the compressor's automatic makeup gain, or lower the threshold, and replace the hard-clip guard with a soft knee. Add an M1 check that a hot patch keeps guard clipping under a set fraction of samples.
3. **Live input and stateful nodes (Timing).** Say how a node fed by both scheduled and immediate events orders them, because immediate events arrive with times earlier than the scheduler's horizon. One option: stateful nodes keep their immediate-path state separately and merge the two by time.
4. **Transport (Core concepts, Time and rhythm).** Replace the per-tick beat count with a transport: a shared beat position that Clock writes and Progression and others read. Phase re-anchors at the change time, not at the window start.
5. **Port types and params (Core concepts).** Write down Value as a port type: sampled at event times, never scheduled. Write down text params with presets that fill them. Write down Field writers as a Write output into Fluid's Writers input.
6. **Splash timing (Visual system).** Decide whether a tap's own splash skips the output-latency shift, so it appears under the finger at once, while scheduled events stay synced to the sound.
