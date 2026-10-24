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

## Rules for this family

- **Timing.** Input events are stamped `ctx.currentTime + 5 ms` and take the immediate path ([ADR 0008](../decisions/0008-one-clock-window-queries.md), [ADR 0017](../decisions/0017-immediate-offset-and-catch-up.md)).
- **The host delivers events.** The engine doesn't touch the DOM. It receives canvas events from the host ([ADR 0013](../decisions/0013-engine-editor-split.md)), and the DOM listener code lives outside `packages/engine`.
- **Platform rules the runtime handles:**
  - The canvas sets `touch-action: none` and takes pointer capture on down.
  - The context menu is suppressed only when a patch uses right-click.
  - The first pointerdown also unlocks the AudioContext and is still delivered, so it makes a sound. So does a keydown on the focused canvas (not a repeat, Escape, Tab or a lone modifier): a key press is a user gesture.
- **Focus.** In Play view the canvas has keyboard focus. In Patch view, keys go to the editor unless the preview canvas is focused. Escape always returns to the editor.
- **Keys.** The host pushes each keydown and keyup on the focused canvas as `{ key, code, repeat, shift, alt, ctrl, meta }`, with no `channel`: the code is the key's id. Escape is never sent. Key's events stay with the canvas (keydown doesn't reach the editor's shortcuts); keyup still bubbles, since React Flow tracks held keys from it. With a Key in the patch, keydown's page default is prevented, apart from Tab and Ctrl or Meta shortcuts. While audio isn't running, auto-repeats are dropped and the rest are held, like a pointerdown.
  - **Channels.** A key's channel is fixed by its `code`, not by press order, so live and replay agree: its place in Key's `KEY_CODES` list from 1 (KeyA–KeyZ 1–26, Digit0–Digit9 27–36, then punctuation, Space 51, editing keys, modifiers, navigation, F1–F24 and the numpad). The list is append-only. A code it doesn't list gets a hash of it in 1000–9999.
  - **Repeats** reach Down with `repeat: true` and never All, Note or Held. A keyup for a key that isn't down is dropped; a keydown (not a repeat) on a key already down ends it with an Up first. Down and Up carry `age`, seconds since the key's keydown.
  - **Lost keyups.** The canvas gets no keyup once it loses focus, and macOS sends none for keys released while Cmd is held. So the host sends a keyup for every key still down when the canvas blurs (before Canvas's Blur), and for every key but the modifiers when Meta comes up. They're recorded like any keyup.
  - **Held** reads 1 while a key named in Held keys (codes, separated by spaces or commas; default Space) is down. Channel 0 reads whether any of them is; a key's channel reads that key. Empty, every key counts.
  - **Keyboard → Note** plays the tracker's two-row piano, by code: Z S X D C V G B H N J M , L . ; / from the Octave knob's C (Octave 3: Z is C3, MIDI 48), and Q 2 W 3 E R 5 T 6 Y 7 U I 9 O 0 P [ = ] an octave up (Q is C4). Notes come at keydown, with the Velocity and Length knobs; repeats never retrigger, and a keyup ends nothing.
- **Canvas.** The host pushes the canvas's size as `resize` with `canvasWidth` and `canvasHeight` in CSS pixels, its keyboard focus as `focus` and `blur`, and the page's visibility as `visibilitychange` with `visibility` `'hidden'` or `'visible'` (`document.visibilityState`), all on channel 0. Canvas's Width and Height read the latest size in CSS pixels (0 before the first) and Aspect width / height (1 while either is 0); Focus, Blur, Hidden and Visible come at the pushes' times, without the payload.
  - **While audio is stopped** the four are dropped, not held: dragging the pane or tabbing about before the first tap would pile them up. The host keeps the canvas's state and, when audio starts, sends the size and any focus or visibility that differs from what the sources last got. So the first tap, which focuses the canvas, brings the size and a Focus.
  - **Changes only.** The host sends a focus, blur or visibility change only when it happens, so Canvas doesn't drop repeats; a stream that repeats one gets the event again.
  - **Hidden doesn't touch audio.** The AudioContext keeps running while the page is hidden (the scheduler only lengthens its lookahead); a patch that should fade or pause does it from Hidden and Visible.
  - **A Canvas added while playing** gets the size once its swap lands: a swap takes effect at a window boundary at or after now (ADR 0023), and a size pushed before that would reach a window the new node isn't in yet.
- **Permissions.** Sources that need permission (MIDI, later motion and mic) ask only when a patch containing them first plays. If denied, they show a blocked state on the node.
- **MIDI.** The host pushes each MIDI channel message as `{ type: 'midi', status, data1, data2 }`: the status byte and the data bytes as numbers, with no `channel` (so channel 0), so the MIDI channel is in `status`. Two-byte messages (program change, channel pressure) have no `data2`. The host drops system messages (sysex, clock, active sensing) and malformed bytes, so neither recordings nor the raw MIDI output carry them. MIDI events arriving while audio isn't running are dropped, not held: MIDI never starts audio. The raw MIDI output passes every channel message unchanged, whatever the Channel menu says. MIDI In decodes note-on, note-off and CC from it; velocity is 0–1 (data2 / 127), and a note-on with velocity 0 counts as a note-off. Notes carry their own duration ([ADR 0028](../decisions/0028-recognizers-pass-claim-cancel.md)), so MIDI In's Note comes at note-on with the Length knob's duration, and a note-off ends nothing; patches that need the off read Note Off. The CC signal holds the chosen controller's latest value (data2 / 127) per MIDI channel, and channel 0 reads the latest on any.
- **Recordings.** Every event a source emits must be replayable from an input stream ([ADR 0029](../decisions/0029-input-stream-format.md)), so recordings reproduce performances.
