# 0029 · Input streams record canvas events, and any patch can replay them

Status: Accepted · 2026-10-23 · Amended 2026-10-24 (pointerleave and the hover-end marker, #101)

## Context
Replays need recorded input: M2's mode patches replay scripted input, and M4's performance recordings are the patch plus its input event streams (design.md "Performance recordings"). Today's `examples/<name>.inputs.json` lists pushes addressed to node ids and ports (`{ node, port, event }`). A file like that only replays through a patch with the same node ids, and it records what the patch did with the input, not what the player did.

## Decision

### One input stream file per recording: `<name>.inputs.json`

```json
{ "format": "flowinput", "version": 1,
  "events": [
    { "time": 0.4, "type": "pointerdown", "channel": 1, "x": 0.2, "y": 0.4, "pressure": 0.6, "pointerType": "touch" },
    { "time": 0.48, "type": "pointerup", "channel": 1, "x": 0.2, "y": 0.4, "pressure": 0, "pointerType": "touch" }
  ] }
```

- **`time`** is in seconds from the stream's start, sorted ascending.
- **`type`** is the canvas event: `pointerdown`, `pointermove`, `pointerup`, `pointercancel`, `pointerenter`, `pointerleave`, `click`, `dblclick`, `auxclick`, `contextmenu`, `wheel`, `keydown`, `keyup`, `gesturechange`, `resize`, `focus`, `blur`, `visibilitychange` or `midi`.
  - `pointerrawupdate` and coalesced samples are recorded as `pointermove` with `coalesced: true`. Pointer ignores those, and Pointer (high rate) reads them.
  - pointerdown, pointermove (coalesced samples included), pointerup and pointercancel also record `interval` (not pointerenter or pointerleave), the seconds since that pointer's previous sample by the browser's clock: one browser event's samples share a stamp, and stamps carry handler delays (#74). The live host doesn't listen to `pointerrawupdate` (docs/nodes/canvas-sources.md).
  - `pointerenter` only updates Pointer's hover state, and has no phase on All. `pointerleave` frees a hovering pointer's slot and puts a hover-end marker, `phase: 'leave'`, on All (ADR 0028, amended for #101); a leave while down emits nothing.

### Payload fields
- The other fields are what the source nodes read, under the names their outputs use. design.md "Event payload" gives the base fields. docs/nodes/canvas-sources.md is the per-source list: pen tilt and twist, `key`, `code` and `repeat`, wheel deltas, gesture scale and rotation, canvas size, visibility, and MIDI `status`, `data1` and `data2`, the message's bytes as numbers (the MIDI channel is in `status`; a midi event has no `channel`). Only channel messages are recorded: the host drops system messages (sysex, clock, active sensing). Two-byte messages (program change, channel pressure) have no `data2`.
- Fields a type doesn't use are left out.
- Derived fields (`dx`, `dy`, `speed`, `angle`, `age`) are not recorded. The source nodes compute them from the sequence, on replay as live.
- Streams record raw ids (`pointerId`). A source may rewrite its pushes (`InputSpec.rewrites`, #74), as Pointer maps pointerIds to slot channels and adds the derived fields, in node state, so replay and live give the same channels.
- Canvas size goes in `canvasWidth` and `canvasHeight`, so it can't be confused with a contact's `width` and `height`.

### What `time` means
- `time` is the time an event was applied: the stamp `scheduler.push` returned, which ADR 0026 may have moved to the horizon. It is not the moment the handler ran. Subtract the stream's start.
- A push that was dropped (its re-run threw, ADR 0026) is not recorded.
- A browser event that reaches several source nodes gets one stamp, shared by all of them. The host stamps it once and pushes it to each source at that time. The pushes don't each read the clock again.

### Replay works as live input does
- Each event fans out to every source node that reads its `type`, stamped at the replay's start + `time`.
- The headless runner pushes the events before the first window, as it does today. M2's replays are all headless.
- A replay inside the editor would need a timed push. It's added when Play view's recordings need it (M4).
- Node ids never appear in the stream, so one recording replays through any patch.
- Edits stay in `<name>.edits.json`, which is a separate script of patch changes.

### External sources
MIDI is recorded in the same stream. Mic and motion are post-v1 and get their own types when they land.

## Consequences
- The same patch, seed and stream give the same events (ADR 0019). The mode patches' replay tests and M4's recordings rest on that.
- #72 replaces `loadInputs` and the `{ node, port, event }` files and migrates the existing ones, copying every field verbatim (including `pressure: 0` on up). The goldens must not change, because the events reach the same ports at the same times.
- A source node declares which `type`s it reads. The editor's live host and the headless runner share that mapping, so a stream can't replay differently from how it was played.
- Recordings stay small and patch-independent. Remixing a patch keeps its recordings playable whenever the new patch still has the sources.
