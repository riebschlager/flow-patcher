# 0020 · A tap's own splash skips the output-latency shift

Status: Accepted · 2026-10-21

## Context
The frame clock runs behind `currentTime` by the output latency, so a splash lands when its note is heard, not when it is rendered. For generated material that keeps sound and picture together. For a tap it means the splash waits for the sound too: over Bluetooth, 200 ms or more after the finger touched. [spike-notes.md](../spike-notes.md) (item 6) recorded this as an open question in design.md's Risks.

## Decision
- Immediate-path events reach visual nodes at once, without the output-latency shift, so a tap's splash appears under the finger.
- Scheduled events stay shifted, so generated splashes land with their sound.

## Consequences
- Over Bluetooth a tap's splash comes before its sound. The spike measured 264 ms of output latency over Bluetooth, against 16 ms on the phone's speaker, where the gap is too small to notice.
- Visual nodes need to know which path an event came from; the event carries that, and the frame loop reads immediate events by arrival rather than by shifted time.
- Only events at the tap's own time count as immediate. When a tap rewinds a stateful node ([ADR 0019](0019-live-events-rewind.md)), the events its re-run emits after t are scheduled events and stay shifted.
