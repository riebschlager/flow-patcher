# Gesture recognizers

Recognizers consume raw [canvas source](canvas-sources.md) events and emit higher-level ones. They're ordinary nodes with knobs, so thresholds can be tuned or modulated. Design: "Gesture recognizers" and "Who owns a pointer". All land in M2.

| Node | Emits | Key knobs | Flow source |
| --- | --- | --- | --- |
| Drag | Start, Move, End with start point, delta, distance, duration | Minimum distance | `gestures.js` |
| Tap | Tap, Double tap, Long press | Max movement, max duration, long-press time | `gestures.js` |
| Hold | Charge signal rising while held still; Release with charge amount | Stillness radius, charge time | Flow's Gather (`gestures.js` / `performance.js`) |
| Flick | Flick on release above a speed, with direction and speed | Speed threshold | `gestures.js` |
| Circle | Orbit start, Angle signal (unwrapped), Revolutions, Direction, Orbit end | Minimum radius, closure tolerance | Flow's Orbit (`gestures.js` / `performance.js`) |
| Pinch | Pinch in, Spread, Scale and Rotation signals, midpoint | Pair selection, thresholds | `gestures.js` |
| Stroke | Per-stroke path length, curvature, average speed; Silk/Rush classification | Speed split point | `gestures.js` / `performance.js` |
| Dwell | Fires when a pointer hovers in one spot (mouse and pen only) | Radius, time | New |
| Zone | Splits events by canvas region: grid cells, left/right, rings, or a drawn mask | Rows, columns, shape | New |
| Modifier Router | Routes events to different outputs by button or modifier (right-drag → output 2) | Mapping table | New |

Flow's recognizers live inside a mode-based controller. Borrowing them means splitting that controller into separate recognizers, each with a Pass output.

## Pass, claim and Cancel

[ADR 0028](../decisions/0028-recognizers-pass-claim-cancel.md) has the full rules.

- Recognizers read one phase-tagged stream: a contact source's **All** output (Pointer, Pointer (high rate), Pen, Key), or another recognizer's Pass. Each event's `phase` is `down`, `move`, `up` or `cancel`. The input is **In**.
- Every recognizer has two kinds of output: its gesture events, and **Pass**, which carries the raw events it didn't claim in the same tagged shape. **Pass Down**, **Pass Move**, **Pass Up** and **Pass Cancel** split it for nodes that want one phase.
- A recognizer **claims** a channel once it's confident, for example when a pinch passes its threshold. The claim is decided in `query()` from event times, so it rewinds and replays like any query.
- At the claim it emits exactly one `cancel` event for that channel on Pass, and that channel's events stop flowing out of Pass until it ends. Nodes downstream treat the cancel like a pointercancel.
- A claim decided by time alone (Tap's Long press, Hold reaching its Min charge) has no In event to replace. Its cancel goes out on Pass at that moment, repeating the contact's latest event.
- Every recognizer has a **Claim** toggle, on by default. Off, it still recognizes, but Pass carries everything.
- Chaining recognizers through Pass sets priority. With Pinch → Circle → Paint, pinch wins, circle comes next, and painting gets what's left.
- Switch and Modifier Router keep each contact on the output it started on until it ends.
- Test every recognizer for: claim timing (the cancel lands at the triggering event's time), no Pass events from a claimed channel after the claim, exactly one Cancel per claimed channel, and independent state for channels it hasn't paired.

## Flow's tool modes

Flow's Paint, Conduct, Space and Orbit are not nodes. They're example patches in `examples/modes/`, composed from these recognizers plus Switch and Modifier Router ([ADR 0006](../decisions/0006-tool-modes-composed.md)). If a mode is hard to build, improve a recognizer or add a general-purpose node.
