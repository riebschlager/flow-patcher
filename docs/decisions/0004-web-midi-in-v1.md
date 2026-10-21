# 0004 · Web MIDI in v1

Status: Accepted · 2026-10-21

## Decision
Web MIDI input (notes and CCs) ships in v1 as a source node, built in M2. Gamepad, device motion and microphone come later.

## Consequences
- Permission is asked only when a patch containing a MIDI node first plays. If it's denied, the node shows a blocked state and the rest of the patch keeps playing.
- MIDI comes from outside the canvas, so input recordings capture the MIDI stream too, with note capture as the fallback (M4).
