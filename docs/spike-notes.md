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
5. Rewire about 10 times while the beat plays, using cables that leave the beat sounding. For example, remove the Euclidean → coral Splat cable and drag it back, or move Progression's Chord cable between the two Chord Tones. Listen to the beat for a gap.
6. Leave the patch running for 10 s. Then open **Report** and copy the text into the table below. The text is selectable, because the LAN page has no clipboard API.

The fluid steps in a Worker by default. To compare it with M0's main-thread solver, open the page with `?fluid=main` and measure again. The report's fluid line names the path.

The report measures:
- **Tap-to-sound**: the note's scheduled time minus the pointerdown's time on the audio clock, for warm taps only. A cold tap includes the AudioContext starting up, so it is left out. Output latency comes on top and is reported separately.
- **Rewiring**: windows skipped from the start of a cable drag until 1 s after any cable is added or removed. Deleting a node counts as one cable edit when it had cables.
- **Fluid step**: the solver's step time per frame, as the mean and p95 over the last 600 steps, and the max since reset.

The audio clock moves in render quanta, and on some Android devices in output-buffer-sized steps, so a single tap can be off by a few ms. Medians are more reliable than single taps.

## Measurements

Gate: tap-to-sound ≤ 20 ms on every reference device, and no audible gap while rewiring.

| Device | Taps (n) | Tap-to-sound median / worst | Output latency | Rewires, windows skipped | Fluid step mean / p95 / max (grid) |
| --- | --- | --- | --- | --- | --- |
| Headless Chromium 156, Playwright on Chris's Mac (provisional, three runs) | 30 each | 15.5 / 20.2; 16.1 / 21.7; 10.5 / 20.4 ms | 216 ms (headless) | 20 + 20 edits, 0 skipped | 7.8 / 7.9 / 8.0 ms (149×233) |
| Desktop Chrome 156, MacBook (1496×851 @2x), fluid in a Worker | 54 | 11.6 / 14.8 ms | 216 ms (base 5.8 ms) | 16 edits, 0 skipped | 7.8 / 8.0 / 15.4 ms (157×222) |
| Desktop Chrome 156, MacBook (1496×851 @2x), fluid on the main thread | 50 | 17.2 / 27.4 ms | 216 ms (base 5.8 ms) | 14 edits, 0 skipped, no gap heard | 7.8 / 8.0 / 15.0 ms (157×222) |
| Android phone, Chrome 155 on Android 10 (411×782 @2.625x), fluid in a Worker | 81 | 17.0 / 23.0 ms | 264 ms (base 2.7 ms) | 12 edits, 0 skipped | 6.1 / 7.7 / 10.8 ms (149×107) |
| Surface tablet, Chrome 155 on Windows (1368×777 @2x), fluid in a Worker, run 1 | 56 | 13.0 / 24.8 ms | 48 ms (base 10.0 ms) | 14 edits, 3 skipped (8 overall) | 14.5 / 22.7 / 31.5 ms (157×222) |
| Surface tablet, run 2 | 52 | 11.8 / 19.9 ms | 48 ms (base 10.0 ms) | 11 edits, 1 skipped (7 overall) | 16.2 / 25.6 / 29.7 ms (157×222) |
| Surface tablet, run 3 | 92 | 11.7 / 24.9 ms | 48 ms (base 10.0 ms) | 15 edits, 2 skipped (4 overall) | 12.3 / 18.5 / 31.0 ms (157×222) |

