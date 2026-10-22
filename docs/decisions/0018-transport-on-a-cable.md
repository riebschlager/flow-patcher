# 0018 · The transport travels on a cable

Status: Accepted · 2026-10-21 · Amended by [0021](0021-transport-tempo-changes.md) (tempo, division and swing changes keep Phase continuous)

## Context
The M0 spike put a beat count on each Clock tick, and Phase jumped after a tempo change. [spike-notes.md](../spike-notes.md) (item 4) replaced the count with a transport: a beat position that Clock writes and Progression and other beat-counting nodes read. design.md's Timing section left open how readers reach it, and what zero or two Clocks mean.

## Decision
- Clock has a **Transport output**: a Value port that gives the beat position for any time it is queried at. It is an ordinary Value; there is no new port type and no patch-wide transport.
- Nodes that count beats have a **Transport input**: Progression now, Step Sequencer and Arpeggio later.
- Two Clocks are fine. Each reader follows the Clock on its own cable, so parts can run at independent tempos.
- With no Transport cable, a reader stays at beat 0 (Progression holds its first chord) and shows an inline "no transport" hint.
- When the tempo or division changes, the beat and Phase re-anchor at the change time and keep the old anchor for reads before it, so neither ever jumps.

Rejected:
- **Patch-wide transport.** A hidden dependency you can't see on the canvas, and no way to run two tempos.
- **A hybrid** (patch-wide by default, a cable overrides it). Two mechanisms to learn, and a cable silently overriding hidden behaviour.

## Consequences
- Every beat-counting reader needs a cable from a Clock; a new one dropped on the canvas does nothing until it is wired. A later convenience could have the palette auto-connect a new reader to the only Clock.
- The transport follows the Value rule: its source answers for any time it has already been queried up to, so readers give the same beats in 25 ms windows as in one call.
