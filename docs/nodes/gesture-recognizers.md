# Gesture recognizers

Recognizers consume raw [canvas source](canvas-sources.md) events and emit higher-level ones. They're ordinary nodes with knobs, so thresholds can be tuned or modulated. Design: "Gesture recognizers" and "Who owns a pointer". All land in M2.

| Node | Emits | Key knobs | Flow source |
| --- | --- | --- | --- |
| Drag | Start, Move, End with start point, delta, distance, duration; with Spacing above 0, Move only once the contact is Spacing from the last Start/Move (brush spacing: notes per distance, not per device move; replaces Flow's time-throttled `launch`). A jump past several Spacings gives one Move at the new point, not one per Spacing crossed; gaps are at least Spacing | Minimum distance, Spacing | `gestures.js` |
| Tap | Tap, Double tap, Long press | Max movement, max duration, long-press time | `gestures.js` |
| Hold | Charge signal rising while held still; Release with charge amount | Stillness radius, charge time | Flow's Gather (`gestures.js` / `performance.js`) |
| Flick | Flick on release above a speed, with direction and speed | Speed threshold | `gestures.js` |
| Circle | Orbit start, Angle signal (unwrapped), Revolutions, Direction, Orbit end | Minimum radius, closure tolerance | Flow's Orbit (`gestures.js` / `performance.js`) |
| Pinch | Pinch in, Spread, Scale and Rotation signals, midpoint | Pair selection, thresholds | `gestures.js` |
| Stroke | Per-stroke path length, curvature, average speed; Silk/Rush classification | Speed split point | `gestures.js` / `performance.js` |
| Dwell | Fires when a pointer hovers in one spot (mouse and pen only), including right after a click; never claims. A hover's leave (`phase: 'leave'` on All) drops the stay | Radius, time | New |
| Zone | Splits events by canvas region: grid cells, left/right or rings (a drawn mask waits for an editor drawing tool, #102). Zone 1–8 outputs plus Zones (every zone, with a `zone` field) | Shape, rows, columns, split, rings, center, radius, Outputs (All phases / Presses only) | New |
| Modifier Router | Routes each contact by button or modifier to Out 1–4, else Pass (defaults: right-drag or Shift → Out 1 = Conduct, Alt → Out 2 = Space, Pass = Paint) | Route 1–4: terms joined by `,` (or) and `+` (and) | New |

Flow's recognizers live inside a mode-based controller. Borrowing them means splitting that controller into separate recognizers, each with a Pass output.

## Pass, claim and Cancel

[ADR 0028](../decisions/0028-recognizers-pass-claim-cancel.md) has the full rules.

- Recognizers read one phase-tagged stream: a contact source's **All** output (Pointer, Pointer (high rate), Pen, Key), or another recognizer's Pass. Each event's `phase` is `down`, `move`, `up` or `cancel`, or `leave` when a hovering pointer leaves (not a contact phase: it goes out on Pass alone, and contact recognizers ignore it). The input is **In**.
- Every recognizer has two kinds of output: its gesture events, and **Pass**, which carries the raw events it didn't claim in the same tagged shape. **Pass Down**, **Pass Move**, **Pass Up** and **Pass Cancel** split it for nodes that want one phase.
- A recognizer **claims** a channel once it's confident, for example when a pinch passes its threshold. The claim is decided in `query()` from event times, so it rewinds and replays like any query.
- At the claim it emits exactly one `cancel` event for that channel on Pass, and that channel's events stop flowing out of Pass until it ends. Nodes downstream treat the cancel like a pointercancel.
- A claim decided by time alone (Tap's Long press, Hold reaching its Min charge) has no In event to replace. Its cancel goes out on Pass at that moment, repeating the contact's latest event.
- Every recognizer has a **Claim** toggle: on by default for Pinch, Drag, Hold and Circle, off for Tap, Flick and Stroke. Off, it still recognizes, but Pass carries everything ([ADR 0028](../decisions/0028-recognizers-pass-claim-cancel.md), amended 2026-10-24).
- Chaining recognizers through Pass sets priority. With Pinch → Circle → Paint, pinch wins, circle comes next, and painting gets what's left.
- Switch and Modifier Router keep each contact on the output it started on until it ends. Their routed outputs carry every phase in the tagged shape, so the mode patches put a recognizer after each routed output (Drag with Claim off gives one Start per drag, at the move that crosses its threshold; a recognizer's Pass Down gives one event per press).
- Zone instead follows the pointer, on purpose: a contact that crosses from zone A into zone B gets an `up` in A and a `down` in B at the crossing move's time and place, so every zone's stream stays well formed; leaving every zone works the same way into Pass. With Outputs set to Presses only, Zone 1–8 carry only downs (crossing downs included), so a slide across pads plays each pad.
- Test every recognizer for: claim timing (the cancel lands at the triggering event's time), no Pass events from a claimed channel after the claim, exactly one Cancel per claimed channel, and independent state for channels it hasn't paired.

## Flow's tool modes

Flow's Paint, Conduct, Space and Orbit are not nodes. They're example patches in `examples/modes/`, composed from these recognizers plus Switch and Modifier Router ([ADR 0006](../decisions/0006-tool-modes-composed.md)). If a mode is hard to build, improve a recognizer or add a general-purpose node.

Each mode is its own patch, read from Flow's `performance.js`. Flow picked Conduct with right-drag or Shift and Space with Alt; a patch that wants all four on one canvas puts Modifier Router in front, as its defaults already suggest. Conduct, Space and Orbit shape music that keeps playing in Flow, so each carries a quiet bed (Clock, Euclidean, Progression, Chord Tone into Sampled Voice). "Active" below is Pointer's Count clamped to 1 (Math, min with Constant 1). The shaping signals go through Smooth, mostly 0.12 s rising and 0.4–0.85 s falling like Flow's 0.12 s / 0.85 s blend; Orbit's pan uses 0.08 s both ways to keep up with the circling. Flow scaled every mode by its Amount knob, 65% by default, and the patches play at that default: the figures below already include it, and turning a cable's depth up gives Flow at 100%.

- **Paint**: Pointer All → Pinch → Hold → Flick → Drag (Claim off, Spacing 0.07), so a pinch wins, then a charged hold, then a flick, and painting gets what's left.
  - A press plays a Chord Tone picked by X, louder and longer lower down, and drops dye.
  - A stroke plays a note each Spacing of travel, through a Gate open while Pointer Speed is at least 0.04, so slow strokes (Flow's soft ribbon) play too, just sparser. Flow throttled by time instead (`launch`: 160 ms, or 300 − 230·energy ms). Spacing keeps it on the claim-aware stream, since Pointer's own signals don't know about claims.
  - Hold's Release, Pinch's Spread and Pinch's End (two fingers lifted after pinching in) bloom four chord tones around X. Hold's Charge, smoothed, raises the room (Reverb Mix, up to 0.585 more), lowers the level by up to 0.13 and turns a whirlpool. Flick plays a bright accent.
  - The filter follows Y while pressed, 16.7 kHz × 2^(−2.98·y): Flow's latch, 650 · 24^(1−y), blended with 18 kHz at 65%. It's open when nothing is down.
  - Changed from Flow:
    - The filter follows Y continuously. Flow latched it, only on vertical motion, and reset it to 18 kHz at each press.
    - Notes have no per-note pan by X or per-note tone (Flow's `noteExpression`), as Sampled Voice has neither.
    - Pinch In plays a low gathered tone, which Flow didn't. A pinch's charge doesn't raise the room as Hold's does.
    - A pinch's bloom centres on the first finger's X, not the midpoint. The flick accent has no outward offset or jet.
- **Conduct**: the pointer plays nothing. While pressed, the filter goes 18 kHz × 2^(−3.7·y), which is Flow's 350 · (18000/350)^(1−y) at 65%, so about 1.4 kHz at the bottom. Pan goes 0.65 · (x − 0.5), ±0.325. A Force pushes the fluid along the motion.
- **Space**: Reverb Mix rises to 0.65 with 1 − y and Delay Mix to 0.55 with x. Delay is synced to the Clock's Transport, Feedback 0.42. A whirlpool follows the pointer, spinning one way on the left half and the other on the right, as in Flow. Flow's room and echo were sends with the dry signal kept; Reverb and Delay here are equal-power inserts.
- **Orbit**: Circle (Claim on) gives the Angle for Orbit Rings and the spin for a twin whirlpool. The orbit amount, 0.5 + 0.5 · energy with energy = Pointer Speed / 1.5 clamped, scales Delay Mix (0.52), Reverb Mix (0.2) and Filter Q (0.4 + 0.39 · orbit). The filter stays open at 18 kHz, as in Flow.
  - Changed from Flow:
    - Pan is the circling X times the orbit amount. Flow used sin(heading), and a circling pointer's X swings the same way.
    - The rings tilt only once Circle has recognized an orbit (Angle is 0 before that). Flow tilted them on any Orbit press, from (x − 0.5) · 2π plus the heading.
