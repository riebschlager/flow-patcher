# Canvas sources

Raw source nodes turn browser events on the performance canvas into events and signals. They don't interpret anything; [gesture recognizers](gesture-recognizers.md) sit on top. Design: "Canvas event sources".

| Node | Browser events | Outputs | Milestone |
| --- | --- | --- | --- |
| Pointer | pointerdown, pointermove, pointerup, pointercancel, pointerenter, pointerleave | Down, Move, Up, Cancel events per channel, and All: every event tagged with its `phase` ([ADR 0028](../decisions/0028-recognizers-pass-claim-cancel.md)); X, Y, Pressure, Speed signals per channel; Count of active pointers | M1 (basic), M2 (complete) |
| Pointer (high rate) | `getCoalescedEvents()` on pointermove (not `pointerrawupdate`, see Coalesced samples) | Every sub-frame move sample, for smooth strokes and fast flicks, with Pointer's Down, Up and Cancel; All | M2 |
| Click | click, dblclick, auxclick, contextmenu | Click, Double, Middle, Right events with position | M2 |
| Wheel | wheel (including macOS trackpad pinch, sent as wheel + ctrlKey) | DeltaX, DeltaY, Zoom events; accumulated X/Y/Zoom signals with a decay knob | M2 |
| Pen | Pointer events filtered to `pointerType: pen` | Tilt X/Y, Altitude, Azimuth, Twist, Tangential pressure, Barrel button; Down, Move, Up, Cancel and All like Pointer | M2 |
| Touch extras | Touch contact size; Safari `gesturechange` | Contact width/height; native Scale and Rotation (Safari only) | M2 |
| Key | keydown, keyup while the canvas has focus | Down/Up events with `key`, `code`, `repeat`, one channel per `code`; All (no repeats); a Held signal for each chosen key; a Keyboard → Note mode (two-row piano layout) | M2 |
| Canvas | resize, focus, blur, visibilitychange | Size signals and Focus/Blur/Hidden/Visible events, so patches can fade or pause cleanly | M2 |
| MIDI In | Web MIDI note and CC messages | Note at each note-on, with a **Length** knob for its duration; Note On and Note Off events with pitch and velocity; a CC signal for one CC number; all per MIDI channel (channel = MIDI channel + 1) and filtered by a **Channel** menu (All, 1–16); a raw MIDI output with every channel message, which the Channel menu doesn't filter | M2 ([ADR 0004](../decisions/0004-web-midi-in-v1.md)) |

Later, each behind a permission and not in v1: Gamepad (buttons and axes, polled each frame), Device motion and orientation, Microphone (level, onset, pitch).

## Event payload

Every input event carries these base fields, so any node can read them through Get Field.

