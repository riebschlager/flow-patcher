# Canvas sources

Raw source nodes turn browser events on the performance canvas into events and signals. They don't interpret anything; [gesture recognizers](gesture-recognizers.md) sit on top. Design: "Canvas event sources".

| Node | Browser events | Outputs | Milestone |
| --- | --- | --- | --- |
| Pointer | pointerdown, pointermove, pointerup, pointercancel, pointerenter, pointerleave | Down, Move, Up, Cancel events per channel, and All: every event tagged with its `phase` ([ADR 0028](../decisions/0028-recognizers-pass-claim-cancel.md)); X, Y, Pressure, Speed signals per channel; Count of active pointers | M1 (basic), M2 (complete) |
| Pointer (high rate) | `getCoalescedEvents()`, `pointerrawupdate` where supported | Every sub-frame move sample, for smooth strokes and fast flicks | M2 |
| Click | click, dblclick, auxclick, contextmenu | Click, Double, Middle, Right events with position | M2 |
| Wheel | wheel (including macOS trackpad pinch, sent as wheel + ctrlKey) | DeltaX, DeltaY, Zoom events; accumulated X/Y/Zoom signals with a decay knob | M2 |
| Pen | Pointer events filtered to `pointerType: pen` | Tilt X/Y, Altitude, Azimuth, Twist, Tangential pressure, Barrel button | M2 |
| Touch extras | Touch contact size; Safari `gesturechange` | Contact width/height; native Scale and Rotation (Safari only) | M2 |
| Key | keydown, keyup while the canvas has focus | Down/Up events with `key`, `code`, `repeat`; a Held signal for each chosen key; a Keyboard → Note mode (two-row piano layout) | M2 |
| Canvas | resize, focus, blur, visibilitychange | Size signals and Focus/Blur/Hidden/Visible events, so patches can fade or pause cleanly | M2 |
| MIDI In | Web MIDI note and CC messages | Note events per MIDI channel; CC signals | M2 ([ADR 0004](../decisions/0004-web-midi-in-v1.md)) |

Later, each behind a permission and not in v1: Gamepad (buttons and axes, polled each frame), Device motion and orientation, Microphone (level, onset, pitch).

## Event payload

Every input event carries these base fields, so any node can read them through Get Field.

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

## Rules for this family

- **Timing.** Input events are stamped `ctx.currentTime + 5 ms` and take the immediate path ([ADR 0008](../decisions/0008-one-clock-window-queries.md), [ADR 0017](../decisions/0017-immediate-offset-and-catch-up.md)).
- **The host delivers events.** The engine doesn't touch the DOM. It receives canvas events from the host ([ADR 0013](../decisions/0013-engine-editor-split.md)), and the DOM listener code lives outside `packages/engine`.
- **Platform rules the runtime handles:**
  - The canvas sets `touch-action: none` and takes pointer capture on down.
  - The context menu is suppressed only when a patch uses right-click.
  - The first pointerdown also unlocks the AudioContext and is still delivered, so it makes a sound.
- **Focus.** In Play view the canvas has keyboard focus. In Patch view, keys go to the editor unless the preview canvas is focused. Escape always returns to the editor.
- **Permissions.** Sources that need permission (MIDI, later motion and mic) ask only when a patch containing them first plays. If denied, they show a blocked state on the node.
- **Recordings.** Every event a source emits must be replayable from an input stream (the JSON format defined in M2), so recordings reproduce performances.
