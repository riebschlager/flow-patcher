# 0028 · Recognizers chain on one phase-tagged stream; a claim is a Cancel on Pass

Status: Accepted · 2026-10-23

## Context
design.md ("Who owns a pointer") gives every recognizer a **Pass** output carrying the raw events it didn't claim. When it claims a channel, one Cancel goes to everything downstream of Pass. Chaining recognizers through Pass sets priority. That leaves two questions open for M2:
- **The shape of the events.** Pointer gives Down, Move, Up and Cancel on four ports. A recognizer needs all four, and Pass must forward all four.
- **How the Cancel travels.** The node could emit it, or the runtime could deliver it.

## Decision
**One tagged stream.**
- Every raw source that has phases (Pointer, Pointer (high rate), Pen, Key, Click, Wheel) gains an **All** output.
- All carries every event with a `phase` field: `down`, `move`, `up` or `cancel`. Wheel and Click events, which have no contact, are `move` and `down`.
- The per-phase ports stay, for patches that want one phase.

**Recognizer ports.**
- Every recognizer takes one **In** (Event) input.
- It offers **Pass**, which carries every unclaimed event in that tagged shape, so a chain is one cable per hop.
- It also offers **Pass Down**, **Pass Move**, **Pass Up** and **Pass Cancel**, so the end of a chain can feed nodes such as Splat directly.
- Its gesture outputs are separate.

**A claim.**
- A recognizer claims a channel when it is confident, for example when a pinch passes its threshold. At the claim's time it emits exactly one `cancel`-phase event for that channel on Pass (and Pass Cancel). It then passes nothing more from that channel until the channel ends with an `up` or `cancel` on In.
- A claim lasts until the channel ends and is never withdrawn. A recognizer that needs two channels, such as Pinch, claims both, and each gets its own Cancel.

**Claims are node logic.**
- A claim is decided inside `query()` from event times and per-channel state. That state is plain data and keyed by `channel`.
- So claims are window-independent and rewind and replay like any other query (ADR 0008, 0019). The runtime needs no claim machinery.

**Downstream nodes treat `cancel` like a pointercancel.**
- A cancel ends that channel's gesture without its usual end effect: no release note, no flick.
- A node that reads only Down or Move ignores it.

## Consequences
- Priority is just wiring. With Pinch → Circle → paint, pinch wins, circle comes next, and painting gets what's left. Modifier Router and Switch route the same tagged stream.
- Every recognizer test covers four things (docs/nodes/gesture-recognizers.md):
  - claim timing;
  - no Pass events from a claimed channel after the claim;
  - exactly one Cancel per claimed channel;
  - independent per-channel state.
- Events before the claim time have already flowed out of Pass, and some may have sounded. The Cancel is how downstream nodes undo or stop what those events started.
- Pointer's per-phase ports are unchanged, so M1 patches keep working. All is a new output, which bumps the node's version, and the example patches are updated (pre-M4 rule).