| Field | Meaning |
| --- | --- |
| `time` | Audio-clock time the event is scheduled at |
| `channel` | Stable id for this pointer, touch or key for the life of the contact: for pointers, a slot (below) |
| `x`, `y` | Canvas position, normalized 0–1, with y = 0 at the top (the fluid's convention) |
| `dx`, `dy`, `speed`, `angle` | Motion since the previous sample for this channel, in canvas units per second |
| `pressure`, `width`, `height` | Contact force and size, where the hardware reports them (mouse: 0.5 while pressed) |
| `pointerType` | mouse, touch or pen |
| `button`, `buttons` | Which buttons changed, and which are held |
| `shift`, `alt`, `ctrl`, `meta` | Modifier keys held |
| `age` | Seconds since this channel's down event |
| `coalesced` | On a pointermove sample from `getCoalescedEvents()`: Pointer (high rate) reads these, Pointer the plain moves |
| `interval` | Seconds since this pointer's previous sample, from the browser's `timeStamp`s (left out on its first). Motion is measured over it |

`dx` and `dy` are velocity components; `angle` is atan2(dy, dx) in radians (0 to the right, π/2 down) and holds its last value while the pointer is still. A channel's first sample after it's taken has no motion, and `age` is 0 on a hover move.

**Coalesced samples.** A browser's coalesced list for a pointermove includes the dispatched move itself. So the host pushes every sample of the list as `pointermove` with `coalesced: true`, and then the plain move. Pointer (high rate) reads only the samples and Pointer only the plain moves, so neither sees a sample twice. The samples and the move go in one push, at one stamp (stamps can't go back before currentTime). Every pointer event the host sends (down, move, sample, up, cancel) carries `interval`, the seconds since that pointer's previous sample by the browser's clock, and motion is measured over it: stamps carry render quanta and handler delays (a late handler would squeeze two frames' samples together), so the nodes fall back to stamps only for events without one. The host takes samples from `getCoalescedEvents()` on pointermove in every browser, not from `pointerrawupdate`: rawupdate's samples come again in the next move's list, and a push per sample would cost a rewind each and collide on render-quantum stamps. Samples closer than 1 ms add up before motion is measured, so bursts can't make the speed spike. Each sample costs two events (Move and All), so in a 120 ms limit window that fills up the pointer sources stop emitting moves before the per-node cap and keep a reserve for Down, Up and Cancel. The patch-wide cap (2,048 events) counts every node, so in a busy patch it can still drop them.

**Pointer slots.** Pointer sources number contacts by slot, not by raw `pointerId`. A pointer takes the lowest free slot from 1 on its first event (pointerenter or a hover move included) and frees it on pointerup, pointercancel or pointerleave (a leave while down waits for the up). An up or cancel with no contact down for its pointer (pressed outside the canvas, then released inside) is dropped and takes no slot. At one time stamp, a pointer that lifts frees its slot before another pointer takes one. The map is node state, so live and replay give the same channels; input streams keep recording raw pointerIds. Channel 0 reads the most recent pointer. Past 16 slots, the pointer that changed least recently gives its slot up (a hover first), with a Cancel if it was down.

**Wheel.** The host pushes each wheel event once as `{ x, y, deltaX, deltaY, deltaMode, shift, alt, ctrl, meta }`, with the deltas and deltaMode as the browser reports them, and no channel. Wheel converts the deltas to CSS pixels (a line is 40 px, a page 800 px) and drops `deltaMode`. A wheel with Ctrl (a trackpad pinch in Chrome, Edge and Firefox, or Ctrl + wheel) goes to Zoom only, with `zoom` = −deltaY / 100, positive zooming in; the others go to DeltaX and DeltaY where that delta isn't 0. Scroll X, Scroll Y and Zoom level sum deltaX / 100, deltaY / 100 and `zoom`, so a Chrome mouse notch adds about 1, and decay toward 0 as e^(−Decay × seconds since the last wheel); Decay 0 holds them. While a patch reads wheel, the canvas keeps it from scrolling or zooming the page; wheels before audio starts are dropped.

## Rules for this family

- **Timing.** Input events are stamped `ctx.currentTime + 5 ms` and take the immediate path ([ADR 0008](../decisions/0008-one-clock-window-queries.md), [ADR 0017](../decisions/0017-immediate-offset-and-catch-up.md)).
- **The host delivers events.** The engine doesn't touch the DOM. It receives canvas events from the host ([ADR 0013](../decisions/0013-engine-editor-split.md)), and the DOM listener code lives outside `packages/engine`.
- **Platform rules the runtime handles:**
  - The canvas sets `touch-action: none` and takes pointer capture on down.
  - The context menu is suppressed only when a patch uses right-click.
  - The first pointerdown also unlocks the AudioContext and is still delivered, so it makes a sound.
- **Focus.** In Play view the canvas has keyboard focus. In Patch view, keys go to the editor unless the preview canvas is focused. Escape always returns to the editor.
- **Permissions.** Sources that need permission (MIDI, later motion and mic) ask only when a patch containing them first plays. If denied, they show a blocked state on the node.
- **MIDI.** The host pushes each MIDI channel message as `{ type: 'midi', status, data1, data2 }`: the status byte and the data bytes as numbers, with no `channel` (so channel 0), so the MIDI channel is in `status`. Two-byte messages (program change, channel pressure) have no `data2`. The host drops system messages (sysex, clock, active sensing) and malformed bytes, so neither recordings nor the raw MIDI output carry them. MIDI events arriving while audio isn't running are dropped, not held: MIDI never starts audio. The raw MIDI output passes every channel message unchanged, whatever the Channel menu says. MIDI In decodes note-on, note-off and CC from it; velocity is 0–1 (data2 / 127), and a note-on with velocity 0 counts as a note-off. Notes carry their own duration ([ADR 0028](../decisions/0028-recognizers-pass-claim-cancel.md)), so MIDI In's Note comes at note-on with the Length knob's duration, and a note-off ends nothing; patches that need the off read Note Off. The CC signal holds the chosen controller's latest value (data2 / 127) per MIDI channel, and channel 0 reads the latest on any.
- **Recordings.** Every event a source emits must be replayable from an input stream ([ADR 0029](../decisions/0029-input-stream-format.md)), so recordings reproduce performances.