**The Surface misses both checks, even with the fluid in a Worker.** Its worst tap is 24.8 ms, and 3 windows were skipped while rewiring (8 overall). In runs 1–3 a skip needed the main thread blocked for more than about 120 ms, the lookahead. With the catch-up below, it now takes about 220 ms. The fluid step is slow there, 14.5 ms mean and 22.7 ms p95, but it runs in the worker. Run 2 added main-thread diagnostics:
- **No frames over 50 ms**, yet 7 windows were skipped. So the skips may not be the main thread at all. They could be the audio clock jumping forward, for example after an audio-device underrun. The report now records, for each skip, how far the wall clock and the audio clock moved since the previous wake. A 500 ms Stall reads 521/522 ms, both moving together.
- **Run 3 shows the skips are late timers, not audio clock jumps.** Each of the 4 skips moved the wall and audio clocks alike, by 131–149 ms, and there were still no frames over 50 ms. So nothing ran long. The 25 ms wake timer waited behind many short tasks (frames, input, fluid messages), or was throttled, until it was about 20 ms past the 120 ms lookahead. Each such wake drops one window's events: the scheduler skips them rather than playing them late, so a beat can go missing without any stall. Two implications:
  - The lookahead needs margin over the slowest reference device's timer jitter.
  - A small overrun should play late rather than drop. Skipping is meant for real stalls. The spike now does this: a wake up to 100 ms past the horizon queries what it missed. Those events play late, with the whole missed stretch moved to start now so they keep their spacing rather than stacking on one instant. The report counts these as "late wakes" and their events separately from `late`. At 240 BPM ÷ 8 with every step a hit, four 170 ms blocks were caught up with no two notes on the same instant. The moved stretch does overlap the on-time notes after it, so a late note can land as close as about 1 ms to one: a flam, only on a late wake. The real engine should choose deliberately between flams, dropping, and a longer lookahead. Headless, 170 ms blocks are caught up, overrunning by up to 72 ms, and 250 ms blocks still skip.
- **The Renderer takes 6.4–7.0 ms mean and 10.1–11.2 ms p95 on the main thread**, against 2.2 ms on the Mac. It's the largest main-thread cost left, and why the worst tap (19.9 ms) sits at the gate. Colorizing is most of it, so it now runs in the worker as well. Headless, main-thread render fell from 2.1 ms to under 0.2 ms, and the worst tap from 20.4 to 10.7 ms. Colorizing costs the worker about 3 ms per step on the Mac.

**The Android phone misses the tap gate with no long frames** (17.0 ms median, 23.0 ms worst, 0 frames over 50 ms). What the gate measures is the immediate path's fixed 10 ms offset plus the time from the touch's own timestamp to our handler. On the phone that second part is about 7 ms median and 13 ms worst. Nothing of ours blocks the thread, so it's Android's input pipeline. Two consequences:
- The offset is the only part of the measurement we control. `?offset=<ms>` sets it, and the report shows it. Headless, 5 ms gives a 5.3 ms median and 0 ms gives 0.3 ms: the measurement moves one for one.
- The spike can't show whether a smaller offset is safe. The `late` counter compares a note's time with `currentTime`, which doesn't move within one event handler, so the counter stays 0 even at offset 0. Too small an offset shows up as uneven timing between taps, which has to be judged by ear.

