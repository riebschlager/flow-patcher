# 0029 · Input streams record canvas events, and any patch can replay them

Status: Accepted · 2026-10-23

## Context
Replays need recorded input: M2's mode patches replay scripted input, and M4's performance recordings are the patch plus its input event streams (design.md "Performance recordings"). Today's `examples/<name>.inputs.json` lists pushes addressed to node ids and ports (`{ node, port, event }`). A file like that only replays through a patch with the same node ids, and it records what the patch did with the input, not what the player did.

## Decision
**One input stream file per recording,** `<name>.inputs.json`:

```json
{ "format": "flowinput", "version": 1,
  "events": [
    { "time": 0.4, "type": "pointerdown", "channel": 1, "x": 0.2, "y": 0.4, "pressure": 0.6, "pointerType": "touch" },
    { "time": 0.48, "type": "pointerup", "channel": 1, "x": 0.2, "y": 0.4, "pointerType": "touch" }
  ] }
```

**Fields.**
- `time` is in seconds from the stream's start, sorted ascending.
- `type` is the canvas event: `pointerdown`, `pointermove`, `pointerup`, `pointercancel`, `pointerenter`, `pointerleave`, `click`, `dblclick`, `auxclick`, `contextmenu`, `wheel`, `keydown`, `keyup`, `gesturechange`, `resize`, `focus`, `blur`, `visibilitychange` or `midi`.
- The other fields are the event payload (design.md "Event payload"): normalized `x`, `y` with y = 0 at the top, `channel`, `pressure`, modifiers, `key` and `code`, wheel deltas, and MIDI `status` and `data`.
- Fields a type doesn't use are left out.

**Coalesced samples.** Pointer (high rate)'s extra sub-frame samples are recorded as `pointermove` entries with `coalesced: true`. Pointer ignores them.

**Replay works as live input does.**
- Each event fans out to every source node that reads its `type`, stamped at the replay's start + `time`. The host does this live through `scheduler.push`; the headless runner pushes ahead of the first window.
- Node ids never appear in the stream, so one recording replays through any patch.
- Edits stay in `<name>.edits.json`, which is a separate script of patch changes.

**External sources.** MIDI is recorded in the same stream. Mic and motion are post-v1 and get their own types when they land.

## Consequences
- The same patch, seed and stream give the same events (ADR 0019). The mode patches' replay tests and M4's recordings rest on that.
- #72 replaces `loadInputs` and the `{ node, port, event }` files, and migrates the existing ones. The goldens must not change, because the events reach the same ports at the same times.
- A source node declares which `type`s it reads. The editor's live host and the headless runner share that mapping, so a stream can't replay differently from how it was played.
- Recordings stay small and patch-independent. Remixing a patch keeps its recordings playable whenever the new patch still has the sources.
