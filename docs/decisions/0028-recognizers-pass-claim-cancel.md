# 0028 · Recognizers chain on one phase-tagged stream; a claim is a Cancel on Pass

Status: Accepted · 2026-10-23 · Amended 2026-10-24 (timer claims, the Claim toggle, log order; the hover-end marker, #101; see the end)

## Context
design.md ("Who owns a pointer") gives every recognizer a **Pass** output carrying the raw events it didn't claim. When it claims a channel, a Cancel goes to everything downstream of Pass. Chaining recognizers through Pass sets priority. That leaves two questions open for M2:
- **The shape of the events.** Pointer gives Down, Move, Up and Cancel on four ports. A recognizer needs all four, and Pass must forward all four.
- **How the Cancel travels.** The node could emit it, or the runtime could deliver it.

## Decision

### One tagged stream
- The **contact sources** gain an **All** output: Pointer, Pointer (high rate), Pen and Key. A contact is one pointer or one held key, for the life of its channel.
- All carries every event with a `phase` field:
  - `down` opens a contact and `up` ends it. `cancel` ends it without its usual end effect.
  - `move` is anything in between.
  - A `move` on a channel with no open contact is a hover (a mouse or pen with no button down).
- Phases per source:
  - **Pointer (high rate)** emits every coalesced move sample, plus the same down, up and cancel as Pointer.
  - **Key** maps keydown to `down` and keyup to `up`. Auto-repeats stay off All, but appear on Key's Down port with `repeat: true`. Each key's channel is fixed by its `code`.
- The per-phase ports stay, for patches that want one phase.
- **Sources with no contact don't get All:** Click, Wheel, Touch extras, Canvas and MIDI In. Their events open nothing, so there's nothing to claim. Route them with Modifier Router or Switch, not through a recognizer's In.
- The host pushes each event on its per-phase port, as it does today. The node's `query()` copies its own pushed events (`ctx.pushed`) onto All with `phase` set, so All is ordinary node output. It rewinds and is logged like any other output.
- A source may rewrite its pushes (`InputSpec.rewrites`, #74): the runtime then doesn't pass them through, and `query()` returns its own versions on the per-phase ports and All, such as Pointer's with slot channels and derived fields, at the pushes' times.

### Recognizer ports
- Every recognizer takes one **In** (Event) input. It reads one contact source's stream: a source's All, or another recognizer's Pass. Channel ids are only unique within one source, so merging two sources' streams into one In is unsupported.
- **Pass** carries every unclaimed event in the same tagged shape, so a chain is one cable per hop. **Pass Down**, **Pass Move**, **Pass Up** and **Pass Cancel** split it for nodes that want one phase.
- Gesture outputs are separate ports.

### A claim
- A recognizer claims a channel when an In event makes it confident, for example the move that takes a pinch past its threshold.
- In place of that event, Pass emits exactly one `cancel` for the channel, at the same time. The triggering event itself is not passed.
- The cancel keeps the triggering event's place in order. Other channels' events at the same time stay in input order around it.
- Pass then forwards nothing from that channel until it ends with an `up` or `cancel` on In. The ending event isn't forwarded either.
- A claim lasts until the channel ends and is never withdrawn.
- A recognizer that needs two channels, such as Pinch, claims both at once. Each gets its own cancel.

### Claims are node logic
- A claim is decided inside `query()` from event times and node state.
- State is plain data. Per-contact state is keyed by `channel`. State that spans channels, such as Pinch's chosen pair, is allowed.
- So claims are window-independent and rewind and replay like any other query (ADR 0008, 0019). The runtime needs no claim machinery.

### Downstream: `cancel` acts like a pointercancel
- A node that holds a contact open from `down` to `up` treats `cancel` as the end of that contact, without its usual end effect. Drag, Hold, Circle and Stroke are examples: no Release, no Flick, no Orbit end.
- Notes in the M2 vocabulary carry their own length, so a swallowed `up` leaves nothing hanging. A future gate-style node must accept the cancel phase.

### Routing stays with the contact
- Switch and Modifier Router send each contact to the output it started on, until it ends. Changing Switch's index, or a modifier pressed mid-drag, affects only contacts that start afterwards.
- So no branch is ever left with a `down` and no `up`.

## Consequences
- Priority is just wiring. With Pinch → Circle → paint, pinch wins, circle comes next, and painting gets what's left.
- Every recognizer test covers four things (docs/nodes/gesture-recognizers.md):
  - claim timing: the cancel lands at the triggering event's time;
  - no Pass events from a claimed channel after the claim;
  - exactly one cancel per claimed channel;
  - independent state for channels the recognizer hasn't paired.
- Events before the claim time have already flowed out of Pass, and some may have sounded. The cancel is how downstream nodes stop what those events started.
- Adding All bumps those source nodes' versions, and their example patches are updated (pre-M4 rule).
  - Because All is logged, the goldens of examples that use those sources gain All's events.
  - That lands with #74, after #72. #72's migration of the input files must leave the goldens unchanged, so the two changes stay separate.

## Amendment · 2026-10-24
Building the recognizers (#78) settled three points the decision left open.

- **Timer claims.** Some claims are decided by time alone, with no In event to replace: Tap's Long press, and Hold reaching its Min charge.
  - The cancel goes out on Pass at the timer's time. It repeats the contact's latest event, with that time and phase `cancel`.
  - The timer is a pure function of event times and params, so it rewinds and replays like any query. A later up that rules it out withdraws it on rewind.
  - A timer due at an In event's exact time fires before that event.
- **The Claim toggle.** Every recognizer has a Claim toggle. Off, it recognizes and emits its gesture events, but never claims: Pass carries everything.
  - On by default for Pinch, Drag, Hold and Circle, where taking the contact is the point of the gesture.
  - Off by default for Tap, Flick and Stroke, which usually ride along with painting.
- **Log order.** The cancel keeps the triggering event's place in the recognizer's own output. The runtime's log orders same-time events by channel, so in the log a same-time cancel can sit before or after the other channels' events.

## Amendment · 2026-10-24 · The hover-end marker (#101)
All had no way to say a hover ended, so Dwell fired at the canvas edge after a still mouse left, and a later pointer reusing the slot inherited its stay.

- **`phase: 'leave'` on All.** Pointer and Pointer (high rate) emit an All event with `phase: 'leave'` when a pointer that isn't down leaves the canvas and gives its slot up (docs/nodes/canvas-sources.md, "Pointer slots"). A leave while down still emits nothing: the slot waits for its up or cancel, which ends the contact.
  - It carries the slot's channel and the slot's last position (x, y, pressure), no motion (dx, dy and speed 0, `angle` held) and `age` 0, with the pointerleave's other payload fields. The leave's own coordinates are left out: they're the edge, past the last sample.
  - A hovering pointer pushed out of its slot past 16 slots gets a leave too, as one that's down gets a cancel. Like that cancel, an eviction's leave carries the evicted pointer's last payload.
  - A pointer that emitted nothing since it took the slot (an enter, then a leave or an eviction) gets no leave. Nothing downstream saw it, and the slot's record still holds the previous holder's position and fields.
  - It isn't a contact phase. It opens and ends no contact, and it has no per-phase port on the source.
  - Like down, up and cancel it's never thinned by the event budget; it costs one event (All only). Pen gets the same marker when it lands.
- **Recognizers** forward it on **Pass** only, never on Pass Down, Move, Up or Cancel. Contact recognizers (Drag, Tap, Hold, Flick, Circle, Pinch, Stroke) ignore it: it reaches no gesture logic and changes no claim.
- **Switch, Modifier Router and Zone** route it as an event outside a contact, as they route a hover move: at its own time, by its own fields or position.
- **Dwell** drops the channel's pending stay on it, without firing.
- Nodes downstream must not treat `leave` as an end of contact: a contact ends only with `up` or `cancel`.