The phone also reports 264 ms output latency (Chris's Mac Chrome: 216 ms; the Surface: 48 ms). That is on top of every tap and is far larger than anything the gate measures.

The headless row is a stand-in until Chris fills in the reference devices. Headless output latency doesn't reflect real hardware.

**The full patch fails the tap gate on the worst case**: 20.2–21.7 ms in headless Chromium, and 27.4 ms in desktop Chrome, against ≤ 20 ms. Every median passes; desktop Chrome's is 17.2 ms. Medians vary from run to run (10.5–16.1 ms), so read the worst case and the median together.

### Tap latency and the fluid

In one session on the same headless browser, 30 taps each:

| Patch | Median | Worst |
| --- | --- | --- |
| Pointer → Chord Tone → Sampled Voice → Output | 10.6 ms | 14.1 ms |
| The same, plus Fluid → Renderer (the Fluid steps; no Splats) | 10.5 ms | 19.3 ms |
| Full demo patch (adds the Clock path, Progression and two Splats) | 10.5 ms | 20.4 ms |

The immediate path itself adds 10 ms by design. The rest is how long the pointerdown waited before its handler ran. Adding only the Fluid and Renderer raised the worst case by about 5 ms. A tap that arrives during a frame waits for that frame's solver step (about 8 ms) and render (about 1 ms) to finish. The rest of the demo patch added about 1 ms more. So the immediate path is fast enough on its own. With a CPU fluid on the main thread, the worst case reaches the gate.

### The fluid in a Worker

To test that, the spike's Fluid now steps Flow's CPU solver in a Worker:
- Each frame, the main thread posts the grid, the knobs and the splats due.
- The worker steps and hands the dye back in transferred buffers.
- The worker also colors the dye with Flow's colorizer, and hands back RGBA pixels in a transferred buffer.
- The Renderer only puts those pixels and scales them onto the canvas, so visuals run at least one frame behind the main-thread solver, and more when a step takes longer than a frame.
- `?fluid=main` keeps the old path.

Full demo patch, headless Chromium, 40 taps per run, two runs each, alternating:

| Fluid on | Tap median | Tap worst | Fluid step mean / p95 | Render avg (main thread) |
| --- | --- | --- | --- | --- |
| Worker | 10.3, 10.3 ms | **12.6, 12.5 ms** | 8.1 / 9.6, 7.8 / 8.0 ms | 2.3 ms |
| Main thread | 10.4, 10.4 ms | 20.6, 20.5 ms | 7.7 / 7.9 ms | 2.2 ms |

The step costs about the same in both places. Off the main thread it no longer delays taps, and the worst case falls back to what Pointer → Chord Tone → Voice → Output alone measures. The main thread keeps only the Renderer's ~2 ms draw. Desktop Chrome confirms it. With the fluid in a Worker, the worst tap fell from 27.4 to 14.8 ms and the median from 17.2 to 11.6 ms (the two desktop rows above).

## What felt fun, and what didn't

*Chris, after a session with the demo patch on each device.*

- Fun:
- Not fun:
- Rewiring live:
- Taps on each device:
  - Android phone: immediate through the phone's speaker. Over Bluetooth the delay is visible and audible.

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
- **The CPU fluid costs about 8 ms a frame** at 35,000 cells, half the frame budget (PR #14, and above). It is also the main reason the worst-case tap reaches the gate (above).
- **Syncing visuals to sound delays the tap's own splash.** The frame clock is shifted back by the output latency, so splashes land when notes are heard. That also delays a tap's own splash by the output latency, which could show on Bluetooth (PR #14).

Editor
- On a phone, the full patch only fits the graph pane at about 0.25 zoom, which is too small to edit. This supports [ADR 0014](decisions/0014-phones-play-view-only.md), Play view only on phones.

## Design changes this implies

Proposed. These go into [design.md](design.md) before M1 starts, after Chris has signed off on the measurements.

1. **Keep the main thread free during a frame (Timing, Technical architecture, Budgets).** Add a budget: no single main-thread task longer than about 4 ms while the patch plays, so a tap waits at most that long. For the fluid:
   - The GPU solver (ADR 0003) meets it.
   - M1's "Fluid on the CPU solver for now" doesn't, so M1 runs the CPU solver in a Worker and transfers the dye buffers each frame. The spike shows this works: the worst tap drops from about 20.5 to about 12.5 ms (above).
   - The CPU fallback on weak devices runs in a Worker too.
   - Add an M1 check: the immediate-path test runs with the Fluid stepping.
2. **Fix Output's limiter, don't copy it as is (Reuse from Flow, Effects and mix).** Change `output.js` in the Reuse table from "Copy as is" to "Adapt". Compensate for or disable the compressor's automatic makeup gain, or lower the threshold, and replace the hard-clip guard with a soft knee. Add an M1 check that a hot patch keeps guard clipping under a set fraction of samples.
3. **Live input and stateful nodes (Timing).** Say how a node fed by both scheduled and immediate events orders them, because immediate events arrive with times earlier than the scheduler's horizon. One option: stateful nodes keep their immediate-path state separately and merge the two by time.
4. **Transport (Core concepts, Time and rhythm).** Replace the per-tick beat count with a transport: a shared beat position that Clock writes and Progression and others read. Phase re-anchors at the change time, not at the window start.
5. **Port types and params (Core concepts).** Write down Value as a port type: sampled at event times, never scheduled. Write down text params with presets that fill them. Write down Field writers as a Write output into Fluid's Writers input.
6. **Splash timing (Visual system).** Decide whether a tap's own splash skips the output-latency shift, so it appears under the finger at once, while scheduled events stay synced to the sound.
